# BioQuest Indonesia

A citizen-science web app for Indonesian biodiversity. Students and community members photograph plants and
animals, earn points and badges, and help researchers build a verified dataset that trains a species-identification model.

* **Explorer app** (`/`): sign up, take or upload photos/videos, get AI suggestions, collect species, weekly challenges, leaderboard, map, privacy controls.
* **Research dashboard** (`/research`): password + two-factor sign-in, review queue, dataset readiness, one-click model training, model activation, audit trail.
* **Secure by default**: encrypted uploads, encrypted personal data, Row-Level Security, strict CSP. See [SECURITY.md](SECURITY.md).

```
Browser ──HTTPS──▶ reverse proxy ──▶ web (Node/Express) ──▶ PostgreSQL (RLS, least-privilege roles)
                                         │                        ▲
                                         ▼                        │ read-only, consented + verified photos
                                  encrypted vault (disk)     trainer (Python/PyTorch) ──▶ ONNX model ──▶ web uses it for suggestions
```

## Quick start (local)

Requirements: Node 22+, PostgreSQL 15+.

```bash
npm install
npm run setup          # generates .env with fresh random secrets (chmod 600)
createdb bioquest      # then edit MIGRATE_DATABASE_URL in .env to match your Postgres owner login
npm run migrate        # creates tables, security policies, DB roles, seeds 12 species
npm run dev            # http://localhost:3000
npm test               # 13 end-to-end security + feature tests (needs the migrated DB)
```

Or with Docker: `npm run setup && docker compose up -d --build` (then put HTTPS in front, see below).

### Create a researcher
Researcher accounts cannot be created from the website. On the server:

```bash
npm run create-researcher -- --email dr.sari@univ.ac.id --name "Dr. Sari"
```
You get a one-time password. They sign in at `/research`, scan a QR code with an authenticator app, and change the password.
Lost phone? `npm run create-researcher -- --reset-mfa --email dr.sari@univ.ac.id`.

## The training loop

1. Citizens upload sightings (opting in to research sharing is a choice, off by default).
2. Researchers verify or correct each identification in the **Review queue**.
3. **Dataset** shows which species have enough verified photos (default 20 each).
4. **Train a model** queues a job. The worker (`ml/worker.py`) decrypts photos in memory, fine-tunes
   MobileNetV3 / EfficientNet-B0 / ResNet-18, exports ONNX, and records accuracy.
5. In **Models**, a researcher makes a version live. The web app then suggests species from new photos.
   Users' confirmations and corrections feed the next round.

Run the worker: `docker compose --profile training up -d`, or locally:
```bash
python -m venv .venv && . .venv/bin/activate && pip install -r ml/requirements.txt
python ml/worker.py
```
Until a model is live, users choose species themselves and researchers verify. Nothing breaks without a model.

## Put it on GitHub

```bash
git init -b main            # skip if you unzipped with the .git folder
git add . && git commit -m "Initial commit"
# create an EMPTY repo on github.com (no README), then:
git remote add origin https://github.com/<you>/bioquest-indonesia.git
git push -u origin main
```
`.gitignore` already excludes `.env`, `storage/` (encrypted uploads), models and `node_modules`.
**Check before pushing:** `git status` must not list `.env`. If a secret is ever committed, rotate every key; deleting the commit is not enough.
Then in GitHub: *Settings → Code security*: enable Dependabot alerts, secret scanning and push protection; *Settings → Branches*: require the CI check on `main`.

## Deploying for real
* Run behind HTTPS (Caddy / nginx / Cloudflare Tunnel). Set `PUBLIC_ORIGIN` to your exact https URL and `TRUST_PROXY=1`.
* Use managed Postgres or a private Docker network; never expose port 5432. Turn on automated, encrypted backups.
* Back up `.env` (or move the four keys to a secrets manager). **Without them, encrypted photos and emails cannot be recovered.**
* Back up the `vault` volume together with the database, they only make sense as a pair.
* Rotate the file master key: add `MEDIA_KEK_2` to `.env`, run `npm run rotate-key`.
* Verify the audit log regularly: `npm run audit:verify`.

## Project layout
```
src/            Express app: routes/, middleware/, security/ (crypto, passwords), services/
db/             schema.sql (tables, RLS, roles), species seed
public/         Explorer app (index.html) and research dashboard (research.html), self-hosted fonts
ml/             Python training worker
scripts/        setup, migrate, create-researcher, verify-audit, rotate-media-key
tests/          integration tests
```

## Known limitations
See the "Not covered yet" section of [SECURITY.md](SECURITY.md). Most important: there is no email verification or password-reset email
yet, and the training pipeline needs real verified data (and ideally a GPU) before the model is useful.
