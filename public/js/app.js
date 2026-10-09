import { get, post, patch, del, api, setCsrf, ApiError } from './api.js';
import { esc, $, $$, hydrate, toast, fmtDate, fmtDateTime, pct } from './ui.js';
import { NAV, BACK, BADGE, LOGO, ILL, speciesIcon } from './icons.js';

const S = {
  user: null, view: 'boot', arg: null, summary: null, species: [], mapPins: [], lb: null,
  lbScope: 'community', mapScope: 'all', authTab: 'login', err: '', ob: 0, busy: false,
  cap: { files: [], urls: [], lat: null, lon: null, notes: '', place: '', share: false },
  result: null, saved: null, mine: []
};
const bySlug = (slug) => S.species.find((s) => s.slug === slug);
const screen = $('#screen');

// ---------------------------------------------------------------- small views
const art = (sp, wide) => sp
  ? `<div class="ph ${wide ? 'w' : ''}" data-bg="${esc(sp.colors[0])},${esc(sp.colors[1])}">${speciesIcon(sp.kind)}</div>` : '';
const speciesTile = (s) => `<button class="sp" data-go="sp" data-arg="${esc(s.slug)}" aria-label="${s.found ? esc(s.name) : 'Undiscovered species'}">
  <div class="ph ${s.found ? '' : 'lock'}" ${s.found ? `data-bg="${esc(s.colors[0])},${esc(s.colors[1])}"` : ''}>${s.found ? speciesIcon(s.kind) : '<span>?</span>'}</div>
  <b>${s.found ? esc(s.name) : '???'}</b><span class="mute sm">${s.found ? fmtDate(s.firstAt, { month: 'short', day: 'numeric' }) : 'Not found yet'}</span></button>`;
const backBtn = (to = 'home') => `<div class="top"><button class="iconbtn" data-go="${to}" aria-label="Back">${BACK}</button></div>`;
const statusTag = (s) => `<span class="tag ${esc(s.iucn)}">${esc(s.status)}</span>`;
const errBox = () => (S.err ? `<p class="error" role="alert">${esc(S.err)}</p>` : '');

