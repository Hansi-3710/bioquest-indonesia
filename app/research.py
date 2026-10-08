import csv
import io

from flask import Blueprint, Response, abort, current_app, g, jsonify, render_template, request

from .api import decode_loc, decode_notes
from .db import get_db, now
from .security import audit, require, vault

bp = Blueprint("research", __name__, url_prefix="/research")


def pseudonym(public_id):
    return vault().blind("contributor:" + public_id)[:8]   # researchers never see usernames or emails


@bp.route("/")
@require("researcher")
def overview():
    db, week = get_db(), now() - 7 * 86400
    one = lambda sql, *a: db.execute(sql, a).fetchone()[0]
    c = dict(users=one("SELECT COUNT(*) FROM users WHERE role='user'"),
             total=one("SELECT COUNT(*) FROM observations"),
             week=one("SELECT COUNT(*) FROM observations WHERE created_at>?", week),
             pending=one("SELECT COUNT(*) FROM observations WHERE status='pending'"),
             verified=one("SELECT COUNT(*) FROM observations WHERE status='verified'"),
             rejected=one("SELECT COUNT(*) FROM observations WHERE status='rejected'"),
             images=one("SELECT COUNT(*) FROM media WHERE kind='image'"),
             videos=one("SELECT COUNT(*) FROM media WHERE kind='video'"),
             consented=one("SELECT COUNT(*) FROM observations WHERE status='verified' AND consent_research=1"))
    top = db.execute("SELECT s.common_name, COUNT(*) n FROM observations o JOIN species s ON s.id=COALESCE("
                     "o.final_species_id,o.species_id) WHERE o.status!='rejected' GROUP BY s.id ORDER BY n DESC "
                     "LIMIT 8").fetchall()
    return render_template("research/overview.html", c=c, top=top)


@bp.route("/review")
@require("researcher")
def review():
    status = request.args.get("status", "pending")
    if status not in ("pending", "verified", "rejected"):
        abort(400)
    db = get_db()
    rows = db.execute(
        "SELECT o.*, u.public_id AS upid, s.slug AS claimed_slug, s.common_name AS claimed, f.slug AS final_slug, "
        "m.public_id AS media, m.kind FROM observations o JOIN users u ON u.id=o.user_id "
        "LEFT JOIN species s ON s.id=o.species_id LEFT JOIN species f ON f.id=o.final_species_id "
        "JOIN media m ON m.observation_id=o.id WHERE o.status=? ORDER BY o.created_at "
        + ("ASC" if status == "pending" else "DESC") + " LIMIT 50", (status,)).fetchall()
    items = [dict(r=r, loc=decode_loc(r), notes=decode_notes(r), who=pseudonym(r["upid"])) for r in rows]
    species = db.execute("SELECT slug, common_name, scientific_name FROM species ORDER BY common_name").fetchall()
    return render_template("research/review.html", items=items, species=species, status=status)


@bp.post("/api/review/<pid>")
@require("researcher")
def review_action(pid):
    d, db = request.get_json(silent=True) or {}, get_db()
    o = db.execute("SELECT * FROM observations WHERE public_id=?", (pid,)).fetchone() or abort(404)
    action = d.get("action")
    if action not in ("verify", "reject", "reopen"):
        return jsonify(error="Unknown action."), 400
    final = None
    if action == "verify":
        slug = d.get("species")
        sp = db.execute("SELECT id FROM species WHERE slug=?", (slug,)).fetchone() if slug else None
        final = sp["id"] if sp else o["species_id"]
        if not final:
            return jsonify(error="Choose a species before verifying."), 400
    status = {"verify": "verified", "reject": "rejected", "reopen": "pending"}[action]
    db.execute("UPDATE observations SET status=?, final_species_id=?, reviewed_by=?, reviewed_at=? WHERE id=?",
               (status, final, g.user["id"], now(), o["id"]))
    audit("review_" + action, g.user["id"], pid)
    return jsonify(ok=True, status=status)


@bp.route("/map")
@require("researcher")
def map_view():
    return render_template("research/map.html")


@bp.route("/dataset")
@require("researcher")
def dataset():
    rows = get_db().execute(
        "SELECT s.common_name, s.scientific_name, COUNT(*) n FROM observations o JOIN species s "
        "ON s.id=o.final_species_id WHERE o.status='verified' AND o.consent_research=1 "
        "GROUP BY s.id ORDER BY n DESC").fetchall()
    return render_template("research/dataset.html", rows=rows, target=current_app.config["TRAINING_TARGET_PER_SPECIES"])


def _safe(x):   # neutralise spreadsheet formula injection
    x = "" if x is None else str(x)
    return "'" + x if x[:1] in "=+-@\t\r" else x


@bp.route("/export/manifest.csv")
@require("researcher")
def export_manifest():
    """Labels for every verified, consented observation. Contributors appear only as pseudonyms."""
    db, out = get_db(), io.StringIO()
    w = csv.writer(out)
    w.writerow(["observation_id", "media_id", "kind", "species_slug", "scientific_name", "lat", "lng", "contributor"])
    q = ("SELECT o.*, u.public_id AS upid, f.slug, f.scientific_name, f.sensitive, m.public_id AS media, m.kind "
         "FROM observations o JOIN users u ON u.id=o.user_id JOIN species f ON f.id=o.final_species_id "
         "JOIN media m ON m.observation_id=o.id WHERE o.status='verified' AND o.consent_research=1 ORDER BY o.created_at")
    for r in db.execute(q):
        loc, nd = decode_loc(r), (1 if r["sensitive"] else 2)   # coarser coordinates for protected species
        w.writerow([_safe(x) for x in (r["public_id"], r["media"], r["kind"], r["slug"], r["scientific_name"],
                                        round(loc["lat"], nd), round(loc["lng"], nd), pseudonym(r["upid"]))])
    audit("dataset_export", g.user["id"], "manifest.csv")
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=bioquest-manifest.csv"})
