from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

from . import db as dbm
from . import security
from .config import build_config
from .crypto import Vault

WIB = timezone(timedelta(hours=7))


def build_csp(local_leaflet, production):
    ext = "" if local_leaflet else " https://unpkg.com"
    parts = ["default-src 'none'", f"script-src 'self'{ext}", f"style-src 'self'{ext}",
             f"img-src 'self' data: blob: https://*.tile.openstreetmap.org{ext}", "media-src 'self' blob:",
             "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
             "object-src 'none'"]
    if production:
        parts.append("upgrade-insecure-requests")
    return "; ".join(parts)


def create_app(overrides=None):
    app = Flask(__name__)
    app.config.update(build_config(overrides))
    for key in ("SECRET_KEY", "MASTER_KEY"):
        if not app.config.get(key):
            raise RuntimeError(f"{key} is not set. Run `python manage.py init` to create a .env file.")
    app.extensions["vault"] = Vault(app.config["MASTER_KEY"])
    if app.config["TRUSTED_PROXIES"]:
        n = app.config["TRUSTED_PROXIES"]
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=n, x_proto=n, x_host=n)
    dbm.init_db(app)
    app.teardown_appcontext(dbm.close_db)

    local = (Path(app.static_folder) / "vendor/leaflet/leaflet.js").exists()
    csp = build_csp(local, app.config["PRODUCTION"])

    @app.template_filter("dt")
    def fmt_dt(ts):
        return datetime.fromtimestamp(ts, WIB).strftime("%d %b %Y, %H:%M WIB") if ts else ""

    @app.context_processor
    def inject():
        return dict(csrf_token=security.csrf_token, leaflet_local=local, me=g.get("user"))

    app.before_request(security.load_user)
    app.before_request(security.csrf_protect)

    @app.after_request
    def headers(resp):
        h = resp.headers
        h.setdefault("Content-Security-Policy", csp)
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "same-origin"
        h["Permissions-Policy"] = "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        h["Cross-Origin-Resource-Policy"] = "same-origin"
        if app.config["PRODUCTION"]:
            h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if request.endpoint != "static":
            h.setdefault("Cache-Control", "no-store")
        return resp

    from . import api, auth, research, user
    for m in (auth, api, user, research):
        app.register_blueprint(m.bp)

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(405)
    @app.errorhandler(413)
    @app.errorhandler(429)
    def http_error(e):
        msg = {403: "You do not have access to this page.", 404: "We could not find that page.",
               413: "That file is too large."}.get(e.code, "Something about that request was not right.")
        if request.path.startswith("/api/"):
            return jsonify(error=msg), e.code
        return render_template("error.html", code=e.code, msg=msg), e.code

    @app.errorhandler(500)
    def server_error(_e):
        if request.path.startswith("/api/"):
            return jsonify(error="Something went wrong on our side."), 500
        return render_template("error.html", code=500, msg="Something went wrong on our side."), 500

    return app
