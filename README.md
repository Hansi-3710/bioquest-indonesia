# BioQuest Indonesia

A citizen-science web app for recording wildlife and plants across Indonesia. Contributors photograph or film what they find (live camera in the browser), pin it on a live map of Indonesia and earn points. Researchers review and verify the sightings in a separate dashboard, building a clean, consented dataset for a future species-recognition model.

Python 3.12 · Flask · SQLite · AES-256-GCM encryption · no inline JavaScript.

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python manage.py init                # creates .env with fresh secret keys + the database
python manage.py create-researcher   # your first researcher account
python manage.py run                 # http://127.0.0.1:5000
```

Camera access works on `localhost` and on any HTTPS site (browsers block it on plain HTTP).
The researcher signs in with email + password, then sets up an authenticator app (2FA) on first sign-in.
Normal contributors register themselves at `/register`.

Run the tests: `python -m unittest discover -s tests -v`

## Put it on GitHub

```bash
cd bioquest-indonesia
git remote add origin https://github.com/<you>/bioquest-indonesia.git
git push -u origin main
```

A first commit is already made. `.env`, the database and all uploads are in `.gitignore`: **never remove those lines**. Keep the repository private until you have chosen a licence.

## Pages

| Who | Page | What it does |
|---|---|---|
| Contributor | `/app/` | Level, points, recent sightings |
| | `/app/capture` | Live camera (photo or 15 s video) or file upload, species, GPS / tap-the-map location, optional research consent |
| | `/app/discoveries` | Species collection |
| | `/app/map` | Live map of Indonesia (refreshes every 15 s) |
| | `/app/profile` | Badges, leaderboard opt-in, password, download my data, delete account |
| Researcher | `/research/` | Totals and most-reported species |
| | `/research/review` | Verify, correct or reject sightings |
| | `/research/map` | Live map with exact locations |
| | `/research/dataset` | Verified + consented samples per species, CSV manifest |

## Getting data out for model training (later)

1. Researchers verify sightings in `/research/review`.
2. Only observations that are **verified and consented** are exported.
3. `python manage.py export-dataset --out ./training_set` decrypts the media into `training_set/<species>/` with a `labels.csv`. Contributors appear only as pseudonyms and coordinates are rounded.
4. Train from that folder. (The folder is unencrypted: keep it off shared drives and out of git.)

## Deploying

Run behind HTTPS (Caddy, nginx, or a PaaS) with `BIOQUEST_ENV=production`, `SECRET_KEY`, `MASTER_KEY` and `TRUSTED_PROXIES=1` set as environment variables, and a persistent volume for `BIOQUEST_DATA_DIR`. A `Dockerfile` is included. See **SECURITY.md** for the full checklist.

## Map notes

The map uses Leaflet and OpenStreetMap tiles. Leaflet is loaded from unpkg with integrity hashes; run `scripts/vendor_leaflet.sh` to host it yourself (the app then tightens its Content-Security-Policy automatically). OpenStreetMap's public tile server is meant for light use: for a busy site switch to a tile provider and update `img-src` in `app/__init__.py`.

## Layout

```
app/            Flask app (auth, user, research, api, security, crypto, db, uploads)
app/templates   server-rendered pages        app/static  CSS + JS (no inline scripts)
tests/          20 tests                      manage.py   admin commands
```