// ---------------------------------------------------------------- views
const V = {
  boot: () => '<div style="padding-top:120px"><div class="spinner" role="status" aria-label="Loading"></div></div>',

  auth() {
    const reg = S.authTab === 'register';
    return `<div class="auth"><div class="brand">${LOGO}<b>BioQuest Indonesia</b></div>
      <p class="mute">Photograph the plants and animals around you and help researchers protect Indonesia's biodiversity.</p>
      <div class="seg" role="tablist"><button role="tab" class="${reg ? '' : 'on'}" data-act="tab" data-arg="login">Sign in</button><button role="tab" class="${reg ? 'on' : ''}" data-act="tab" data-arg="register">Create account</button></div>
      ${errBox()}
      <form data-form="${reg ? 'register' : 'login'}" novalidate>
        ${reg ? `<label class="field"><span>Display name</span><input class="input" name="displayName" required minlength="2" maxlength="30" autocomplete="nickname"><span class="hint">Shown on leaderboards. Please don't use your full real name.</span></label>
        <label class="field"><span>School or community <small>(optional)</small></span><input class="input" name="community" maxlength="60" placeholder="e.g. SMA 3 Bandung"></label>` : ''}
        <label class="field"><span>Email</span><input class="input" type="email" name="email" required autocomplete="email" inputmode="email" maxlength="254"></label>
        <label class="field"><span>Password</span><input class="input" type="password" name="password" required autocomplete="${reg ? 'new-password' : 'current-password'}" ${reg ? 'minlength="12"' : ''} maxlength="200">
          ${reg ? '<span class="hint">At least 12 characters. A short sentence works well.</span>' : ''}</label>
        ${reg ? `<label class="check"><input type="checkbox" name="consentResearch"><span><b>Share my verified photos with researchers.</b> They may be used to train species-identification models. You can change this any time in Profile.</span></label>
        <label class="check"><input type="checkbox" name="acceptTerms" required><span>I understand how BioQuest handles my data: photos are encrypted, locations are shown only as approximate areas, and I can delete everything whenever I like.</span></label>` : ''}
        <button class="btn" type="submit" ${S.busy ? 'disabled' : ''}>${reg ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="mute sm" style="margin-top:16px;text-align:center">Are you a researcher? <a href="/research">Go to the research dashboard</a></p></div>`;
  },

  ob() {
    const slides = [
      ['Discover nature', 'Take a photo of any plant or animal around you and let AI suggest what it is.', ILL.p],
      ['Build your collection', 'Confirm your finds, earn points and badges, and collect species across Indonesia.', ILL.t],
      ['Protect biodiversity', "Your verified sightings help researchers understand and protect Indonesia's wildlife.", ILL.g]
    ];
    const [t, d, a] = slides[S.ob];
    return `<div style="text-align:center;padding-top:14px"><div style="text-align:right"><button class="chip" data-act="onboarded">Skip</button></div>
      <div style="margin:10px 0">${a}</div><h2 style="font-size:24px;color:var(--forest)">${t}</h2><p class="mute" style="margin:10px 8px 22px;font-size:15px">${d}</p>
      <button class="btn" data-act="${S.ob < 2 ? 'next-ob' : 'onboarded'}">${S.ob < 2 ? 'Next' : 'Get started'}</button>
      <div class="dots" style="margin-top:14px">${[0, 1, 2].map((k) => `<span class="${k === S.ob ? 'on' : ''}"></span>`).join('')}</div></div>`;
  },

  home() {
    const m = S.summary; const c = m.challenges[0];
    const recent = S.species.filter((s) => s.found).sort((a, b) => new Date(b.firstAt) - new Date(a.firstAt)).slice(0, 3);
    return `<div class="row"><div style="flex:1"><h1 style="font-size:22px">Hi, ${esc(m.displayName)}!</h1><div class="mute">Level ${m.level} · ${m.speciesFound} of ${m.speciesTotal} species found</div></div>
      <div class="card" style="margin:0;padding:8px 14px;text-align:center"><div class="num">${m.points}</div><div class="mute sm">points</div></div></div>
      <div class="card" style="margin-top:14px"><div class="row between"><b>Progress to level ${m.level + 1}</b><span class="mute">${m.xp} / 1,000</span></div>
        <div class="bar" style="margin:8px 0 0"><i data-w="${m.xp / 10}"></i></div></div>
      ${ILL.t}
      <button class="btn" data-go="cap" style="min-height:64px;font-size:18px">Take a photo</button>
      <button class="btn alt" data-act="upload" style="margin-top:10px">Upload from gallery</button>
      <div class="grid g2" style="margin:12px 0"><button class="btn alt" data-go="disc">My discoveries</button><button class="btn alt" data-go="map">Explore map</button>
        <button class="btn alt" data-go="chal">Challenges</button><button class="btn alt" data-go="lead">Leaderboard</button></div>
      <button class="card sp" data-go="chal" style="display:block"><b>This week's challenge</b><div class="mute" style="margin:4px 0 8px">${esc(c.title)}</div><div class="bar"><i data-w="${c.value / c.goal * 100}"></i></div></button>
      <h3 style="margin:8px 0">Recent discoveries</h3>
      ${recent.length ? `<div class="grid g3">${recent.map(speciesTile).join('')}</div>` : '<p class="mute">Nothing yet. Take your first photo to start your collection.</p>'}`;
  },

  cap() {
    return `${backBtn()}<h2>Capture biodiversity</h2><p class="mute" style="margin:4px 0 16px">Take a clear photo of a plant or animal. Videos are welcome too.</p>
      ${errBox()}<button class="btn" data-act="cam" style="min-height:64px;font-size:18px">Take photo</button>
      <button class="btn alt" data-act="upload" style="margin-top:10px">Upload from gallery</button>
      <p class="mute sm" style="margin-top:14px">JPG, PNG or WebP photos up to 12 MB, MP4 or WebM videos up to 40 MB. Hidden location data inside photos is always removed.</p>`;
  },

  prev() {
    const c = S.cap;
    const media = c.files.map((f, i) => f.type.startsWith('video/')
      ? `<div class="photo"><video src="${c.urls[i]}" controls muted playsinline></video></div>`
      : `<div class="photo"><img src="${c.urls[i]}" alt="Your photo ${i + 1}"></div>`).join('');
    return `${backBtn('cap')}<h2>Your photo</h2><div style="margin:10px 0">${media}</div>${errBox()}
      <form data-form="upload" novalidate>
        <div class="card"><div class="row between"><div><b>Location</b><div class="mute sm" id="locState">${c.lat != null ? 'Added. Others only ever see an approximate area.' : 'Optional. Helps researchers map where species live.'}</div></div>
          <button type="button" class="btn sm alt" data-act="locate">${c.lat != null ? 'Update' : 'Add'}</button></div></div>
        <label class="field"><span>Place name <small>(optional)</small></span><input class="input" name="place" maxlength="80" value="${esc(c.place)}" placeholder="e.g. Pond Loop, Taman Hijau"></label>
        <label class="field"><span>Notes <small>(optional)</small></span><textarea class="input" name="notes" maxlength="500" rows="3" placeholder="What was it doing?">${esc(c.notes)}</textarea></label>
        <label class="check"><input type="checkbox" name="share" ${c.share ? 'checked' : ''}><span>Let researchers use this sighting to improve species identification.</span></label>
        <button class="btn" type="submit">Analyze with AI</button></form>`;
  },

  ana: () => `<div style="text-align:center;padding-top:90px"><div class="spinner" role="status"></div><h2 style="margin-top:20px">Uploading and analyzing…</h2>
    <p class="mute" style="margin:8px 0">Your photo is encrypted before it is stored.</p></div>`,

  id() {
    const r = S.result; const sug = r.suggestions; const top = sug[0];
    const pickGrid = `<div class="pick">${S.species.map((s) => `<button class="sp" data-act="manual" data-arg="${esc(s.slug)}"><div class="ph" data-bg="${esc(s.colors[0])},${esc(s.colors[1])}">${speciesIcon(s.kind)}</div><b>${esc(s.name)}</b></button>`).join('')}</div>`;
    const photo = r.observation.media[0]?.thumbUrl ? `<div class="photo"><img src="${esc(r.observation.media[0].thumbUrl)}" alt="Your photo"></div>` : '';
    if (!top || S.arg === 'pick') {
      return `${S.arg === 'pick' ? backBtn('id') : ''}<h2>${top ? "Let's fix it" : 'What did you find?'}</h2>${photo}
        ${top ? '<p class="mute" style="margin:4px 0 12px">Your correction helps researchers train better models.</p>'
          : '<p class="mute" style="margin:4px 0 12px">No identification model is live yet, so choose the species yourself. Researchers will double-check it.</p>'}
        ${errBox()}${pickGrid}<button class="btn alt" data-act="unsure" style="margin-top:14px">I'm not sure — send to researchers</button>`;
    }
    return `<div class="tag NT" style="margin-bottom:8px">AI suggestion</div><h2>Possible match</h2>${photo}
      <div class="card"><h2 style="font-size:20px">${esc(top.species.name)}</h2><i class="mute">${esc(top.species.scientific)}</i>
        <div class="row" style="margin:8px 0">${statusTag(top.species)}<b style="margin-left:auto">${pct(top.confidence)} confident</b></div>
        <div class="bar"><i data-w="${top.confidence * 100}"></i></div>
        <p style="margin-top:10px">${esc(top.species.description)}</p><p class="mute" style="margin-top:6px"><b>Why it matters:</b> ${esc(top.species.why)}</p></div>
      ${sug.length > 1 ? `<div class="card"><b>Other possibilities</b><table>${sug.slice(1).map((s) => `<tr><td>${esc(s.species.name)}</td><td><b>${pct(s.confidence)}</b></td></tr>`).join('')}</table></div>` : ''}
      ${errBox()}<button class="btn" data-act="accept">This looks correct</button>
      <button class="btn alt" data-go-arg="id|pick" style="margin-top:10px">This is incorrect</button>`;
  },

  saved() {
    const x = S.saved; const sp = x.observation.species;
    return `<div class="celebrate"><div style="width:64px;margin:0 auto">${BADGE}</div><h1>Sighting saved</h1><div class="pts">+${x.pointsAwarded} points</div>
      ${x.isFirst ? '<p class="mute">First time you found this species!</p>' : ''}</div>
      ${sp ? `<div class="card"><div class="row"><div style="width:76px;flex:none">${art(sp)}</div><div><b>${esc(sp.name)}</b><div class="mute sm">${x.observation.placeLabel ? esc(x.observation.placeLabel) + '<br>' : ''}Just now</div></div></div>
        <table><tr><td>Verification</td><td><span class="tag pending">${x.observation.shareForResearch ? 'Waiting for researcher review' : 'Private (not shared)'}</span></td></tr></table></div>` : '<div class="card"><b>Saved for review</b><p class="mute sm">Researchers will help identify this one.</p></div>'}
      ${x.unlocked.map((n) => `<div class="card" style="background:var(--warn-bg);text-align:center"><div style="width:44px;margin:0 auto">${BADGE}</div><b>Badge unlocked: ${esc(n)}</b></div>`).join('')}
      <div class="bar"><i data-w="${x.totals.xp / 10}"></i></div><p class="mute sm" style="margin:4px 0 14px">${x.totals.xp} / 1,000 · Level ${x.totals.level}</p>
      ${sp ? `<button class="btn" data-go="sp" data-arg="${esc(sp.slug)}">See in my collection</button>` : ''}
      <button class="btn alt" data-go="home" style="margin-top:10px">Back to home</button>`;
  },

  disc() {
    const n = S.species.filter((s) => s.found).length;
    return `${backBtn()}<h2>My discoveries</h2><div class="card" style="margin:10px 0"><span class="num">${n} / ${S.species.length}</span> species discovered<div class="bar" style="margin-top:8px"><i data-w="${n / S.species.length * 100}"></i></div></div>
      <div class="grid g3">${S.species.map(speciesTile).join('')}</div>`;
  },

  sp() {
    const x = bySlug(S.arg); if (!x) return backBtn('disc') + '<p>Species not found.</p>';
    const mine = S.mine.filter((o) => o.species?.slug === x.slug);
    return `${backBtn('disc')}${art(x, true)}<h1 style="margin-top:10px">${esc(x.name)}</h1><i class="mute">${esc(x.scientific)}</i> ${statusTag(x)}
      <div class="card" style="margin-top:12px"><b>About</b><p>${esc(x.description)}</p><b>Habitat</b><p>${esc(x.habitat)}</p><b>Why it matters</b><p>${esc(x.why)}</p></div>
      <div class="card"><b>Your sightings</b>${x.found ? `<div class="mute" style="margin:4px 0 8px">First found ${fmtDate(x.firstAt)}${x.firstPlace ? ' · ' + esc(x.firstPlace) : ''}<br>Seen <b>${x.count}</b> time${x.count > 1 ? 's' : ''}</div>
        <div class="thumbs">${mine.flatMap((o) => o.media.filter((m) => m.thumbUrl).map((m) => `<img src="${esc(m.thumbUrl)}" alt="Your photo of ${esc(x.name)}" loading="lazy">`)).join('')}</div>`
        : '<div class="mute" style="margin-top:4px">Not discovered yet. Go find one!</div>'}</div>`;
  },

  chal() {
    return `${backBtn()}<h2>Weekly challenges</h2><p class="mute" style="margin:4px 0 12px">Finish challenges to earn bonus points. They reset every Monday.</p>
      ${S.summary.challenges.map((c) => `<div class="card"><div class="row"><b style="flex:1">${esc(c.title)}</b><span class="tag NT">+${c.reward}</span></div>
        <div class="bar" style="margin:8px 0"><i data-w="${c.value / c.goal * 100}"></i></div>
        <div class="row"><span class="mute">${c.value} / ${c.goal}</span>${c.claimed ? '<span class="tag LC" style="margin-left:auto">Reward claimed</span>'
          : `<button class="btn sm" style="margin-left:auto" data-act="claim" data-arg="${c.id}" ${c.ready ? '' : 'disabled'}>Claim reward</button>`}</div></div>`).join('')}`;
  },

  lead() {
    const l = S.lb;
    return `${backBtn()}<h2>Leaderboard</h2><div class="row" style="margin:10px 0"><button class="chip ${S.lbScope === 'community' ? 'on' : ''}" data-act="lb" data-arg="community">${esc(l?.community || 'My community')}</button>
      <button class="chip ${S.lbScope === 'all' ? 'on' : ''}" data-act="lb" data-arg="all">Everyone</button></div>
      <div class="card">${l?.rows.length ? `<table><tr class="mute sm"><td>Rank</td><td>Explorer</td><td>Points</td><td>Species</td></tr>${l.rows.map((r) =>
        `<tr class="${r.me ? 'me' : ''}"><td>${r.rank}</td><td>${esc(r.name)}${r.me ? ' (you)' : ''}</td><td>${r.points}</td><td>${r.species}</td></tr>`).join('')}</table>`
        : '<p class="mute">No one is on the board yet. Save a sighting to be first.</p>'}</div>
      <p class="mute sm">Only display names are shown.</p>`;
  },

  map() {
    const X = (lon) => ((lon - 94) / (142 - 94)) * 600, Y = (lat) => ((8 - lat) / (8 + 12)) * 250;
    const grat = [];
    for (let lon = 95; lon <= 140; lon += 5) grat.push(`<line class="grat" x1="${X(lon)}" x2="${X(lon)}" y1="0" y2="250"/>`);
    for (let lat = -10; lat <= 5; lat += 5) grat.push(`<line class="grat" x1="0" x2="600" y1="${Y(lat)}" y2="${Y(lat)}"/>`);
    const places = [['Sumatra', 101, -0.5], ['Java', 110, -7.3], ['Kalimantan', 114, 0.5], ['Sulawesi', 121, -2.5], ['Nusa Tenggara', 120, -9.3], ['Papua', 137, -4.5]];
    const labels = places.map(([n, lon, lat]) => `<text class="lbl" x="${X(lon)}" y="${Y(lat)}" text-anchor="middle">${n}</text>`).join('');
    const pins = S.mapPins.map((p) => `<circle class="pin" r="8" cx="${X(p.lon)}" cy="${Y(p.lat)}" tabindex="0" role="button" data-go="sp" data-arg="${esc(p.slug)}"><title>${esc(p.name)}</title></circle>`).join('');
    return `<h2>Explore map</h2><div class="row" style="margin:10px 0">${[['all', 'All'], ['animals', 'Animals']].map(([k, n]) =>
      `<button class="chip ${S.mapScope === k ? 'on' : ''}" data-act="mapscope" data-arg="${k}">${n}</button>`).join('')}</div>
      <div class="mapbox"><svg viewBox="0 0 600 250" role="img" aria-label="Your sightings across Indonesia">${grat.join('')}${labels}${pins}</svg></div>
      <p class="mute sm" style="margin:8px 0">${S.mapPins.length ? 'Tap a dot to open the species.' : 'Your sightings with a location will appear here.'}</p>
      <div class="card"><b>Privacy</b><p class="mute sm">Dots show approximate areas, not exact spots. Rare and endangered species are blurred even more, so they stay safe from collectors.</p></div>`;
  },

  prof() {
    const m = S.summary; const u = S.user;
    return `<div class="row"><div class="ph" style="width:72px;flex:none;background:var(--forest);color:#fff;font-size:30px;font-weight:600;aspect-ratio:1">${esc(m.displayName.slice(0, 1).toUpperCase())}</div>
      <div><h2>${esc(m.displayName)}</h2><div class="mute">Level ${m.level} · ${esc(m.community)}</div></div></div>
      <div class="grid g2" style="margin:14px 0">${[[m.points, 'Points'], [m.speciesFound, 'Species'], [m.challengesDone, 'Challenges done'], [m.observations, 'Observations']].map(([n, l]) =>
        `<div class="card" style="margin:0;text-align:center"><div class="num">${n}</div><div class="mute sm">${l}</div></div>`).join('')}</div>
      <h3>Badges</h3><div class="grid g3" style="margin:8px 0 16px">${m.badges.map((b) => `<div class="card badge ${b.earned ? '' : 'off'}" style="margin:0" title="${esc(b.hint)}">${BADGE}<div>${esc(b.name)}</div></div>`).join('')}</div>
      <h3>Privacy & account</h3>
      <div class="card"><label class="check" style="margin:0"><input type="checkbox" data-act="consent" ${u.consentResearch ? 'checked' : ''}><span><b>Share verified sightings with researchers</b><br><span class="mute sm">Used to train species-identification models. Applies to future uploads.</span></span></label></div>
      <form class="card" data-form="profile"><label class="field"><span>Display name</span><input class="input" name="displayName" value="${esc(m.displayName)}" maxlength="30" required></label>
        <label class="field"><span>School or community</span><input class="input" name="community" value="${esc(m.community)}" maxlength="60"></label><button class="btn alt" type="submit">Save changes</button></form>
      <div class="grid" style="margin-top:6px"><button class="btn alt" data-act="export">Download my data</button><button class="btn alt" data-act="pw-dialog">Change password</button>
        <button class="btn alt" data-act="logout">Sign out</button><button class="btn danger" data-act="del-dialog">Delete my account</button></div>
      <p class="mute sm" style="margin-top:14px;text-align:center">Deleting removes your account, photos, videos and locations permanently.</p>`;
  }
};

