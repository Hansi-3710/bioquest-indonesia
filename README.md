# BioQuest Indonesia — Python / Vercel

Deployable Flask web application with separate participant and researcher dashboards, private photo/video uploads, PostgreSQL persistence and manual observation verification. **No machine learning features.** The UI is a fresh implementation inspired by the provided BioQuest HTML; no sample users, fabricated observations, or prototype AI claims.

## Deploy on Vercel

1. Create a **private PostgreSQL database** (e.g. Neon or Supabase). Require TLS; copy its `DATABASE_URL` (include `sslmode=require`). Run `db/schema.sql` once using the provider SQL editor.
2. Create a **private S3-compatible bucket** (e.g. Cloudflare R2 or AWS S3), with public bucket access disabled. Configure its CORS policy to allow `PUT` from your exact Vercel domain and preview domains you intend to use; allow `Content-Type` header. Uploads go directly from the browser to private storage using short-lived signed URLs.
3. Push this folder's contents to a **private GitHub repository**. In Vercel, choose **Add New → Project → Import Git Repository** and select the repository. Framework: Other or auto-detected Flask; root directory: repository root. Vercel supports Flask Python deployments without custom rewrites.
4. In Vercel Project → Settings → Environment Variables, set every value from `.env.example`, using real secrets. Generate `SECRET_KEY` using `python -c "import secrets; print(secrets.token_hex(32))"`. Set `APP_ENV=production` and redeploy after saving variables.
5. Visit `/api/health` and `/`. Register a normal user. To grant a trusted researcher access, from your own secure terminal run `python scripts/promote_researcher.py researcher@example.com` with `DATABASE_URL` set. Log out and log back in to refresh the role.

## Local development

`python -m venv .venv` then `pip install -r requirements.txt`, set variables from `.env.example` (with local `APP_ENV=development`) and run `python app.py`. Requires a reachable PostgreSQL database and S3-compatible private bucket; no SQLite fallback.

## Security model and limitations

- Passwords hashed with Werkzeug scrypt; session cookies are HttpOnly, SameSite=Lax, and Secure in production. CSRF token required on mutations; login throttling stored in PostgreSQL. No default admin or researcher accounts.
- Participant records scoped to the signed-in user; researcher access enforced on the server. Reviewer decisions are recorded in `audit_log`. All media objects use private keys and expiring presigned URLs; the database stores metadata, not media bytes.
- Files: MIME type and claimed size are checked, and stored size/content-type metadata is checked after upload. **This is not malware scanning or file-content verification.** Before onboarding untrusted users, add upload quarantine, magic-byte validation, malware scanning, media transcoding, stronger per-account/IP rate limits, MFA for researchers, email verification and password reset, retention/deletion flows, backups, monitoring and security testing.
- The direct-to-storage signed PUT flow allows uploads up to 50 MB, but does not enforce the byte limit at the object-store boundary. Configure provider-side limits or switch to constrained presigned POST where supported. Abandoned uploads should be cleaned with a bucket lifecycle rule and database cleanup job.
- Database backups, encryption-at-rest, bucket access rules, CORS, TLS and secret rotation must be configured in your hosting providers. No app can guarantee absolute security. Do not collect sensitive wildlife locations; this version intentionally has no geolocation fields.
- This starter is **not independently penetration-tested or production security certified**. Perform a real end-to-end deployment test before public launch.

## Repository

`app.py` Flask app; `templates/` HTML; `static/` CSS/JS; `db/schema.sql` PostgreSQL schema; `scripts/promote_researcher.py` trusted role management; `.env.example` required configuration.
