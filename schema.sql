CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, name varchar(80) NOT NULL,
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','researcher')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS observations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 media_key text NOT NULL UNIQUE, media_type text NOT NULL, media_size integer NOT NULL,
 species varchar(120) NOT NULL DEFAULT '', notes varchar(2000) NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','pending','verified','rejected')),
 reviewer_id uuid REFERENCES users(id), reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observations_user_idx ON observations(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS observations_status_idx ON observations(status,created_at DESC);
CREATE TABLE IF NOT EXISTS login_attempts (id bigserial PRIMARY KEY, ip_hash text NOT NULL, email text NOT NULL, success boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS login_attempts_time_idx ON login_attempts(created_at);
CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