// ---------------------------------------------------------------- navigation & data
const NAV_ITEMS = [['home', 'Home'], ['disc', 'Discover'], ['cap', 'Camera'], ['map', 'Map'], ['prof', 'Profile']];
const NAV_GROUP = { home: 'home', disc: 'disc', sp: 'disc', map: 'map', prof: 'prof', cap: 'cap', prev: 'cap', id: 'cap', saved: 'cap', chal: 'home', lead: 'home' };

const loadSummary = async () => { S.summary = await get('/api/play/summary'); };
const loadSpecies = async () => { S.species = (await get('/api/play/species')).species; };
const LOADERS = {
  home: () => Promise.all([loadSummary(), loadSpecies()]),
  disc: loadSpecies, chal: loadSummary, prof: loadSummary,
  sp: async () => { await loadSpecies(); S.mine = (await get('/api/observations')).observations; },
  lead: async () => { S.lb = await get('/api/play/leaderboard?scope=' + S.lbScope); },
  map: async () => { S.mapPins = (await get('/api/play/map?scope=' + S.mapScope)).pins; }
};

function render() {
  screen.innerHTML = V[S.view]();
  hydrate(screen);
  const nav = $('#nav');
  const showNav = !['boot', 'auth', 'ob', 'ana'].includes(S.view);
  nav.hidden = !showNav;
  if (showNav) {
    nav.innerHTML = NAV_ITEMS.map(([k, n]) => `<button class="${k === 'cap' ? 'cam' : ''} ${NAV_GROUP[S.view] === k ? 'on' : ''}" data-go="${k}" ${NAV_GROUP[S.view] === k ? 'aria-current="page"' : ''}><span>${NAV[k]}</span>${n}</button>`).join('');
  }
}

