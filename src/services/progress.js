// Points, levels, badges and weekly challenges. All derived from the database,
// so the client can never award itself anything.
export const POINTS = { base: 50, firstDiscovery: 50, perVerified: 20 };
export const levelOf = (points) => Math.floor(points / 1000) + 1;

const PLANT = ['tree', 'flower'];
const ANIMAL = ['insect', 'bird', 'amphibian', 'reptile', 'mammal'];

export const CHALLENGES = [
  { id: 1, title: 'Discover 3 different plant species', goal: 3, reward: 100 },
  { id: 2, title: 'Find 2 different animals', goal: 2, reward: 80 },
  { id: 3, title: 'Submit 5 observations', goal: 5, reward: 120 },
  { id: 4, title: "Discover a species you haven't seen before", goal: 1, reward: 60 }
];

/** Monday 00:00 in Asia/Jakarta (UTC+7), as a YYYY-MM-DD string. */
export function weekStart(now = new Date()) {
  const j = new Date(now.getTime() + 7 * 3600e3);
  const dow = (j.getUTCDay() + 6) % 7; // Mon=0
  j.setUTCDate(j.getUTCDate() - dow);
  return j.toISOString().slice(0, 10);
}
const weekStartTs = (ws) => new Date(ws + 'T00:00:00+07:00');

export async function challengeProgress(db, userId) {
  const ws = weekStart();
  const { rows } = await db.query(
    `SELECT s.kind, o.species_id, o.is_first
       FROM observations o JOIN species s ON s.id = o.species_id
      WHERE o.user_id = $1 AND o.observed_at >= $2 AND o.user_choice <> 'none'`,
    [userId, weekStartTs(ws)]
  );
  const submitted = await db.query(
    `SELECT count(*)::int AS n FROM observations WHERE user_id = $1 AND observed_at >= $2 AND user_choice <> 'none'`,
    [userId, weekStartTs(ws)]
  );
  const claims = await db.query('SELECT challenge_id FROM challenge_claims WHERE user_id = $1 AND week_start = $2', [userId, ws]);
  const claimed = new Set(claims.rows.map((r) => r.challenge_id));
  const distinct = (kinds) => new Set(rows.filter((r) => kinds.includes(r.kind)).map((r) => r.species_id)).size;
  const value = {
    1: distinct(PLANT),
    2: distinct(ANIMAL),
    3: submitted.rows[0].n,
    4: rows.filter((r) => r.is_first).length
  };
  return CHALLENGES.map((c) => ({
    ...c, value: Math.min(value[c.id], c.goal), claimed: claimed.has(c.id), ready: value[c.id] >= c.goal && !claimed.has(c.id)
  }));
}

export const BADGES = [
  { id: 'first', name: 'First Discovery', hint: 'Identify your first species' },
  { id: 'five', name: '5 Species Found', hint: 'Find 5 different species' },
  { id: 'ten', name: '10 Species Found', hint: 'Find 10 different species' },
  { id: 'endangered', name: 'Endangered Species Observer', hint: 'Photograph an endangered species' },
  { id: 'explorer', name: 'Biodiversity Explorer', hint: 'Find species from 3 different groups' },
  { id: 'weekend', name: 'Weekend Explorer', hint: 'Submit an observation on a weekend' },
  { id: 'expert', name: 'Species Expert', hint: 'Get 10 observations verified by researchers' }
];

export async function badgesFor(db, userId) {
  const { rows: [r] } = await db.query(
    `SELECT u.species_found,
            (SELECT count(DISTINCT s.kind) FROM observations o JOIN species s ON s.id=o.species_id WHERE o.user_id=u.id AND o.user_choice<>'none')::int AS kinds,
            (SELECT count(*) FROM observations o JOIN species s ON s.id=o.species_id WHERE o.user_id=u.id AND o.user_choice<>'none' AND s.iucn_code IN ('EN','CR'))::int AS endangered,
            (SELECT count(*) FROM observations o WHERE o.user_id=u.id AND o.user_choice<>'none'
               AND EXTRACT(ISODOW FROM o.observed_at AT TIME ZONE 'Asia/Jakarta') IN (6,7))::int AS weekend,
            (SELECT count(*) FROM observations o WHERE o.user_id=u.id AND o.status='verified')::int AS verified
       FROM users u WHERE u.id = $1`, [userId]);
  const earned = {
    first: r.species_found >= 1, five: r.species_found >= 5, ten: r.species_found >= 10,
    endangered: r.endangered >= 1, explorer: r.kinds >= 3, weekend: r.weekend >= 1, expert: r.verified >= 10
  };
  return BADGES.map((b) => ({ ...b, earned: !!earned[b.id] }));
}
