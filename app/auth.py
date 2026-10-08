import re
import sqlite3
import secrets
from urllib.parse import quote

from flask import Blueprint, flash, g, redirect, render_template, request, url_for

from .db import get_db, now
from .security import (audit, end_session, hash_password, ip_key, new_totp_secret, password_problem,
                       rate_limited, require, start_session, totp_verify, vault, verify_password,
                       MAX_FAILED, LOCK_SECONDS)

bp = Blueprint("auth", __name__)
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")
BAD_LOGIN = "Email or password is incorrect, or the account is temporarily locked."


def home_for(user):
    return url_for("research.overview" if user["role"] == "researcher" else "user.home")


@bp.route("/")
def index():
    return redirect(home_for(g.user) if g.user else url_for("auth.login"))


@bp.route("/register", methods=["GET", "POST"])
def register():
    if g.user:
        return redirect(home_for(g.user))
    if request.method == "POST":
        f, db, v = request.form, get_db(), vault()
        if rate_limited("reg:" + ip_key(), 5, 3600):
            flash("Too many sign-ups from this network. Please try again later.", "error")
            return render_template("register.html"), 429
        username, email = f.get("username", "").strip(), f.get("email", "").strip().lower()
        pw = f.get("password", "")
        problems = []
        if not USERNAME_RE.match(username):
            problems.append("Username: 3-30 letters, numbers, dot, dash or underscore.")
        if not EMAIL_RE.match(email) or len(email) > 254:
            problems.append("Please enter a valid email address.")
        if pw != f.get("confirm", ""):
            problems.append("The two passwords do not match.")
        elif (p := password_problem(pw, username, email)):
            problems.append(p)
        if not f.get("age_ok"):
            problems.append("Please confirm the age / permission statement.")
        if not problems:
            pid = secrets.token_hex(8)
            try:
                db.execute(
                    "INSERT INTO users(public_id,username,email_bidx,email_enc,pw_hash,role,created_at) "
                    "VALUES(?,?,?,?,?,'user',?)",
                    (pid, username, v.blind(email), v.seal(email.encode(), f"users.email:{pid}".encode()),
                     hash_password(pw), now()))
            except sqlite3.IntegrityError:
                problems.append("That username or email cannot be used. Try a different one or sign in.")
            else:
                user = db.execute("SELECT * FROM users WHERE public_id=?", (pid,)).fetchone()
                start_session(user, True)
                audit("register", user["id"], pid)
                return redirect(url_for("user.home"))
        for p in problems:
            flash(p, "error")
        return render_template("register.html", username=username, email=email), 400
    return render_template("register.html")


@bp.route("/login", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(home_for(g.user))
    if request.method == "POST":
        db, v, t = get_db(), vault(), now()
        if rate_limited("login:" + ip_key(), 10, 600):
            audit("login_throttled")
            flash("Too many sign-in attempts. Please wait a few minutes.", "error")
            return render_template("login.html"), 429
        email, pw = request.form.get("email", "").strip().lower(), request.form.get("password", "")
        u = db.execute("SELECT * FROM users WHERE email_bidx=? AND is_active=1", (v.blind(email),)).fetchone()
        ok = verify_password(u["pw_hash"] if u else None, pw)   # always hash: constant-ish timing
        if u and ok and u["locked_until"] <= t:
            db.execute("UPDATE users SET failed_logins=0, locked_until=0, last_login=? WHERE id=?", (t, u["id"]))
            start_session(u, mfa_ok=(u["role"] != "researcher"))
            audit("login", u["id"], u["public_id"])
            return redirect(home_for(u))
        if u:
            fails = u["failed_logins"] + 1
            lock = t + LOCK_SECONDS if fails >= MAX_FAILED else 0
            db.execute("UPDATE users SET failed_logins=?, locked_until=? WHERE id=?",
                       (0 if lock else fails, lock, u["id"]))
            audit("login_fail" if not lock else "account_locked", u["id"], u["public_id"])
        else:
            audit("login_fail_unknown")
        flash(BAD_LOGIN, "error")
        return render_template("login.html"), 401
    return render_template("login.html")


@bp.route("/2fa", methods=["GET", "POST"])
@require(allow_mfa_pending=True)
def twofa():
    u, db, v = g.user, get_db(), vault()
    if u["role"] != "researcher" or g.mfa_ok:
        return redirect(home_for(u))
    aad = f"users.totp:{u['public_id']}".encode()
    if u["totp_enc"]:
        secret = v.open(u["totp_enc"], aad).decode()
    else:
        secret = new_totp_secret()
        db.execute("UPDATE users SET totp_enc=? WHERE id=?", (v.seal(secret.encode(), aad), u["id"]))
    enrolling = not u["totp_enabled"]
    if request.method == "POST":
        if rate_limited(f"2fa:{u['id']}", 8, 600):
            flash("Too many attempts. Wait a few minutes.", "error")
        else:
            step = totp_verify(secret, request.form.get("code", ""), u["totp_last_step"])
            if step:
                db.execute("UPDATE users SET totp_last_step=?, totp_enabled=1 WHERE id=?", (step, u["id"]))
                start_session(u, True)
                audit("2fa_ok" if not enrolling else "2fa_enrolled", u["id"], u["public_id"])
                return redirect(home_for(u))
            audit("2fa_fail", u["id"], u["public_id"])
            flash("That code is not valid. Check your phone's clock and try again.", "error")
    uri = (f"otpauth://totp/BioQuest:{quote(u['username'])}?secret={secret}"
           "&issuer=BioQuest&digits=6&period=30")
    return render_template("twofa.html", enrolling=enrolling, secret=secret, uri=uri)


@bp.post("/logout")
def logout():
    if g.user:
        audit("logout", g.user["id"], g.user["public_id"])
    end_session()
    return redirect(url_for("auth.login"))