async function go(view, arg = null) {
  if (S.view === 'prev' && view !== 'prev' && view !== 'ana') clearCapture(false);
  S.view = view; S.arg = arg; S.err = '';
  try { await LOADERS[view]?.(); } catch (e) { if (e.status === 401) return showAuth(); toast(e.message); }
  render(); window.scrollTo(0, 0); screen.focus({ preventScroll: true });
}

function showAuth(msg = '') { S.user = null; S.err = msg; S.view = 'auth'; render(); }

function clearCapture(keepPrefs = true) {
  S.cap.urls.forEach((u) => URL.revokeObjectURL(u));
  S.cap = { files: [], urls: [], lat: null, lon: null, notes: '', place: '', share: keepPrefs ? S.user.consentResearch : false };
}

// ---------------------------------------------------------------- file picking
function onFiles(input) {
  const files = [...input.files]; input.value = '';
  if (!files.length) return;
  if (files.length > 3) return toast('You can add up to 3 files at once.');
  for (const f of files) {
    const video = f.type.startsWith('video/');
    if (!(video ? ['video/mp4', 'video/webm'] : ['image/jpeg', 'image/png', 'image/webp']).includes(f.type)) return toast('Use a JPG, PNG or WebP photo, or an MP4 or WebM video.');
    if (f.size > (video ? 40 : 12) * 1048576) return toast(video ? 'Videos can be up to 40 MB.' : 'Photos can be up to 12 MB.');
  }
  if (!files.some((f) => f.type.startsWith('image/'))) return toast('Please include at least one photo.');
  clearCapture();
  S.cap.files = files; S.cap.urls = files.map((f) => URL.createObjectURL(f)); S.cap.share = S.user.consentResearch;
  go('prev');
}
$('#fileCam').addEventListener('change', (e) => onFiles(e.target));
$('#fileGal').addEventListener('change', (e) => onFiles(e.target));

