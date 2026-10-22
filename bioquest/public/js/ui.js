// Safe rendering helpers. Every dynamic value goes through esc(); inline styles
// (not allowed by our Content-Security-Policy) are applied by hydrate() instead.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** data-w="62" -> width:62% ; data-bg="#aaa,#bbb" -> gradient ; data-h="40" -> height:40% */
export function hydrate(root = document) {
  for (const el of $$('[data-w]', root)) el.style.width = el.dataset.w + '%';
  for (const el of $$('[data-h]', root)) el.style.height = el.dataset.h + '%';
  for (const el of $$('[data-bg]', root)) {
    const [a, b] = el.dataset.bg.split(',');
    if (/^#[0-9a-f]{3,8}$/i.test(a) && /^#[0-9a-f]{3,8}$/i.test(b || a)) el.style.background = `linear-gradient(135deg,${a},${b || a})`;
  }
  for (const el of $$('[data-fill]', root)) if (/^#[0-9a-f]{3,8}$/i.test(el.dataset.fill)) el.style.background = el.dataset.fill;
}

export function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

export const fmtDate = (d, opts = { dateStyle: 'medium' }) => new Date(d).toLocaleDateString(undefined, opts);
export const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const pct = (n) => Math.round(n * 100) + '%';
export const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
