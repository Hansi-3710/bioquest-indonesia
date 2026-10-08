# Security overview

## What is protected, and how

| Area | Measure |
|---|---|
| Passwords | scrypt, with a server-side pepper (HMAC) applied first; 12+ characters, blocklist, no username/email inside |
| Login | Generic error messages, constant-time check for unknown emails, 10 attempts / 10 min per IP, account lock for 15 min after 5 failures |
| Researcher accounts | Cannot self-register (created with `manage.py`), **mandatory TOTP 2FA**, one-time codes cannot be replayed, 20-minute idle timeout |
| Sessions | Random id stored only as a hash in the database (revocable), rotated on login/2FA, idle + absolute expiry, `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production |
| CSRF | Per-session token on every POST plus an Origin check |
| Roles | Contributors cannot reach `/research/*`; researchers cannot use the contributor app; media is served only to its owner or a researcher |
| Database fields | Email (plus a blind index for lookup), exact location, notes and 2FA secrets are AES-256-GCM encrypted; the row id is bound in as authenticated data so ciphertext cannot be moved between rows |
| Uploads | Type decided by file content (never name/MIME), size limits, photos re-encoded (strips GPS/EXIF and hidden payloads), AES-256-GCM with a fresh key per file wrapped by the master key, stored outside the web root as random names, mode 600, served through an authenticated route with `sandbox` CSP |
| Privacy | Contributors are pseudonyms to researchers; protected-species locations are blurred for other users; training use needs explicit consent; users can download or delete all their data |
| Audit | Logins, reviews, exports and deletions are logged in a hash-chained table; `manage.py verify-audit` detects edits. IP addresses are stored only as keyed hashes |
| Browser | Strict CSP (no inline scripts/styles, no `unsafe-eval`), HSTS, `nosniff`, frame denial, Permissions-Policy (camera/geolocation only for this site), `no-store` caching |
| Injection / XSS | Parameterised SQL everywhere, Jinja auto-escaping, DOM built with `textContent`, CSV export neutralises formula injection |

## Before you go live

1. Serve over HTTPS only and set `BIOQUEST_ENV=production`, `TRUSTED_PROXIES` to match your proxy chain.
2. Provide `SECRET_KEY` and `MASTER_KEY` through your host's secret store; **back up `MASTER_KEY`** (losing it loses all data).
3. Put `BIOQUEST_DATA_DIR` on an encrypted disk with regular backups (back up database and uploads together).
4. Run `scripts/vendor_leaflet.sh`, and review the tile provider you use.
5. Keep dependencies patched (`pip-audit` runs in CI). Consider pinning hashes with `pip-compile --generate-hashes`.
6. Decide a retention policy and a privacy notice. Many contributors may be minors: check Indonesian law (UU PDP) and your school/organisation rules about consent.

## Known limits (be honest with yourself)

* SQLite is a single file: fine for a pilot. For many concurrent users move to PostgreSQL (same schema, use `psycopg`) and keep the field-level encryption.
* The database file itself is not encrypted; sensitive columns and all media are. Use full-disk encryption too.
* Videos are stored as received (they are not re-encoded), so embedded video metadata is not stripped.
* Rate limits are per server (kept in the database); put a reverse proxy / WAF in front for volumetric abuse.
* No email verification or password-reset email yet (needs an email service). Researchers recover access through an administrator (`manage.py reset-2fa`).
* A master-key rotation tool is not included.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository.
