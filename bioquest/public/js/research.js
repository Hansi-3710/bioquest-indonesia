import { get, post, setCsrf, ApiError } from './api.js';
import { esc, $, hydrate, toast, fmtDateTime, pct, bytes } from './ui.js';
import { LOGO } from './icons.js';

const root = $('#root');
const S = { user: null, view: 'overview', gate: 'login', qr: null, err: '', data: {}, tab: 'pending', page: 1, species: [], min: 20, poll: null, busy: false };

const VIEWS = [
  ['overview', 'Overview'], ['review', 'Review queue'], ['dataset', 'Dataset'],
  ['training', 'Train a model'], ['models', 'Models'], ['activity', 'Activity log']
];

// ------------------------------------------------------------------ gate (sign in + two-factor)
function gate() {
  const errBox = S.err ? `<p class="error" role="alert">${esc(S.err)}</p>` : '';
  let body;
  if (S.gate === 'login') {
    body = `<h1 style="font-size:22px;margin:10px 0 4px">Researcher sign in</h1><p class="mute sm" style="margin-bottom:18px">For approved BioQuest researchers. Two-factor verification is required.</p>${errBox}
      <form data-form="login" novalidate><label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Continue</button></form>
      <p class="mute sm" style="margin-top:16px">Citizen scientist? <a href="/">Go to the BioQuest app</a></p>`;
  } else if (S.gate === 'setup') {
    body = `<h1 style="font-size:22px;margin:10px 0 4px">Set up two-factor</h1><p class="mute sm">Scan this code with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
      ${S.qr ? `<img class="qr" src="${esc(S.qr.qr)}" width="220" height="220" alt="QR code for your authenticator app"><p class="mute sm">Can't scan? Enter this key manually:</p><div class="secret">${esc(S.qr.secret)}</div>` : '<div class="spinner"></div>'}
      ${errBox}<form data-form="mfa" novalidate style="margin-top:16px"><label class="field"><span>6-digit code</span><input class="input codebox" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required></label><button class="btn" type="submit">Turn on and continue</button></form>`;
  } else {
    body = `<h1 style="font-size:22px;margin:10px 0 4px">Enter your code</h1><p class="mute sm" style="margin-bottom:18px">Open your authenticator app and enter the current 6-digit code.</p>${errBox}
      <form data-form="mfa" novalidate><label class="field"><span>6-digit code</span><input class="input codebox" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required autofocus></label><button class="btn" type="submit">Verify</button></form>
      <p class="mute sm" style="margin-top:16px">Lost your device? Ask an administrator to reset two-factor for your account.</p>`;
  }
  root.innerHTML = `<main class="gate"><div class="row" style="gap:10px">${LOGO}<b style="font-size:18px">BioQuest Research</b></div><div class="panel" style="margin-top:14px">${body}</div></main>`;
}

// ------------------------------------------------------------------ shell
function shell(content) {
  const pending = S.data.overview?.totals.pending ?? 0;
  root.innerHTML = `<div class="layout"><aside class="side"><div class="brand">${LOGO}<div>BioQuest<small>Research dashboard</small></div></div>
    <nav aria-label="Dashboard">${VIEWS.map(([k, n]) => `<button class="nav ${S.view === k ? 'on' : ''}" data-view="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${n}${k === 'review' && pending ? `<span class="count">${pending}</span>` : ''}</button>`).join('')}</nav>
    <div class="who">Signed in as<br><b>${esc(S.user.displayName)}</b><br><button data-act="pw">Change password</button> <button data-act="logout">Sign out</button></div></aside>
    <main class="main" id="main" tabindex="-1">${content}</main></div>`;
  hydrate(root);
}

const loading = () => '<div style="padding:80px 0"><div class="spinner" role="status" aria-label="Loading"></div></div>';

// ------------------------------------------------------------------ views
function barChart(days) {
  const W = 640, H = 170, pad = 24, max = Math.max(4, ...days.map((d) => d.n));
  const bw = (W - pad) / days.length;
  const bars = days.map((d, i) => { const h = (d.n / max) * (H - 34); return `<rect class="bar-r" x="${pad + i * bw + 2}" y="${H - 20 - h}" width="${bw - 4}" height="${Math.max(h, d.n ? 2 : 0)}" rx="2"><title>${d.day}: ${d.n}</title></rect>`; }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sightings per day, last 30 days"><line class="grid-l" x1="${pad}" x2="${W}" y1="${H - 20}" y2="${H - 20}"/>
    <text x="0" y="14">${max}</text><text x="${pad}" y="${H - 4}">${days[0].day.slice(5)}</text><text x="${W}" y="${H - 4}" text-anchor="end">${days[days.length - 1].day.slice(5)}</text>${bars}</svg>`;
}

function cellMap(cells) {
  const X = (lon) => ((lon - 94) / 48) * 600, Y = (lat) => ((8 - lat) / 20) * 250; const max = Math.max(1, ...cells.map((c) => c.n));
  const g = []; for (let lon = 95; lon <= 140; lon += 5) g.push(`<line class="grid-l" x1="${X(lon)}" x2="${X(lon)}" y1="0" y2="250"/>`);
  for (let lat = -10; lat <= 5; lat += 5) g.push(`<line class="grid-l" x1="0" x2="600" y1="${Y(lat)}" y2="${Y(lat)}"/>`);
  const dots = cells.map((c) => `<circle class="dot" cx="${X(c.lon)}" cy="${Y(c.lat)}" r="${5 + (c.n / max) * 14}"><title>${c.n} sighting${c.n > 1 ? 's' : ''} near ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 600 250" role="img" aria-label="Where sightings were recorded, grouped into grid cells">${g.join('')}${dots}</svg>`;
}

const V = {
  async overview() {
    const o = S.data.overview = await get('/api/research/overview'); const t = o.totals;
    return `<h1>Overview</h1><p class="lead">Only sightings whose owners agreed to share them for research are counted here.</p>
      <div class="tiles"><div class="tile ${t.pending ? 'alert' : ''}"><b>${t.pending}</b><span>Waiting for review</span></div><div class="tile"><b>${t.verified}</b><span>Verified sightings</span></div>
        <div class="tile"><b>${t.total}</b><span>Shared sightings</span></div><div class="tile"><b>${t.contributors}</b><span>Contributors</span></div>
        <div class="tile"><b>${bytes(o.media.bytes)}</b><span>${o.media.files} encrypted files</span></div></div>
      <div class="two"><section class="panel"><h2>Sightings per day (last 30 days)</h2>${barChart(o.daily)}</section>
        <section class="panel"><h2>Identification model</h2>${o.activeModel
          ? `<p><b>Version ${o.activeModel.version}</b> is live in the app.</p><p class="mute sm">Validation accuracy: <b>${o.activeModel.metrics?.val_accuracy != null ? pct(o.activeModel.metrics.val_accuracy) : 'n/a'}</b></p>`
          : '<p>No model is live yet, so citizen scientists choose species themselves.</p><button class="btn sm" data-view="training" style="margin-top:10px;width:auto">Train the first model</button>'}</section></div>
      <section class="panel"><h2>Where sightings come from</h2>${o.cells.length ? cellMap(o.cells) : '<p class="mute">No locations recorded yet.</p>'}
        <p class="mute sm" style="margin-top:6px">Grouped into grid cells of about 11 km (55 km for protected species). Exact points are only visible per sighting, and each view is logged.</p></section>`;
  },

  async review() {
    if (!S.species.length) S.species = (await get('/api/research/dataset')).species;
    const r = await get(`/api/research/observations?status=${S.tab}&page=${S.page}`);
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    return `<h1>Review queue</h1><p class="lead">Confirm or correct each identification. Verified photos become training data.</p>
      <div class="tabs" role="tablist">${['pending', 'verified', 'rejected'].map((s) => `<button role="tab" class="${S.tab === s ? 'on' : ''}" data-act="tab" data-arg="${s}">${s[0].toUpperCase() + s.slice(1)}${S.tab === s ? ` (${r.total})` : ''}</button>`).join('')}</div>
      ${r.observations.length ? `<div class="cards">${r.observations.map((o) => `<button class="obs" data-act="open" data-arg="${o.id}">
        <div class="im">${o.thumb ? `<img src="${esc(o.thumb)}" alt="" loading="lazy">` : 'Video only'}</div>
        <div class="meta"><b>${esc(o.species?.name ?? 'Unidentified')}</b>${o.ai ? `<span class="mute">AI: ${esc(o.ai.name)} ${pct(o.ai.confidence)}</span><br>` : ''}
        <span class="mute">${fmtDateTime(o.observedAt)}</span></div></button>`).join('')}</div>`
        : `<div class="panel"><p>${S.tab === 'pending' ? 'All caught up. New sightings will appear here.' : 'Nothing here yet.'}</p></div>`}
      ${pages > 1 ? `<div class="pager"><button class="btn sm alt" data-act="page" data-arg="${S.page - 1}" ${S.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${S.page} of ${pages}</span><button class="btn sm alt" data-act="page" data-arg="${S.page + 1}" ${S.page >= pages ? 'disabled' : ''}>Next</button></div>` : ''}`;
  },

  async dataset() {
    const d = S.data.dataset = await get(`/api/research/dataset?min=${S.min}`);
    return `<h1>Dataset</h1><p class="lead">Training uses verified photos from users who opted in. A species needs enough examples before a model can learn it.</p>
      <div class="tiles"><div class="tile"><b>${d.readyClasses}</b><span>Species ready to train</span></div><div class="tile"><b>${d.readyImages}</b><span>Images in ready species</span></div></div>
      <section class="panel"><div class="row between"><h2 style="margin:0">Photos per species</h2><div class="row"><label class="row sm" for="min">Minimum per species
        <input class="input" id="min" type="number" min="2" max="1000" value="${S.min}" style="width:90px;min-height:38px"></label>
        <a class="btn sm alt" style="width:auto;text-decoration:none" href="/api/research/dataset/manifest.csv" download>Download manifest (CSV)</a></div></div>
      <div class="scroll"><table class="data" style="margin-top:12px"><thead><tr><th>Species</th><th>Group</th><th>Verified photos</th><th style="width:30%">Progress</th><th>Waiting</th></tr></thead><tbody>
      ${d.species.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.kind)}</td><td>${s.verifiedImages}</td><td><div class="bar"><i data-w="${Math.min(100, s.verifiedImages / d.min * 100)}"></i></div></td><td>${s.pending}</td></tr>`).join('')}</tbody></table></div>
      <p class="mute sm" style="margin-top:10px">The manifest has no names, emails or exact locations: only an image id, an anonymous sighting reference, the species and an approximate grid cell.</p></section>`;
  },

  async training() {
    const [d, t] = await Promise.all([get(`/api/research/dataset?min=${S.min}`), get('/api/research/training')]);
    S.data.training = t;
    const active = t.jobs.some((j) => ['queued', 'running'].includes(j.status));
    schedulePoll(active);
    return `<h1>Train a model</h1><p class="lead">Fine-tune an image classifier on the verified dataset. Training runs on a separate worker with read-only access to consented, verified photos only.</p>
      ${d.canTrain ? `<div class="callout info">${d.readyClasses} species and ${d.readyImages} images are ready.</div>` : `<div class="callout">Not enough data yet: at least 2 species need ${S.min}+ verified photos. Right now ${d.readyClasses} qualify. <a href="#" data-view="review">Review pending sightings</a></div>`}
      <section class="panel"><h2>New training run</h2><form data-form="train" novalidate><div class="form-grid">
        <label class="field"><span>Model</span><select class="input" name="arch"><option value="mobilenet_v3_small">MobileNetV3 Small (fast, light)</option><option value="efficientnet_b0">EfficientNet-B0 (balanced)</option><option value="resnet18">ResNet-18 (robust baseline)</option></select></label>
        <label class="field"><span>Epochs</span><input class="input" type="number" name="epochs" min="1" max="60" value="12"></label>
        <label class="field"><span>Min. photos per species</span><input class="input" type="number" name="minPerClass" min="2" max="1000" value="${S.min}"></label>
        <label class="field"><span>Validation share</span><select class="input" name="valSplit"><option value="0.15">15%</option><option value="0.2" selected>20%</option><option value="0.3">30%</option></select></label>
        <label class="field"><span>Image size</span><select class="input" name="imageSize"><option value="160">160 px</option><option value="224" selected>224 px</option><option value="256">256 px</option></select></label>
        <label class="field"><span>Learning rate</span><input class="input" type="number" name="learningRate" step="any" min="0.00001" max="0.1" value="0.0003"></label></div>
        <label class="check"><input type="checkbox" name="pretrained" checked><span>Start from ImageNet pretrained weights (recommended for small datasets)</span></label>
        <button class="btn" style="width:auto" type="submit" ${d.canTrain && !active ? '' : 'disabled'}>Start training</button></form></section>
      <section class="panel"><h2>Training runs</h2>${t.jobs.length ? t.jobs.map(job).join('') : '<p class="mute">No runs yet.</p>'}</section>`;
  },

  async models() {
    const { models } = await get('/api/research/models');
    return `<h1>Models</h1><p class="lead">The active model powers the AI suggestions citizen scientists see. Check accuracy before activating.</p>
      <section class="panel">${models.length ? `<div class="scroll"><table class="data"><thead><tr><th>Version</th><th>Architecture</th><th>Species</th><th>Validation accuracy</th><th>Trained</th><th></th></tr></thead><tbody>
      ${models.map((m) => `<tr><td><b>v${m.version}</b> ${m.active ? '<span class="pill succeeded">Live</span>' : ''}</td><td>${esc(m.arch)}</td><td>${m.classes}</td><td>${m.metrics?.val_accuracy != null ? pct(m.metrics.val_accuracy) : 'n/a'}</td><td>${fmtDateTime(m.created_at)}</td>
      <td>${m.active ? '<button class="btn sm alt" data-act="deactivate">Turn off</button>' : `<button class="btn sm" data-act="activate" data-arg="${m.id}">Make live</button>`}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="mute">No trained models yet. Start a run under “Train a model”.</p>'}</section>`;
  },

  async activity() {
    const { events } = await get('/api/research/activity');
    return `<h1>Activity log</h1><p class="lead">Every research action is written to a tamper-evident audit log: who viewed which sighting, exported data, or changed a model.</p>
      <section class="panel"><div class="scroll"><table class="data"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${fmtDateTime(e.at)}</td><td>${esc(e.actor ?? 'system')}</td><td>${esc(e.action)}</td><td class="mute sm">${esc((e.target ?? '').slice(0, 8))}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">Nothing yet.</td></tr>'}</tbody></table></div></section>`;
  }
};

function job(j) {
  const m = j.metrics;
  return `<div class="job"><div class="row between"><div><span class="pill ${esc(j.status)}">${esc(j.status)}</span> <b>${esc(j.params.arch)}</b> <span class="mute sm">· ${j.params.epochs} epochs · ${j.datasetSize ?? '?'} images · by ${esc(j.requestedBy)}</span></div>
    <div class="row"><span class="mute sm">${fmtDateTime(j.created_at)}</span>${['queued', 'running'].includes(j.status) ? `<button class="btn sm alt" data-act="cancel" data-arg="${j.id}">Cancel</button>` : ''}</div></div>
    ${['queued', 'running'].includes(j.status) ? `<div class="bar" style="margin:10px 0 0"><i data-w="${Math.round(j.progress * 100)}"></i></div>` : ''}
    ${m ? `<p style="margin-top:8px">Validation accuracy <b>${pct(m.val_accuracy)}</b> · top-3 <b>${pct(m.top3_accuracy)}</b>${j.modelVersion ? ` · saved as <b>model v${j.modelVersion}</b>` : ''}</p>` : ''}
    ${j.log_tail ? `<div class="log" tabindex="0" aria-label="Training log">${esc(j.log_tail)}</div>` : ''}</div>`;
}

function schedulePoll(on) {
  clearInterval(S.poll); S.poll = null;
  if (on) S.poll = setInterval(() => { if (S.view === 'training' && !document.hidden && !$('#dlg').open) render(true); }, 5000);
}

// ------------------------------------------------------------------ detail dialog
async function openObservation(id) {
  const dlg = $('#dlg'); dlg.className = 'big'; dlg.innerHTML = loading(); dlg.showModal();
  try {
    const o = await get(`/api/research/observations/${id}`);
    const img = o.media.find((m) => m.kind === 'image');
    const first = o.media[0];
    dlg.innerHTML = `<div class="row between"><h2>Sighting review</h2><button class="btn sm alt" data-act="close" aria-label="Close">Close</button></div>
      <div class="viewer" style="margin-top:12px"><div id="stage">${first.kind === 'video' ? `<video src="${esc(first.url)}" controls playsinline></video>` : `<img src="${esc(first.url)}" alt="Submitted photo">`}
        ${o.media.length > 1 ? `<div class="strip">${o.media.map((m) => m.kind === 'image' ? `<img src="${esc(m.thumbUrl)}" alt="" data-act="stage" data-arg="${esc(m.url)}">` : `<button class="btn sm alt" data-act="stage-video" data-arg="${esc(m.url)}" style="width:auto">Video</button>`).join('')}</div>` : ''}</div>
      <div><span class="pill ${esc(o.status)}">${esc(o.status)}</span>
        <dl class="kv"><dt>Observed</dt><dd>${fmtDateTime(o.observedAt)}</dd><dt>Place</dt><dd>${esc(o.place || '—')}</dd>
          <dt>Area</dt><dd>${o.cell ? `${o.cell.lat.toFixed(2)}, ${o.cell.lon.toFixed(2)} <span class="mute">(approx.)</span>` : '—'}${o.hasExactLocation ? ` <button class="btn sm alt" style="width:auto;min-height:30px;padding:2px 10px" data-act="exact" data-arg="${o.id}">Show exact</button><span id="exact"></span>` : ''}</dd>
          <dt>Citizen's ID</dt><dd>${o.species ? esc(o.species.name) : 'Not sure'}${o.species?.sensitive ? ' <span class="pill failed">Protected species</span>' : ''}</dd>
          <dt>AI suggestion</dt><dd>${o.ai ? `${esc(o.ai.name)} (${pct(o.ai.confidence)})` : 'None'}</dd><dt>Notes</dt><dd>${esc(o.notes || '—')}</dd></dl>
        <form data-form="review" data-id="${o.id}" novalidate><label class="field"><span>Correct species</span><select class="input" name="species"><option value="">Choose…</option>
          ${S.species.map((s) => `<option value="${esc(s.slug)}" ${(o.species?.slug ?? o.ai?.slug) === s.slug ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
          <p class="error" hidden role="alert"></p>
          <div class="row"><button class="btn" style="width:auto" type="submit" data-decision="verify" ${o.status === 'verified' ? 'disabled' : ''}>Verify</button>
          <button class="btn alt" style="width:auto" type="submit" data-decision="reject" ${o.status === 'rejected' ? 'disabled' : ''}>Reject (unusable photo)</button></div></form></div></div>`;
  } catch (e) { dlg.innerHTML = `<p class="error">${esc(e.message)}</p><button class="btn sm alt" data-act="close">Close</button>`; }
}

// ------------------------------------------------------------------ render & events
async function render(quiet = false) {
  if (!S.user) return gate();
  if (!quiet) { shell(loading()); }
  try {
    const html = await V[S.view]();
    if (!S.data.overview && S.view !== 'overview') get('/api/research/overview').then((o) => { S.data.overview = o; }).catch(() => {});
    shell(html);
    if (!quiet) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
  } catch (e) { if (e.status === 401) return reauth(); shell(`<p class="error">${esc(e.message)}</p>`); }
}

function reauth() { S.user = null; S.gate = 'login'; S.err = 'Your session ended. Please sign in again.'; gate(); }

const ACT = {
  logout: async () => { await post('/api/auth/logout').catch(() => {}); S.user = null; S.gate = 'login'; S.err = ''; gate(); },
  pw: () => { const d = $('#dlg'); d.className = ''; d.innerHTML = `<h2>Change password</h2><form data-form="password" novalidate style="margin-top:12px"><p class="error" hidden role="alert"></p>
    <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
    <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="12" required><span class="hint">At least 12 characters. Other devices are signed out.</span></label>
    <div class="row"><button class="btn alt" style="width:auto" type="button" data-act="close">Cancel</button><button class="btn" style="width:auto" type="submit">Save</button></div></form>`; d.showModal(); },
  tab: (t) => { S.tab = t; S.page = 1; render(); },
  page: (p) => { S.page = Number(p); render(); },
  open: openObservation,
  close: () => $('#dlg').close(),
  stage: (url) => { $('#stage img, #stage video').outerHTML = `<img src="${esc(url)}" alt="Submitted photo">`; },
  'stage-video': (url) => { $('#stage img, #stage video').outerHTML = `<video src="${esc(url)}" controls playsinline></video>`; },
  exact: async (id) => {
    try { const l = await get(`/api/research/observations/${id}/location`); $('#exact').textContent = ` ${l.lat.toFixed(5)}, ${l.lon.toFixed(5)} (logged)`; }
    catch (e) { toast(e.message); }
  },
  activate: async (id) => { try { await post(`/api/research/models/${id}/activate`); toast('Model is now live.'); render(); } catch (e) { toast(e.message); } },
  deactivate: async () => { if (confirm('Turn off AI suggestions? Citizen scientists will pick species manually.')) { await post('/api/research/models/deactivate'); render(); } },
  cancel: async (id) => { try { await post(`/api/research/training/${id}/cancel`); render(); } catch (e) { toast(e.message); } }
};

const FORMS = {
  async login(f) {
    const r = await post('/api/auth/login', { email: f.email.value, password: f.password.value });
    if (r.user.role !== 'researcher') { await post('/api/auth/logout').catch(() => {}); throw new ApiError('This account does not have researcher access. Use the BioQuest app instead.', 403); }
    S.user = r.user; S.err = '';
    if (r.mfa === 'setup') { S.gate = 'setup'; S.qr = null; gate(); S.qr = await post('/api/auth/mfa/setup'); gate(); }
    else if (r.mfa === 'verify') { S.gate = 'verify'; gate(); $('.codebox')?.focus(); }
    else { await start(); }
  },
  async mfa(f) { await post('/api/auth/mfa/verify', { code: f.code.value.trim() }); S.err = ''; await start(); },
  async password(f) { await post('/api/auth/password', { current: f.current.value, next: f.next.value }); $('#dlg').close(); toast('Password changed.'); },
  async train(f) {
    const n = (k) => Number(f[k].value);
    await post('/api/research/training', { arch: f.arch.value, epochs: n('epochs'), minPerClass: n('minPerClass'), valSplit: n('valSplit'), imageSize: n('imageSize'), learningRate: n('learningRate'), pretrained: f.pretrained.checked });
    toast('Training queued. The worker will pick it up shortly.'); render();
  },
  async review(f, submitter) {
    const decision = submitter?.dataset.decision;
    await post(`/api/research/observations/${f.dataset.id}/review`, { decision, speciesSlug: f.species.value || undefined });
    $('#dlg').close(); toast(decision === 'verify' ? 'Verified.' : 'Rejected.'); S.data.overview = null; render();
  }
};

async function start() {
  const me = await get('/api/auth/me'); setCsrf(me.csrfToken);
  if (me.mfa) { S.gate = me.mfa; gate(); return; }
  S.user = me.user; S.view = 'overview'; render();
}

document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]'); if (v) { e.preventDefault(); S.view = v.dataset.view; S.page = 1; S.data.overview = S.data.overview; render(); return; }
  const t = e.target.closest('[data-act]'); if (t) ACT[t.dataset.act]?.(t.dataset.arg, t);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'min') { S.min = Math.min(1000, Math.max(2, Number(e.target.value) || 20)); render(); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const btns = f.querySelectorAll('button[type=submit]'); btns.forEach((b) => { b.disabled = true; });
  try { await FORMS[f.dataset.form](f, e.submitter); }
  catch (err) {
    btns.forEach((b) => { b.disabled = false; });
    const msg = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
    if (['review', 'password'].includes(f.dataset.form)) { const p = f.querySelector('.error'); p.textContent = msg; p.hidden = false; }
    else if (f.dataset.form === 'train') toast(msg);
    else { S.err = msg; if (f.dataset.form === 'login') S.gate = 'login'; gate(); }
  }
});

(async function boot() {
  try {
    const me = await get('/api/auth/me');
    if (!me.user) return gate();
    if (me.user.role !== 'researcher') { location.replace('/'); return; }
    setCsrf(me.csrfToken); S.user = me.user;
    if (me.mfa) { S.gate = me.mfa; if (me.mfa === 'setup') { gate(); S.qr = await post('/api/auth/mfa/setup'); } gate(); return; }
    render();
  } catch { S.err = 'Could not reach the server.'; gate(); }
})();
