-- BioQuest Indonesia database schema.
-- Run by `npm run migrate` as the OWNER role. The running app uses a separate,
-- low-privilege role (bioquest_app) that is subject to Row-Level Security.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('user', 'researcher');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE obs_status AS ENUM ('pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- users
-- Email is never stored in plaintext: email_enc is AES-256-GCM ciphertext,
-- email_hash is a keyed HMAC used only for lookups / uniqueness.
CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_enc        bytea       NOT NULL,
  email_hash       bytea       NOT NULL UNIQUE,
  display_name     text        NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 30),
  community        text        NOT NULL DEFAULT 'My Community' CHECK (char_length(community) <= 60),
  password_hash    text        NOT NULL,
  role             user_role   NOT NULL DEFAULT 'user',
  mfa_secret_enc   bytea,
  mfa_enabled      boolean     NOT NULL DEFAULT false,
  mfa_last_step    bigint      NOT NULL DEFAULT 0,        -- blocks TOTP replay
  consent_research boolean     NOT NULL DEFAULT false,    -- may uploads train models?
  consent_at       timestamptz,
  failed_logins    integer     NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  disabled         boolean     NOT NULL DEFAULT false,
  onboarded        boolean     NOT NULL DEFAULT false,
  points           integer     NOT NULL DEFAULT 0,
  species_found    integer     NOT NULL DEFAULT 0,
  observation_count integer    NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz
);

-- ------------------------------------------------------------- sessions
-- Only the SHA-256 of the session token is stored; a database leak cannot
-- be replayed as a login.
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea       NOT NULL UNIQUE,
  csrf_hash    bytea       NOT NULL,
  mfa_passed   boolean     NOT NULL DEFAULT false,
  ip_hash      bytea,
  ua_hash      bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- -------------------------------------------------------------- species
CREATE TABLE IF NOT EXISTS species (
  id              serial PRIMARY KEY,
  slug            text UNIQUE NOT NULL,
  common_name     text NOT NULL,
  scientific_name text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('insect','tree','flower','bird','amphibian','reptile','mammal','other')),
  iucn_code       text NOT NULL CHECK (iucn_code IN ('LC','NT','VU','EN','CR','NE')),
  status_label    text NOT NULL,
  description     text NOT NULL,
  habitat         text NOT NULL,
  why_it_matters  text NOT NULL,
  color_a         text NOT NULL,
  color_b         text NOT NULL,
  sensitive       boolean NOT NULL DEFAULT false  -- true => locations are blurred coarsely
);

-- --------------------------------------------------------- observations
-- Exact GPS is encrypted. Only a coarse grid cell is stored in clear (used
-- for maps and statistics); sensitive species get a much coarser cell.
CREATE TABLE IF NOT EXISTS observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id       integer     REFERENCES species(id),     -- confirmed / expert species
  ai_species_id    integer     REFERENCES species(id),
  ai_confidence    real        CHECK (ai_confidence BETWEEN 0 AND 1),
  ai_model_id      uuid,
  user_choice      text        NOT NULL DEFAULT 'none' CHECK (user_choice IN ('none','accepted_ai','manual','unsure')),
  status           obs_status  NOT NULL DEFAULT 'pending',
  reviewed_by      uuid        REFERENCES users(id),
  reviewed_at      timestamptz,
  notes_enc        bytea,
  place_label      text,
  geo_enc          bytea,                  -- encrypted {"lat":..,"lon":..}
  cell_lat         real,                   -- coarse grid cell centre
  cell_lon         real,
  consent_research boolean     NOT NULL DEFAULT false,
  points_awarded   integer     NOT NULL DEFAULT 0,
  is_first         boolean     NOT NULL DEFAULT false,   -- first time this user found this species
  observed_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS obs_user_idx   ON observations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS obs_status_idx ON observations(status, created_at);
CREATE INDEX IF NOT EXISTS obs_species_idx ON observations(species_id) WHERE status = 'verified';

-- ---------------------------------------------------------------- media
-- Every file is encrypted with its own random data key (DEK); the DEK is
-- wrapped by the master key (KEK) and stored here. Ciphertext lives on disk
-- under an unguessable random name, never inside the web root.
CREATE TABLE IF NOT EXISTS media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid        NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  owner_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text        NOT NULL CHECK (kind IN ('image','video')),
  mime           text        NOT NULL,
  bytes          bigint      NOT NULL,
  plain_sha256   bytea       NOT NULL,
  storage_key    text        NOT NULL UNIQUE,
  thumb_key      text        UNIQUE,
  dek_wrapped    bytea       NOT NULL,
  thumb_dek_wrapped bytea,
  kek_version    integer     NOT NULL,
  iv             bytea       NOT NULL,
  auth_tag       bytea       NOT NULL,
  thumb_iv       bytea,
  thumb_tag      bytea,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_obs_idx ON media(observation_id);
