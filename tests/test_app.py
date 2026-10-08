import io
import re
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from app import create_app
from app.crypto import new_key
from app.db import now
from app.security import hash_password, totp_code, totp_verify, verify_audit_chain, password_problem

PW = "correct horse battery staple"


def png_bytes():
    b = io.BytesIO()
    Image.new("RGB", (64, 48), (30, 140, 80)).save(b, "PNG")
    return b.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.app = create_app(dict(TESTING=True, SECRET_KEY="x" * 40, MASTER_KEY=new_key(), DATA_DIR=str(d),
                                   DB_PATH=str(d / "t.db"), UPLOAD_DIR=str(d / "up")))
        self.c = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def token(self, client=None, path="/login"):
        html = (client or self.c).get(path).get_data(as_text=True)
        return re.search(r'name="csrf" content="([^"]+)"', html).group(1)

    def register(self, client, name="alice", email="alice@example.com"):
        t = self.token(client, "/register")
        return client.post("/register", data=dict(csrf_token=t, username=name, email=email, password=PW,
                                                  confirm=PW, age_ok="1"))

    def login(self, client, email, pw=PW):
        return client.post("/login", data=dict(csrf_token=self.token(client), email=email, password=pw))

    def make_researcher(self, name="rita", email="rita@lab.org"):
        with self.app.test_request_context():
            from app.db import get_db
            from app.security import vault
            v = vault()
            get_db().execute("INSERT INTO users(public_id,username,email_bidx,email_enc,pw_hash,role,created_at) "
                             "VALUES('r1',?,?,?,?,'researcher',?)",
                             (name, v.blind(email), v.seal(email.encode(), b"users.email:r1"), hash_password(PW), now()))

    def upload(self, client, lat="-6.2", lng="106.8", consent="1", data=None, name="a.png"):
        return client.post("/api/observations", headers={"X-CSRF-Token": self.token(client, "/app/capture")},
                           data=dict(file=(io.BytesIO(data or png_bytes()), name), species="jasmine", notes="hi",
                                     lat=lat, lng=lng, consent=consent), content_type="multipart/form-data")


class AuthTests(Base):
    def test_register_login_logout(self):
        self.assertEqual(self.register(self.c).status_code, 302)
        self.assertEqual(self.c.get("/app/").status_code, 200)
        self.c.post("/logout", data=dict(csrf_token=self.token(self.c, "/app/")))
        self.assertEqual(self.c.get("/app/").status_code, 302)
        self.assertEqual(self.login(self.c, "alice@example.com").status_code, 302)

    def test_csrf_required(self):
        self.assertEqual(self.c.post("/login", data=dict(email="a@b.co", password="x")).status_code, 403)

    def test_weak_password_rejected(self):
        self.assertIsNotNone(password_problem("short"))
        self.assertIsNotNone(password_problem("alice-alice-alice", "alice"))
        self.assertIsNone(password_problem(PW))

    def test_lockout_after_failures(self):
        self.register(self.c)
        c2 = self.app.test_client()
        for _ in range(5):
            self.assertEqual(self.login(c2, "alice@example.com", "wrong-password-1").status_code, 401)
        self.assertEqual(self.login(c2, "alice@example.com").status_code, 401)   # right password, still locked

    def test_generic_error_for_unknown_user(self):
        r = self.login(self.c, "nobody@example.com")
        self.assertEqual(r.status_code, 401)

    def test_login_rate_limit(self):
        codes = [self.login(self.c, "x%d@example.com" % i, "nope-nope-nope").status_code for i in range(12)]
        self.assertIn(429, codes)

    def test_duplicate_email_rejected(self):
        self.register(self.c)
        self.assertEqual(self.register(self.app.test_client(), name="bob").status_code, 400)


