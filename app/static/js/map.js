(function () {
  const box = document.getElementById('map');
  const map = makeMap('map');
  if (!map) return;
  const layer = L.layerGroup().addTo(map);
  let scope = box.dataset.scope;

  function popup(o) {
    const d = el('div', 'popup');
    d.appendChild(el('b', null, o.species));
    if (o.sci) d.appendChild(el('div', 'muted', o.sci));
    d.appendChild(el('div', null, new Date(o.ts * 1000).toLocaleString()));
    d.appendChild(el('span', 'tag ' + o.status, o.status));
    if (o.blurred) d.appendChild(el('div', 'muted', 'Approximate location (protected species)'));
    if (o.media) { const i = el('img'); i.src = '/media/' + encodeURIComponent(o.media); i.alt = o.species; d.appendChild(i); }
    return d;
  }

  async function refresh() {
    try {
      const data = await api('/api/map?scope=' + encodeURIComponent(scope));
      layer.clearLayers();
      data.observations.forEach(o => {
        const cls = 'pin ' + (o.status === 'pending' ? 'pending' : o.mine ? 'mine' : '');
        L.marker([o.lat, o.lng], {icon: L.divIcon({className: cls, iconSize: [22, 22], iconAnchor: [11, 22]})})
          .bindPopup(popup(o)).addTo(layer);
      });
      const c = document.getElementById('count'); if (c) c.textContent = data.observations.length;
      const u = document.getElementById('updated'); if (u) u.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (e) { const u = document.getElementById('updated'); if (u) u.textContent = e.message; }
  }

  document.querySelectorAll('.chip[data-scope]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-scope]').forEach(x => x.classList.toggle('on', x === b));
    scope = b.dataset.scope; refresh();
  }));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);   // "live": poll every 15 s while visible
})();