CREATE INDEX IF NOT EXISTS media_owner_idx ON media(owner_id);

-- --------------------------------------------------- challenge rewards
CREATE TABLE IF NOT EXISTS challenge_claims (
  user_id      uuid     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start   date     NOT NULL,
  challenge_id smallint NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_start, challenge_id)
);

-- ------------------------------------------------------ ML: jobs/models
CREATE TABLE IF NOT EXISTS models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     integer     GENERATED ALWAYS AS IDENTITY,
  arch        text        NOT NULL,
  onnx_path   text        NOT NULL,
  labels      jsonb       NOT NULL,           -- ordered list of species slugs
  metrics     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sha256      text        NOT NULL,
  active      boolean     NOT NULL DEFAULT false,
  created_by  uuid        REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS models_one_active ON models(active) WHERE active;

CREATE TABLE IF NOT EXISTS training_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  uuid        NOT NULL REFERENCES users(id),
  status        job_status  NOT NULL DEFAULT 'queued',
  params        jsonb       NOT NULL,
  progress      real        NOT NULL DEFAULT 0,
  metrics       jsonb,
  log_tail      text        NOT NULL DEFAULT '',
  model_id      uuid        REFERENCES models(id),
  dataset_size  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- ---------------------------------------------------------------- audit
-- Append-only and hash-chained: each row commits to the previous row's hash,
-- so edits or deletions are detectable (npm run audit:verify).
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  action     text        NOT NULL,
  target     text,
  ip_hash    bytea,
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  bytea       NOT NULL,
  row_hash   bytea       NOT NULL
);

-- ------------------------------------------------- roles & permissions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bioquest_app') THEN
    CREATE ROLE bioquest_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bioquest_worker') THEN
    CREATE ROLE bioquest_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, observations, media, training_jobs, challenge_claims TO bioquest_app;
GRANT SELECT, INSERT, UPDATE ON models TO bioquest_app;
GRANT SELECT ON species TO bioquest_app;
GRANT SELECT, INSERT ON audit_log TO bioquest_app;        -- no UPDATE / DELETE
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bioquest_app;

-- The training worker can only see what it needs: queued jobs, the species
-- list, and media of verified + consented observations. It never sees users.
GRANT SELECT, UPDATE ON training_jobs TO bioquest_worker;
GRANT SELECT, INSERT ON models TO bioquest_worker;
GRANT SELECT ON species TO bioquest_worker;
GRANT SELECT ON media, observations TO bioquest_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bioquest_worker;

-- ---------------------------------------------------------- row security
-- The API sets app.user_id / app.role inside each transaction. Even if a
-- route forgets an ownership check, the database refuses to return rows.
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations FORCE ROW LEVEL SECURITY;
ALTER TABLE media        ENABLE ROW LEVEL SECURITY;
ALTER TABLE media        FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'anon') $$;

DROP POLICY IF EXISTS obs_owner      ON observations;
DROP POLICY IF EXISTS obs_researcher ON observations;
DROP POLICY IF EXISTS obs_worker     ON observations;
CREATE POLICY obs_owner ON observations FOR ALL TO bioquest_app
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
-- Researchers only ever see observations whose owners opted in to research use.
CREATE POLICY obs_researcher ON observations FOR ALL TO bioquest_app
  USING (app_role() = 'researcher' AND consent_research)
  WITH CHECK (app_role() = 'researcher' AND consent_research);
CREATE POLICY obs_worker ON observations FOR SELECT TO bioquest_worker
  USING (status = 'verified' AND consent_research);

DROP POLICY IF EXISTS media_owner      ON media;
DROP POLICY IF EXISTS media_researcher ON media;
DROP POLICY IF EXISTS media_worker     ON media;
CREATE POLICY media_owner ON media FOR ALL TO bioquest_app
  USING (owner_id = app_uid()) WITH CHECK (owner_id = app_uid());
CREATE POLICY media_researcher ON media FOR SELECT TO bioquest_app
  USING (app_role() = 'researcher'
         AND EXISTS (SELECT 1 FROM observations o WHERE o.id = observation_id AND o.consent_research));
CREATE POLICY media_worker ON media FOR SELECT TO bioquest_worker
  USING (EXISTS (SELECT 1 FROM observations o
                 WHERE o.id = observation_id AND o.status = 'verified' AND o.consent_research));
