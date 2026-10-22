// Location privacy. Exact GPS is stored encrypted; the clear-text cell is
// deliberately coarse (about 11 km), and 5x coarser for sensitive species,
// so poachers cannot use public maps to find endangered animals or orchids.
const BOUNDS = { latMin: -13, latMax: 8, lonMin: 93, lonMax: 143 };

export function validCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lon >= BOUNDS.lonMin && lon <= BOUNDS.lonMax;
}

export function cellFor(lat, lon, sensitive) {
  const step = sensitive ? 0.5 : 0.1;
  const snap = (v) => Math.round((Math.floor(v / step + 1e-9) * step + step / 2) * 1e4) / 1e4;
  return { cell_lat: snap(lat), cell_lon: snap(lon) };
}
export const GEO_BOUNDS = BOUNDS;