// ---------------------------------------------------------------- actions
const ACTIONS = {
  tab: (a) => { S.authTab = a; S.err = ''; render(); },
  'next-ob': () => { S.ob++; render(); },
  onboarded: async () => { post('/api/me/onboarded').catch(() => {}); S.user.onboarded = true; await go('home'); },
  cam: () => $('#fileCam').click(),
  upload: () => $('#fileGal').click(),
  locate: () => {
    if (!navigator.geolocation) return toast('Location is not available on this device.');
    const btn = $('[data-act="locate"]'); btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { S.cap.lat = p.coords.latitude; S.cap.lon = p.coords.longitude; keepFormValues(); render(); toast('Location added.'); },
      () => { btn.disabled = false; toast('Could not get your location. You can still upload without it.'); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  },
  accept: () => confirmId({ choice: 'accept_ai' }),
  manual: (slug) => confirmId({ choice: 'manual', speciesSlug: slug }),
  unsure: () => confirmId({ choice: 'unsure' }),
  claim: async (id) => {
    try { await post(`/api/play/challenges/${id}/claim`); toast('Reward claimed!'); await go('chal'); } catch (e) { toast(e.message); }
  },
  lb: async (scope) => { S.lbScope = scope; await go('lead'); },
  mapscope: async (scope) => { S.mapScope = scope; await go('map'); },
  consent: async (_, el) => {
    const on = el.checked; let applyToExisting = false;
    if (!on) applyToExisting = confirm('Also remove your existing sightings from the research dataset?\n\nModels that were already trained cannot be undone.');
    try { await patch('/api/me/consent', { research: on, applyToExisting }); S.user.consentResearch = on; toast(on ? 'Thanks for helping researchers.' : 'Sharing turned off.'); }
    catch (e) { el.checked = !on; toast(e.message); }
  },
  export: async () => {
    try {
      const res = await fetch('/api/me/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not export your data.');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: 'bioquest-my-data.json' }); a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast(e.message); }
  },
  logout: async () => { await post('/api/auth/logout').catch(() => {}); S.user = null; S.authTab = 'login'; showAuth(); },
  'pw-dialog': () => openDialog(`<h3>Change password</h3><form data-form="password" novalidate style="margin-top:12px"><p class="error" hidden role="alert"></p>
    <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
    <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="12" required><span class="hint">At least 12 characters. You will be signed out on other devices.</span></label>
    <div class="grid g2"><button class="btn alt" type="button" data-act="close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`),
  'del-dialog': () => openDialog(`<h3>Delete your account?</h3><p class="mute" style="margin:8px 0 12px">This permanently deletes your account, photos, videos and locations. It cannot be undone.</p>
    <form data-form="delete" novalidate><p class="error" hidden role="alert"></p><label class="field"><span>Confirm with your password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
    <div class="grid g2"><button class="btn alt" type="button" data-act="close">Keep account</button><button class="btn danger" type="submit">Delete forever</button></div></form>`),
  close: () => $('#dlg').close()
};

