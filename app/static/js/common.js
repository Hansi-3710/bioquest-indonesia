/* Shared helpers. No inline scripts anywhere: the Content-Security-Policy forbids them. */
const CSRF = document.querySelector('meta[name=csrf]').content;

async function api(url, opts = {}) {
  const res = await fetch(url, {credentials: 'same-origin', ...opts,
    headers: {'X-CSRF-Token': CSRF, ...(opts.headers || {})}});
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) throw new Error((body && body.error) || 'Request failed (' + res.status + ')');
  return body;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // textContent only: user data can never inject HTML
  return n;
}

function makeMap(id) {
  if (!window.L) { document.getElementById(id).textContent = 'The map library could not be loaded.'; return null; }
  const bounds = L.latLngBounds([-12.5, 94], [7.5, 142]);
  const map = L.map(id, {minZoom: 4, maxBounds: bounds.pad(0.4), maxBoundsViscosity: 0.8}).setView([-2.5, 118], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'}).addTo(map);
  return map;
}
