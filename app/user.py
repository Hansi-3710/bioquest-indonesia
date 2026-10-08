import json

from flask import (Blueprint, Response, abort, flash, g, redirect, render_template, request, url_for)

from .api import decode_loc, decode_notes, delete_files
from .db import get_db, tx
from .security import (audit, end_session, hash_password, password_problem, revoke_other_sessions, require,
                       vault, verify_password)

bp = Blueprint("user", __name__, url_prefix="/app")
XP_PER_LEVEL = 200


def stats(db, uid):
    obs = db.execute(
        "SELECT o.status, COALESCE(o.final_species_id,o.species_id) AS sp, s.sensitive FROM observations o "
        "LEFT JOIN species s ON s.id=COALESCE(o.final_species_id,o.species_id) "
        "WHERE o.user_id=? ORDER BY o.created_at", (uid,)).fetchall()
    seen, pts, rare, verified, n = set(), 0, False, 0, 0
    for o in obs:
        if o["status"] == "rejected":
            continue
        n += 1
        pts += 20
        if o["sp"] and o["sp"] not in seen:
            seen.add(o["sp"])
            pts += 50
            rare = rare or bool(o["sensitive"])
        if o["status"] == "verified":
            pts += 30
            verified += 1
    badges = [("First discovery", n >= 1), ("5 species found", len(seen) >= 5), ("10 species found", len(seen) >= 10),
              ("Protected species observer", rare), ("3 sightings verified", verified >= 3),
              ("Species expert (25)", len(seen) >= 25)]
    return dict(points=pts, level=1 + pts // XP_PER_LEVEL, xp=pts % XP_PER_LEVEL, xp_max=XP_PER_LEVEL,
                observations=n, species=len(seen), verified=verified, badges=badges)


@bp.route("/")
@require("user")
def home():
    db = get_db()
    recent = db.execute(
        "SELECT o.public_id, o.status, o.created_at, s.common_name, m.public_id AS media, m.kind FROM observations o "
        "LEFT JOIN species s ON s.id=COALESCE(o.final_species_id,o.species_id) "
        "LEFT JOIN media m ON m.observation_id=o.id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 6",
        (g.user["id"],)).fetchall()
    return render_template("user/home.html", s=stats(db, g.user["id"]), recent=recent)


@bp.route("/capture")
@require("user")
def capture():
    sp = get_db().execute("SELECT slug, common_name, scientific_name FROM species ORDER BY common_name").fetchall()
    return render_template("user/capture.html", species=sp)


@bp.route("/discoveries")
@require("user")
def discoveries():
    db = get_db()
    rows = db.execute(
        "SELECT s.*, MIN(o.created_at) AS first_seen, COUNT(o.id) AS n FROM species s LEFT JOIN observations o "
        "ON COALESCE(o.final_species_id,o.species_id)=s.id AND o.user_id=? AND o.status!='rejected' "
        "GROUP BY s.id ORDER BY s.common_name", (g.user["id"],)).fetchall()
    return render_template("user/discoveries.html", species=rows, s=stats(db, g.user["id"]))


@bp.route("/species/<slug>")
@require("user")
def species(slug):
    db = get_db()
    sp = db.execute("SELECT * FROM species WHERE slug=?", (slug,)).fetchone() or abort(404)
    mine = db.execute("SELECT COUNT(*) c, MIN(created_at) f FROM observations WHERE user_id=? AND status!='rejected' "
                      "AND COALESCE(final_species_id,species_id)=?", (g.user["id"], sp["id"])).fetchone()
    return render_template("user/species.html", sp=sp, mine=mine)


@bp.route("/map")
@require("user")
def map_view():
    return render_template("user/map.html")


@bp.route("/leaderboard")
@require("user")
def leaderboard():
    db = get_db()
    rows = sorted(((u["username"], stats(db, u["id"])) for u in
                   db.execute("SELECT id, username FROM users WHERE leaderboard_optin=1 AND role='user'")),
                  key=lambda r: -r[1]["points"])[:25]
    return render_template("user/leaderboard.html", rows=rows)


@bp.route("/profile")
@require("user")
def profile():
    return render_template("user/profile.html", s=stats(get_db(), g.user["id"]))


@bp.post("/profile/leaderboard")
@require("user")
def toggle_leaderboard():
    get_db().execute("UPDATE users SET leaderboard_optin=? WHERE id=?",
                     (1 if request.form.get("optin") else 0, g.user["id"]))
    flash("Saved.", "ok")
    return redirect(url_for("user.profile"))


@bp.post("/profile/password")
@require("user")
def change_password():
    f, u = request.form, g.user
    if not verify_password(u["pw_hash"], f.get("current", "")):
        flash("Your current password is not correct.", "error")
    elif f.get("new") != f.get("confirm"):
        flash("The new passwords do not match.", "error")
    elif (p := password_problem(f.get("new", ""), u["username"])):
        flash(p, "error")
    else:
        get_db().execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(f["new"]), u["id"]))
        revoke_other_sessions(u["id"])
        audit("password_change", u["id"], u["public_id"])
        flash("Password updated. Other devices were signed out.", "ok")
    return redirect(url_for("user.profile"))


@bp.post("/profile/export")
@require("user")
def export_my_data():
    db, v, u = get_db(), vault(), g.user
    obs = []
    for o in db.execute("SELECT * FROM observations WHERE user_id=? ORDER BY created_at", (u["id"],)):
        obs.append(dict(id=o["public_id"], status=o["status"], created_at=o["created_at"],
                        location=decode_loc(o), notes=decode_notes(o), research_consent=bool(o["consent_research"])))
    data = dict(username=u["username"], email=v.open(u["email_enc"], f"users.email:{u['public_id']}".encode()).decode(),
                created_at=u["created_at"], observations=obs)
    audit("data_export", u["id"], u["public_id"])
    return Response(json.dumps(data, indent=2), mimetype="application/json",
                    headers={"Content-Disposition": "attachment; filename=my-bioquest-data.json"})


@bp.post("/profile/delete")
@require("user")
def delete_account():
    u, db = g.user, get_db()
    if request.form.get("confirm") != "DELETE" or not verify_password(u["pw_hash"], request.form.get("password", "")):
        flash("Type DELETE and enter your password to confirm.", "error")
        return redirect(url_for("user.profile"))
    delete_files(db, "SELECT m.public_id FROM media m JOIN observations o ON o.id=m.observation_id WHERE o.user_id=?",
                 (u["id"],))
    with tx(db):
        audit("account_delete", None, u["public_id"])
        db.execute("DELETE FROM users WHERE id=?", (u["id"],))
    end_session()
    flash("Your account and all your uploads were deleted.", "ok")
    return redirect(url_for("auth.login"))
