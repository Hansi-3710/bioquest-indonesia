#!/usr/bin/env python3
"""Admin command line:  python manage.py <command>

  init                 create .env with fresh secrets, set up the database
  create-researcher    add a researcher account (they enrol 2FA at first sign-in)
  reset-2fa USERNAME   let a researcher re-enrol their authenticator
  verify-audit         check the audit log hash chain for tampering
  export-dataset       write verified + consented media and labels to a folder for training
  run                  development server on http://127.0.0.1:5000
"""
import argparse
import getpass
import os
import re
import secrets
import sys
from pathlib import Path

from app.config import BASE_DIR

ENV = BASE_DIR / ".env"


def cmd_init(_a):
    from app.crypto import new_key
    if ENV.exists():
        print(".env already exists - keeping your keys.")
    else:
        fd = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(f"BIOQUEST_ENV=development\nSECRET_KEY={secrets.token_urlsafe(48)}\nMASTER_KEY={new_key()}\n")
        print("Created .env (permissions 600).\n"
              "BACK UP MASTER_KEY somewhere safe (password manager). Without it every encrypted\n"
              "field and upload becomes unreadable - nobody, including us, can recover them.")
    from app import create_app
    create_app()
    print("Database ready in ./data")


def _app():
    from app import create_app
    return create_app()


def cmd_create_researcher(_a):
    from app.db import now
    from app.security import hash_password, password_problem, vault
    from app.auth import EMAIL_RE, USERNAME_RE
    app = _app()
    username = input("Username: ").strip()
    email = input("Email: ").strip().lower()
    pw = getpass.getpass("Password (12+ chars): ")
    if pw != getpass.getpass("Repeat password: "):
        sys.exit("Passwords differ.")
    problem = password_problem(pw, username, email)
    if not USERNAME_RE.match(username) or not EMAIL_RE.match(email) or problem:
        sys.exit(problem or "Invalid username or email.")
    with app.test_request_context():
        from app.db import get_db
        v, pid = vault(), secrets.token_hex(8)
        get_db().execute(
            "INSERT INTO users(public_id,username,email_bidx,email_enc,pw_hash,role,created_at) VALUES(?,?,?,?,?,'researcher',?)",
            (pid, username, v.blind(email), v.seal(email.encode(), f"users.email:{pid}".encode()),
             hash_password(pw), now()))
    print(f"Researcher '{username}' created. They will set up 2FA at first sign-in.")


def cmd_reset_2fa(a):
    app = _app()
    with app.test_request_context():
        from app.db import get_db
        from app.security import audit
        db = get_db()
        cur = db.execute("UPDATE users SET totp_enc=NULL, totp_enabled=0, totp_last_step=0 WHERE username=? "
                         "AND role='researcher'", (a.username,))
        db.execute("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)", (a.username,))
        audit("2fa_reset_cli", None, a.username)
    print("Done." if cur.rowcount else "No such researcher.")


def cmd_verify_audit(_a):
    app = _app()
    with app.test_request_context():
        from app.db import get_db
        from app.security import verify_audit_chain, vault
        bad = verify_audit_chain(get_db(), vault())
    print("Audit log intact." if bad is None else f"TAMPERING DETECTED at audit row {bad}.")
    sys.exit(0 if bad is None else 1)


def cmd_export_dataset(a):
    import csv
    from app.api import decode_loc
    from app.research import pseudonym
    from app.security import audit, vault
    app, out = _app(), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    with app.test_request_context():
        from app.db import get_db
        db, v, n = get_db(), vault(), 0
        rows = db.execute(
            "SELECT o.*, u.public_id AS upid, f.slug, f.sensitive, m.public_id AS mid, m.kind, m.mime, m.wrapped_dek "
            "FROM observations o JOIN users u ON u.id=o.user_id JOIN species f ON f.id=o.final_species_id "
            "JOIN media m ON m.observation_id=o.id WHERE o.status='verified' AND o.consent_research=1").fetchall()
        with open(out / "labels.csv", "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["file", "species", "kind", "lat", "lng", "contributor"])
            for r in rows:
                ext = {"image/jpeg": "jpg", "video/webm": "webm", "video/mp4": "mp4"}[r["mime"]]
                data = v.decrypt_file((Path(app.config["UPLOAD_DIR"]) / f"{r['mid']}.bin").read_bytes(),
                                      r["wrapped_dek"], r["mid"])
                d = out / r["slug"]
                d.mkdir(exist_ok=True)
                (d / f"{r['mid']}.{ext}").write_bytes(data)
                loc, nd = decode_loc(r), (1 if r["sensitive"] else 2)
                w.writerow([f"{r['slug']}/{r['mid']}.{ext}", r["slug"], r["kind"], round(loc["lat"], nd),
                            round(loc["lng"], nd), pseudonym(r["upid"])])
                n += 1
        audit("dataset_export_cli", None, str(out), f"{n} files")
    print(f"Exported {n} files to {out}. This folder is UNENCRYPTED - handle it accordingly.")


def cmd_run(_a):
    _app().run(host="127.0.0.1", port=5000, debug=False)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=cmd_init)
    sub.add_parser("create-researcher").set_defaults(fn=cmd_create_researcher)
    s = sub.add_parser("reset-2fa"); s.add_argument("username"); s.set_defaults(fn=cmd_reset_2fa)
    sub.add_parser("verify-audit").set_defaults(fn=cmd_verify_audit)
    s = sub.add_parser("export-dataset"); s.add_argument("--out", required=True); s.set_defaults(fn=cmd_export_dataset)
    sub.add_parser("run").set_defaults(fn=cmd_run)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