class RoleTests(Base):
    def test_user_cannot_open_researcher_area(self):
        self.register(self.c)
        self.assertEqual(self.c.get("/research/").status_code, 403)
        self.assertEqual(self.c.get("/research/export/manifest.csv").status_code, 403)

    def test_anonymous_redirected(self):
        self.assertEqual(self.c.get("/app/").status_code, 302)
        self.assertEqual(self.c.get("/api/map").status_code, 401)

    def test_researcher_needs_2fa_then_blocked_from_user_area(self):
        self.make_researcher()
        self.assertEqual(self.login(self.c, "rita@lab.org").status_code, 302)
        self.assertEqual(self.c.get("/research/").headers["Location"], "/2fa")
        page = self.c.get("/2fa").get_data(as_text=True)
        secret = re.search(r'class="secret"[^>]*>([A-Z2-7]+)<', page).group(1)
        bad = self.c.post("/2fa", data=dict(csrf_token=self.token(self.c, "/2fa"), code="000000"))
        self.assertEqual(bad.status_code, 200)
        code = totp_code(secret, int(time.time() // 30))
        ok = self.c.post("/2fa", data=dict(csrf_token=self.token(self.c, "/2fa"), code=code))
        self.assertEqual(ok.status_code, 302)
        self.assertEqual(self.c.get("/research/").status_code, 200)
        self.assertEqual(self.c.get("/app/").status_code, 403)

    def test_totp_rfc6238_vector_and_replay(self):
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        self.assertEqual(totp_code(secret, 1), "287082")
        step = int(time.time() // 30)
        code = totp_code(secret, step)
        self.assertEqual(totp_verify(secret, code, 0), step)
        self.assertIsNone(totp_verify(secret, code, step))   # same code cannot be reused


class DataTests(Base):
    def test_sensitive_columns_not_stored_in_clear(self):
        self.register(self.c)
        self.upload(self.c)
        con = sqlite3.connect(self.app.config["DB_PATH"])
        dump = "\n".join(con.iterdump()).encode()
        self.assertNotIn(b"alice@example.com", dump)
        self.assertNotIn(b"-6.2", dump)

    def test_upload_encrypted_on_disk_and_roundtrips(self):
        self.register(self.c)
        r = self.upload(self.c)
        self.assertEqual(r.status_code, 201, r.get_data(as_text=True))
        f = next(Path(self.app.config["UPLOAD_DIR"]).glob("*.bin"))
        raw = f.read_bytes()
        self.assertNotIn(b"\xff\xd8\xff", raw[:64])
        self.assertNotIn(b"JFIF", raw)
        self.assertEqual(oct(f.stat().st_mode & 0o777), "0o600")
        got = self.c.get("/media/" + f.stem)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.data[:3], b"\xff\xd8\xff")

    def test_other_user_cannot_read_media(self):
        self.register(self.c)
        self.upload(self.c)
        mid = next(Path(self.app.config["UPLOAD_DIR"]).glob("*.bin")).stem
        other = self.app.test_client()
        self.register(other, "bob", "bob@example.com")
        self.assertEqual(other.get("/media/" + mid).status_code, 404)

    def test_rejects_fake_and_out_of_range_uploads(self):
        self.register(self.c)
        self.assertEqual(self.upload(self.c, data=b"<script>alert(1)</script>", name="x.png").status_code, 400)
        self.assertEqual(self.upload(self.c, lat="51.5", lng="-0.1").status_code, 400)

    def test_map_blurs_protected_species_for_others(self):
        self.register(self.c)
        t = self.token(self.c, "/app/capture")
        self.c.post("/api/observations", headers={"X-CSRF-Token": t}, content_type="multipart/form-data",
                    data=dict(file=(io.BytesIO(png_bytes()), "a.png"), species="moon-orchid", lat="-6.234567",
                              lng="106.812345", consent="0"))
        mine = self.c.get("/api/map?scope=mine").get_json()["observations"][0]
        self.assertEqual(mine["lat"], -6.234567)
        with self.app.test_request_context():
            from app.db import get_db
            get_db().execute("UPDATE observations SET status='verified'")
        other = self.app.test_client()
        self.register(other, "bob", "bob@example.com")
        seen = other.get("/api/map").get_json()["observations"][0]
        self.assertEqual((seen["lat"], seen["lng"], seen["blurred"]), (-6.2, 106.8, True))

    def test_review_flow_and_manifest(self):
        self.register(self.c)
        self.upload(self.c)
        self.make_researcher()
        rc = self.app.test_client()
        self.login(rc, "rita@lab.org")
        page = rc.get("/2fa").get_data(as_text=True)
        secret = re.search(r'class="secret"[^>]*>([A-Z2-7]+)<', page).group(1)
        rc.post("/2fa", data=dict(csrf_token=self.token(rc, "/2fa"), code=totp_code(secret, int(time.time() // 30))))
        pid = re.search(r'data-id="([0-9a-f]+)"', rc.get("/research/review").get_data(as_text=True)).group(1)
        hdr = {"X-CSRF-Token": self.token(rc, "/research/")}
        self.assertEqual(rc.post(f"/research/api/review/{pid}", json=dict(action="verify"), headers=hdr).status_code, 200)
        csv = rc.get("/research/export/manifest.csv").get_data(as_text=True)
        self.assertIn("jasmine", csv)
        self.assertNotIn("alice", csv)
        with self.app.test_request_context():
            from app.db import get_db
            from app.security import vault
            self.assertIsNone(verify_audit_chain(get_db(), vault()))
            get_db().execute("UPDATE audit_log SET action='x' WHERE id=1")
            self.assertEqual(verify_audit_chain(get_db(), vault()), 1)

    def test_delete_account_removes_files(self):
        self.register(self.c)
        self.upload(self.c)
        t = self.token(self.c, "/app/profile")
        self.c.post("/app/profile/delete", data=dict(csrf_token=t, confirm="DELETE", password=PW))
        self.assertEqual(list(Path(self.app.config["UPLOAD_DIR"]).glob("*.bin")), [])


class HeaderTests(Base):
    def test_security_headers(self):
        h = self.c.get("/login").headers
        self.assertIn("default-src 'none'", h["Content-Security-Policy"])
        self.assertNotIn("unsafe-inline", h["Content-Security-Policy"])
        self.assertEqual(h["X-Frame-Options"], "DENY")
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertIn("camera=(self)", h["Permissions-Policy"])
        self.assertEqual(h["Cache-Control"], "no-store")

    def test_no_inline_scripts_or_styles_in_pages(self):
        self.register(self.c)
        for p in ("/app/", "/app/capture", "/app/map", "/app/discoveries", "/app/profile", "/app/leaderboard"):
            html = self.c.get(p).get_data(as_text=True)
            self.assertNotRegex(html, r"<script(?![^>]*src=)")
            self.assertNotRegex(html, r'\sstyle="')
            self.assertNotRegex(html, r'\son\w+="')


if __name__ == "__main__":
    unittest.main()
