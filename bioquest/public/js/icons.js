// Inline SVG art original BioQuest illustration set.
const nv = (p) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const NAV = {
  home: nv('<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>'),
  disc: nv('<path d="M4 4h7a3 3 0 013 3v13a3 3 0 00-3-3H4zM20 4h-7v13h7z"/>'),
  cap: nv('<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-3h3L15 7"/>'),
  map: nv('<path d="M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>'),
  prof: nv('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>')
};
export const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
export const BADGE = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#0f5f3d"/><path d="M12 21l6 6 11-13" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>';
export const LOGO = '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#0F5F3D"/><path d="M32 12c10 6 16 15 16 24a16 16 0 0 1-32 0c0-9 6-18 16-24z" fill="#2F9E63"/><path d="M32 22v30M32 34l-8-6M32 40l8-6" stroke="#E3F3EA" stroke-width="3" stroke-linecap="round" fill="none"/></svg>';

export const ILL = {
  p: '<svg class="hero-art" viewBox="0 0 220 170" width="200" height="155" aria-hidden="true"><ellipse cx="110" cy="150" rx="70" ry="12" fill="#2f9e63"/><circle cx="110" cy="80" r="62" fill="#d6ecf5"/><rect x="92" y="80" width="26" height="42" rx="6" fill="#f28c28"/><rect x="94" y="120" width="10" height="30" fill="#2a5b8a"/><rect x="106" y="120" width="10" height="30" fill="#2a5b8a"/><circle cx="105" cy="68" r="12" fill="#8a5a3c"/><rect x="118" y="88" width="30" height="8" rx="4" fill="#f28c28"/><rect x="140" y="92" width="16" height="14" rx="3" fill="#c96a3a"/><path d="M148 92q-12-18 0-26q12 8 0 26z" fill="#2f9e63"/></svg>',
  t: '<svg class="hero-art" viewBox="0 0 220 170" width="200" height="155" aria-hidden="true"><circle cx="170" cy="30" r="14" fill="#ffd85a"/><ellipse cx="110" cy="152" rx="90" ry="12" fill="#2f9e63"/><rect x="106" y="70" width="8" height="80" fill="#8a5a3c"/><ellipse cx="110" cy="70" rx="24" ry="52" fill="#0f5f3d"/><rect x="60" y="100" width="6" height="50" fill="#8a5a3c"/><ellipse cx="63" cy="100" rx="18" ry="30" fill="#2f9e63"/><rect x="157" y="100" width="6" height="50" fill="#8a5a3c"/><ellipse cx="160" cy="98" rx="18" ry="32" fill="#2f9e63"/></svg>',
  g: '<svg class="hero-art" viewBox="0 0 220 170" width="200" height="155" aria-hidden="true"><path d="M85 30q10-24 25-4q-15 12-25 4zM110 22q14-22 22 2q-14 10-22-2zM135 34q16-10 22 8q-18 4-22-8z" fill="#2f9e63"/><circle cx="110" cy="100" r="60" fill="#a9dbe3"/><path d="M75 75q20-20 40-8q8 14-6 22q-16 4-20 20q-14-8-14-34zM118 108q20-6 30 10q-4 22-24 26q-12-16-6-36z" fill="#2f9e63"/></svg>'
};

const KS = {
  t: '<rect x="27" y="30" width="6" height="22" fill="#8a5a3c"/><ellipse cx="30" cy="22" rx="16" ry="18" fill="#2f9e63"/><ellipse cx="30" cy="20" rx="9" ry="12" fill="#0f5f3d"/>',
  f: '<rect x="29" y="28" width="3" height="26" fill="#2f9e63"/><g fill="#f28c28"><circle cx="30" cy="14" r="8"/><circle cx="20" cy="24" r="8"/><circle cx="40" cy="24" r="8"/><circle cx="30" cy="32" r="8"/></g><circle cx="30" cy="24" r="6" fill="#ffd85a"/>',
  b: '<ellipse cx="30" cy="34" rx="16" ry="12" fill="#8a5a3c"/><circle cx="42" cy="24" r="8" fill="#8a5a3c"/><path d="M49 24l7 3-7 3z" fill="#f28c28"/><path d="M14 34q10-14 22-4q-10 12-22 4z" fill="#0f5f3d"/><circle cx="44" cy="22" r="1.6" fill="#fff"/>',
  i: '<ellipse cx="19" cy="26" rx="14" ry="10" fill="#2f9e63"/><ellipse cx="41" cy="26" rx="14" ry="10" fill="#0f5f3d"/><ellipse cx="22" cy="40" rx="9" ry="7" fill="#2f9e63"/><ellipse cx="38" cy="40" rx="9" ry="7" fill="#0f5f3d"/><rect x="28" y="14" width="4" height="32" rx="2" fill="#12343b"/>',
  a: '<ellipse cx="30" cy="38" rx="20" ry="13" fill="#2f9e63"/><circle cx="30" cy="24" r="12" fill="#2f9e63"/><circle cx="25" cy="22" r="3" fill="#fff"/><circle cx="35" cy="22" r="3" fill="#fff"/><circle cx="25" cy="22" r="1.4" fill="#12343b"/><circle cx="35" cy="22" r="1.4" fill="#12343b"/>'
};
const KIND = { tree: 't', flower: 'f', bird: 'b', insect: 'i', amphibian: 'a', reptile: 'a', mammal: 'a', other: 'a' };
export const speciesIcon = (kind) => `<svg viewBox="0 0 60 60" aria-hidden="true">${KS[KIND[kind] ?? 'a']}</svg>`;
