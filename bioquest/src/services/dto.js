export const speciesDto = (r, p = '') => r && r[p + 'slug'] !== undefined ? ({
  slug: r[p + 'slug'], name: r[p + 'common_name'], scientific: r[p + 'scientific_name'], kind: r[p + 'kind'],
  iucn: r[p + 'iucn_code'], status: r[p + 'status_label'], description: r[p + 'description'],
  habitat: r[p + 'habitat'], why: r[p + 'why_it_matters'], colors: [r[p + 'color_a'], r[p + 'color_b']]
}) : null;

export const mediaDto = (m) => ({ id: m.id, kind: m.kind, url: `/api/media/${m.id}`, thumbUrl: m.kind === 'image' ? `/api/media/${m.id}/thumb` : null });

/** Keep a user's "species found" count honest after deletes or expert corrections. */
export async function recountSpecies(db, userId) {
  await db.query(
    `UPDATE users SET species_found = (SELECT count(DISTINCT species_id) FROM observations WHERE user_id = $1 AND species_id IS NOT NULL AND user_choice <> 'none'),
                      observation_count = (SELECT count(*) FROM observations WHERE user_id = $1 AND user_choice <> 'none')
      WHERE id = $1`, [userId]);
}
