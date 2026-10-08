"""JSON API (map data, uploads) and the access-controlled media endpoint."""
import io
import json
import os
import secrets
from pathlib import Path

from flask import Blueprint, abort, current_app, g, jsonify, request, send_file

from .db import get_db, now, tx
from .security import audit, rate_limited, require, vault
from .uploads import UploadError, prepare

bp = Blueprint("api", __name__)
LAT, LNG = (-11.5, 6.5), (94.5, 141.5)   # bounding box around Indonesia


def decode_loc(row):
    return json.loads(vault().open(row["loc_enc"], f"observations.loc:{row['public_id']}".encode()))


def decode_notes(row):
    if not row["notes_enc"]:
        return ""
    return vault().open(row["notes_enc"], f"observations.notes:{row['public_id']}".encode()).decode()


@bp.get("/api/map")
@require()
def map_data():
    me, db = g.user, get_db()
    researcher = me["role"] == "researcher"
    scope = request.args.get("scope", "all")
    sql = ("SELECT o.public_id, o.user_id, o.status, o.loc_enc, o.created_at, s.common_name, s.scientific_name, "
           "s.sensitive, m.public_id AS media, m.kind FROM observations o "
           "LEFT JOIN species s ON s.id=COALESCE(o.final_species_id,o.species_id) "
           "LEFT JOIN media m ON m.observation_id=o.id WHERE o.status!='rejected'")
    args = []
    if not researcher:
        if scope == "mine":
            sql += " AND o.user_id=?"
            args.append(me["id"])
        else:   # everyone's *verified* sightings plus my own
            sql += " AND (o.user_id=? OR o.status='verified')"
            args.append(me["id"])
    rows = db.execute(sql + " ORDER BY o.created_at DESC LIMIT 2000", args).fetchall()
    out = []
    for r in rows:
        loc, mine = decode_loc(r), r["user_id"] == me["id"]
        lat, lng, blurred = loc["lat"], loc["lng"], False
        if r["sensitive"] and not mine and not researcher:   # protect vulnerable species
            lat, lng, blurred = round(lat, 1), round(lng, 1), True
        out.append(dict(id=r["public_id"], lat=lat, lng=lng, status=r["status"], ts=r["created_at"],
                        species=r["common_name"] or "Not identified yet", sci=r["scientific_name"],
                        mine=mine, blurred=blurred,
                        media=r["media"] if (mine or researcher) and r["kind"] == "image" else None))
    return jsonify(observations=out, server_time=now())


@bp.post("/api/observations")
@require("user")
def create_observation():
    db, v, cfg = get_db(), vault(), current_app.config
    if rate_limited(f"upload:{g.user['id']}", 30, 3600):
        return jsonify(error="Upload limit reached. Please try again in a while."), 429
    f, upload = request.form, request.files.get("file")
    if not upload:
        return jsonify(error="Choose a photo or video first."), 400
    try:
        lat, lng = float(f.get("lat", "")), float(f.get("lng", ""))
    except ValueError:
        return jsonify(error="Please add a location."), 400
    if not (LAT[0] <= lat <= LAT[1] and LNG[0] <= lng <= LNG[1]):
        return jsonify(error="The location must be inside Indonesia."), 400
    species_id = None
    if f.get("species"):
        sp = db.execute("SELECT id FROM species WHERE slug=?", (f["species"],)).fetchone()
        if not sp:
            return jsonify(error="Unknown species."), 400
        species_id = sp["id"]
    notes = "".join(c for c in f.get("notes", "")[:500] if c.isprintable() or c == "\n").strip()
    try:
        kind, mime, data = prepare(upload.read(), cfg["MAX_IMAGE_BYTES"], cfg["MAX_VIDEO_BYTES"])
    except UploadError as exc:
        return jsonify(error=str(exc)), 400

    pid, mid, t = secrets.token_hex(12), secrets.token_hex(16), now()
    blob, wrapped = v.encrypt_file(data, mid)
    path = Path(cfg["UPLOAD_DIR"]) / f"{mid}.bin"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(blob)
    try:
        with tx(db):
            cur = db.execute(
                "INSERT INTO observations(public_id,user_id,species_id,loc_enc,notes_enc,consent_research,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (pid, g.user["id"], species_id,
                 v.seal(json.dumps({"lat": lat, "lng": lng}).encode(), f"observations.loc:{pid}".encode()),
                 v.seal(notes.encode(), f"observations.notes:{pid}".encode()) if notes else None,
                 1 if f.get("consent") == "1" else 0, t))
            db.execute("INSERT INTO media(public_id,observation_id,kind,mime,size,sha256,wrapped_dek,created_at) "
                       "VALUES(?,?,?,?,?,?,?,?)",
                       (mid, cur.lastrowid, kind, mime, len(data), __import__("hashlib").sha256(data).hexdigest(),
                        wrapped, t))
            audit("observation_create", g.user["id"], pid, kind)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return jsonify(id=pid, kind=kind), 201


@bp.post("/api/observations/<pid>/delete")
@require("user")
def delete_observation(pid):
    db = get_db()
    o = db.execute("SELECT id FROM observations WHERE public_id=? AND user_id=?", (pid, g.user["id"])).fetchone()
    if not o:
        abort(404)
    delete_files(db, "SELECT public_id FROM media WHERE observation_id=?", (o["id"],))
    db.execute("DELETE FROM observations WHERE id=?", (o["id"],))
    audit("observation_delete", g.user["id"], pid)
    return jsonify(ok=True)


def delete_files(db, sql, args):
    base = Path(current_app.config["UPLOAD_DIR"])
    for m in db.execute(sql, args).fetchall():
        (base / f"{m['public_id']}.bin").unlink(missing_ok=True)


@bp.get("/media/<mid>")
@require()
def media(mid):
    r = get_db().execute("SELECT m.*, o.user_id FROM media m JOIN observations o ON o.id=m.observation_id "
                         "WHERE m.public_id=?", (mid,)).fetchone()
    # owners see their own files; researchers see all; everyone else gets a plain 404
    if not r or (g.user["role"] != "researcher" and r["user_id"] != g.user["id"]):
        abort(404)
    path = Path(current_app.config["UPLOAD_DIR"]) / f"{mid}.bin"
    try:
        data = vault().decrypt_file(path.read_bytes(), r["wrapped_dek"], mid)
    except Exception:
        abort(404)
    resp = send_file(io.BytesIO(data), mimetype=r["mime"], conditional=True, etag=r["sha256"], max_age=0)
    resp.headers["Cache-Control"] = "private, no-store"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return resp