function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; d.showModal(); }
function keepFormValues() {
  const f = $('form[data-form="upload"]'); if (!f) return;
  S.cap.notes = f.notes.value; S.cap.place = f.place.value; S.cap.share = f.share.checked;
}

async function confirmId(body) {
  if (S.busy) return; S.busy = true;
  try {
    S.saved = await post(`/api/observations/${S.result.observation.id}/identify`, body);
    S.summary = null; await loadSpecies().catch(() => {});
    S.busy = false; await go('saved');
  } catch (e) { S.busy = false; S.err = e.message; render(); }
}

// ---------------------------------------------------------------- forms
const FORMS = {
  async login(f) {
    const r = await post('/api/auth/login', { email: f.email.value, password: f.password.value });
    if (r.user.role === 'researcher') { location.href = '/research'; return; }
    await afterAuth(r.user);
  },
  async register(f) {
    const r = await post('/api/auth/register', {
      email: f.email.value, password: f.password.value, displayName: f.displayName.value, community: f.community.value || undefined,
      consentResearch: f.consentResearch.checked, acceptTerms: f.acceptTerms.checked
    });
    S.ob = 0; await afterAuth(r.user);
  },
  async upload(f) {
    keepFormValues();
    const fd = new FormData();
    S.cap.files.forEach((file) => fd.append('files', file));
    if (S.cap.lat != null) { fd.append('lat', S.cap.lat); fd.append('lon', S.cap.lon); }
    if (S.cap.notes) fd.append('notes', S.cap.notes);
    if (S.cap.place) fd.append('placeLabel', S.cap.place);
    fd.append('consentResearch', String(S.cap.share));
    S.view = 'ana'; render();
    try { S.result = await api('POST', '/api/observations', fd); clearCapture(); await go('id'); }
    catch (e) { S.view = 'prev'; S.err = e.message; render(); }
  },
  async profile(f) {
    await patch('/api/me/profile', { displayName: f.displayName.value, community: f.community.value });
    S.user.community = f.community.value; toast('Profile saved.'); await go('prof');
  },
  async password(f) {
    await post('/api/auth/password', { current: f.current.value, next: f.next.value });
    $('#dlg').close(); toast('Password changed.');
  },
  async delete(f) {
    await del('/api/me', { password: f.password.value });
    $('#dlg').close(); S.user = null; showAuth('Your account was deleted.');
  }
};

