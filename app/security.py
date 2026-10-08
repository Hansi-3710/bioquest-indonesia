"""Sessions, CSRF, rate limiting, password policy, TOTP 2FA, audit log, access control."""
import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
import time
from functools import wraps

from flask import abort, current_app, g, jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db, now, tx

IDLE_TTL = {"user": 2 * 3600, "researcher": 20 * 60}          # inactivity timeout
ABSOLUTE_TTL = {"user": 7 * 86400, "researcher": 8 * 3600}    # hard session limit
MAX_FAILED, LOCK_SECONDS = 5, 15 * 60
DUMMY_HASH = generate_password_hash("not-a-real-password", method="scrypt")


def vault():
    return current_app.extensions["vault"]


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def ip_key():
    return vault().ip_hash(request.remote_addr or "0.0.0.0")


def wants_json():
    return request.path.startswith("/api/") or "/api/" in request.path


# ---------------------------------------------------------------- passwords
COMMON = {"passwordpassword", "password1234", "123456789012", "qwertyuiop12", "iloveyou1234",
          "letmein12345", "administrator", "welcome12345", "bioquest1234", "indonesia1234"}


def password_problem(pw, username="", email=""):
    if len(pw) < 12:
        return "Use at least 12 characters (a few random words work well)."
    if len(pw) > 128:
        return "Use at most 128 characters."
    low = pw.lower()
    local = email.split("@")[0].lower()
    if low in COMMON or len(set(pw)) < 5:
        return "That password is too easy to guess."
    if username and username.lower() in low:
        return "Your password must not contain your username."
    if len(local) >= 4 and local in low:
        return "Your password must not contain your email name."
    return None


def hash_password(pw):
    return generate_password_hash(vault().pepper(pw), method="scrypt")


def verify_password(stored, pw):
    return check_password_hash(stored or DUMMY_HASH, vault().pepper(pw[:128]))


# ---------------------------------------------------------------- rate limit
def rate_limited(key, limit, window):
    """Record a hit; True when `key` exceeded `limit` hits in `window` seconds."""
    db, t = get_db(), now()
    if secrets.randbelow(50) == 0:
        db.execute("DELETE FROM rate_hits WHERE ts<?", (t - 86400,))
    n = db.execute("SELECT COUNT(*) FROM rate_hits WHERE key=? AND ts>?", (key, t - window)).fetchone()[0]
    if n >= limit:
        return True
    db.execute("INSERT INTO rate_hits(key,ts) VALUES(?,?)", (key, t))
    return False


# ---------------------------------------------------------------- sessions
def start_session(user, mfa_ok):
    """Create a fresh server-side session (rotates the id: prevents session fixation)."""
    db, t = get_db(), now()
    old = session.get("sid")
    if old:
        db.execute("DELETE FROM sessions WHERE sid_hash=?", (sha(old),))
    session.clear()
    sid = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions(sid_hash,user_id,created_at,last_seen,expires_at,mfa_ok,ua_hash) "
               "VALUES(?,?,?,?,?,?,?)",
               (sha(sid), user["id"], t, t, t + ABSOLUTE_TTL[user["role"]], int(mfa_ok),
                sha(request.headers.get("User-Agent", ""))[:16]))
    session["sid"] = sid
    session["csrf"] = secrets.token_urlsafe(32)


def end_session():
    sid = session.get("sid")
    if sid:
        get_db().execute("DELETE FROM sessions WHERE sid_hash=?", (sha(sid),))
    session.clear()


def revoke_other_sessions(user_id):
    get_db().execute("DELETE FROM sessions WHERE user_id=? AND sid_hash!=?",
                     (user_id, sha(session.get("sid", ""))))


def load_user():
    g.user, g.mfa_ok = None, False
    sid = session.get("sid")
    if not sid:
        return
    db, t = get_db(), now()
    s = db.execute("SELECT * FROM sessions WHERE sid_hash=?", (sha(sid),)).fetchone()
    u = db.execute("SELECT * FROM users WHERE id=? AND is_active=1", (s["user_id"],)).fetchone() if s else None
    if not s or not u or s["expires_at"] < t or t - s["last_seen"] > IDLE_TTL[u["role"]]:
        if s:
            db.execute("DELETE FROM sessions WHERE sid_hash=?", (s["sid_hash"],))
        session.clear()
        return
    if t - s["last_seen"] > 60:
        db.execute("UPDATE sessions SET last_seen=? WHERE sid_hash=?", (t, s["sid_hash"]))
    g.user, g.mfa_ok = u, bool(s["mfa_ok"])


def require(role=None, allow_mfa_pending=False):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = g.user
            if not u:
                if wants_json():
                    return jsonify(error="Please sign in."), 401
                return redirect(url_for("auth.login"))
            if role and u["role"] != role:
                abort(403)
            if u["role"] == "researcher" and not g.mfa_ok and not allow_mfa_pending:
                if wants_json():
                    return jsonify(error="Two-factor sign-in required."), 401
                return redirect(url_for("auth.twofa"))
            return fn(*a, **kw)
        return wrapper
    return deco


# ---------------------------------------------------------------- CSRF
def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def csrf_protect():
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
    if not sent or not hmac.compare_digest(sent, session.get("csrf", "")):
        abort(403)
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
        abort(403)


# ---------------------------------------------------------------- TOTP (RFC 6238)
def new_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode()


def totp_code(secret, step):
    digest = hmac.new(base64.b32decode(secret), struct.pack(">Q", step), "sha1").digest()
    o = digest[-1] & 15
    return f"{(struct.unpack('>I', digest[o:o + 4])[0] & 0x7FFFFFFF) % 10**6:06d}"


def totp_verify(secret, code, last_step):
    """Returns the matched time-step (so it can be stored and never reused) or None."""
    code = re.sub(r"\s", "", code or "")
    current = int(time.time() // 30)
    for step in (current - 1, current, current + 1):
        if step > last_step and hmac.compare_digest(totp_code(secret, step), code):
            return step
    return None


# ---------------------------------------------------------------- audit log (hash chain)
def audit(action, actor_id=None, target=None, detail=""):
    db, v = get_db(), vault()

    def write():
        row = db.execute("SELECT mac FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
        prev, t = (row["mac"] if row else "0" * 64), now()
        mac = v.audit_mac(json.dumps([t, actor_id, action, target, detail, prev]))
        db.execute("INSERT INTO audit_log(ts,actor_id,action,target,detail,ip_hash,prev_mac,mac) "
                   "VALUES(?,?,?,?,?,?,?,?)", (t, actor_id, action, target, detail, ip_key(), prev, mac))

    if db.in_transaction:
        write()
    else:
        with tx(db):
            write()


def verify_audit_chain(db, v):
    """Returns None when intact, otherwise the id of the first altered row."""
    prev = "0" * 64
    for r in db.execute("SELECT * FROM audit_log ORDER BY id"):
        expect = v.audit_mac(json.dumps([r["ts"], r["actor_id"], r["action"], r["target"], r["detail"], prev]))
        if r["prev_mac"] != prev or not hmac.compare_digest(r["mac"], expect):
            return r["id"]
        prev = r["mac"]
    return None
