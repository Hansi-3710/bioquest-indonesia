"""SQLite access layer: one connection per request, foreign keys on, secure delete on."""
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_bidx TEXT NOT NULL UNIQUE,          -- HMAC blind index (lookup only)
  email_enc BLOB NOT NULL,                  -- AES-GCM encrypted address
  pw_hash TEXT NOT NULL,                    -- scrypt(HMAC(pepper, password))
  role TEXT NOT NULL CHECK(role IN ('user','researcher')),
  totp_enc BLOB, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  leaderboard_optin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  sid_hash TEXT PRIMARY KEY,                -- only a hash of the session id is stored
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0, ua_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS species(
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  common_name TEXT NOT NULL, scientific_name TEXT NOT NULL,
  status TEXT NOT NULL, status_text TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,     -- 1 = exact location hidden from other users
  description TEXT, habitat TEXT, why_it_matters TEXT
);
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id INTEGER REFERENCES species(id),         -- what the contributor said
  final_species_id INTEGER REFERENCES species(id),   -- what a researcher confirmed
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
  loc_enc BLOB NOT NULL,                              -- encrypted {lat,lng}
  notes_enc BLOB,
  consent_research INTEGER NOT NULL DEFAULT 0,        -- may be used for model training
  created_at INTEGER NOT NULL,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obs_user ON observations(user_id);
CREATE INDEX IF NOT EXISTS idx_obs_status ON observations(status, created_at);
CREATE TABLE IF NOT EXISTS media(
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,                     -- also the on-disk file name
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                               -- of the stored plaintext (integrity)
  wrapped_dek BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_obs ON media(observation_id);
CREATE TABLE IF NOT EXISTS audit_log(                 -- tamper-evident hash chain
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor_id INTEGER, action TEXT NOT NULL,
  target TEXT, detail TEXT, ip_hash TEXT, prev_mac TEXT NOT NULL, mac TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_hits(key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_hits(key, ts);
"""


def now():
    return int(time.time())


def _connect(path):
    con = sqlite3.connect(path, timeout=10, isolation_level=None)  # autocommit; use tx() for groups
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA secure_delete=ON")
    con.execute("PRAGMA busy_timeout=8000")
    return con


def get_db():
    if "db" not in g:
        g.db = _connect(current_app.config["DB_PATH"])
    return g.db


def close_db(_exc=None):
    con = g.pop("db", None)
    if con is not None:
        con.close()


@contextmanager
def tx(con):
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def init_db(app):
    data = Path(app.config["DATA_DIR"])
    uploads = Path(app.config["UPLOAD_DIR"])
    for d in (data, uploads):
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
    con = _connect(app.config["DB_PATH"])
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    from .species_seed import SPECIES
    if con.execute("SELECT COUNT(*) FROM species").fetchone()[0] == 0:
        con.executemany(
            "INSERT INTO species(slug,common_name,scientific_name,status,status_text,sensitive,"
            "description,habitat,why_it_matters) VALUES(?,?,?,?,?,?,?,?,?)",
            [(s["slug"], s["name"], s["sci"], s["status"], s["status_text"],
              1 if s["status"] in ("NT", "VU", "EN") else 0, s["about"], s["habitat"], s["why"])
             for s in SPECIES])
    con.close()
    for f in Path(app.config["DATA_DIR"]).glob("bioquest.db*"):
        os.chmod(f, 0o600)