async function afterAuth(user) {
  S.user = user; S.err = '';
  S.cap.share = user.consentResearch;
  await Promise.all([loadSummary(), loadSpecies()]);
  await go(user.onboarded ? 'home' : 'ob');
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go],[data-act],[data-go-arg]'); if (!t) return;
  if (t.matches('input[type=checkbox]')) return;
  if (t.dataset.go) { go(t.dataset.go, t.dataset.arg ?? null); return; }
  if (t.dataset.goArg) { const [v, a] = t.dataset.goArg.split('|'); go(v, a); return; }
  if (t.dataset.act === 'consent') return;
  ACTIONS[t.dataset.act]?.(t.dataset.arg, t);
});
document.addEventListener('change', (e) => { if (e.target.dataset.act === 'consent') ACTIONS.consent(null, e.target); });
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('circle[data-go]')) { e.preventDefault(); go(e.target.dataset.go, e.target.dataset.arg); }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault();
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const kind = form.dataset.form;
  const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
  try { await FORMS[kind](form); }
  catch (err) {
    if (btn) btn.disabled = false;
    const msg = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
    inlineError(form, msg);
  }
});
function inlineError(form, msg) {
  let p = $('.error', form);
  if (!p) { p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); form.prepend(p); }
  p.textContent = msg; p.hidden = false; // typed values (and passwords) stay in the fields
}

// ---------------------------------------------------------------- boot
(async function boot() {
  render();
  try {
    const me = await get('/api/auth/me');
    if (!me.user) return showAuth();
    if (me.user.role === 'researcher') { location.replace('/research'); return; }
    setCsrf(me.csrfToken);
    await afterAuth(me.user);
  } catch { showAuth('We could not reach the server. Check your connection and refresh.'); }
})();
