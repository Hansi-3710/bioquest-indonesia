(function () {
  const $ = id => document.getElementById(id);
  const vf = $('vf'), video = $('cam'), prev = $('preview'), send = $('send'), msgEl = $('msg');
  let stream = null, recorder = null, chunks = [], blob = null, stopTimer = null, marker = null;

  const msg = (t, err) => { msgEl.textContent = t; msgEl.className = 'flash' + (err ? ' error' : ''); };

  function setBlob(b) {
    blob = b; prev.replaceChildren();
    const isVideo = b.type.startsWith('video');
    const n = document.createElement(isVideo ? 'video' : 'img');
    n.src = URL.createObjectURL(b);
    if (isVideo) { n.controls = true; n.muted = true; n.playsInline = true; } else { n.alt = 'Your photo'; }
    prev.appendChild(n); prev.hidden = false; send.disabled = false;
  }

  $('start').addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}, audio: false});
      video.srcObject = stream; await video.play();
      vf.classList.add('live'); $('snap').disabled = $('rec').disabled = false; $('start').hidden = true;
    } catch (e) {
      msg(e.name === 'NotAllowedError' ? 'Camera permission was denied.'
        : 'No usable camera found. (Camera access needs HTTPS or localhost.) You can still choose a file.', true);
    }
  });

  $('snap').addEventListener('click', () => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    c.toBlob(b => b && setBlob(new File([b], 'photo.jpg', {type: 'image/jpeg'})), 'image/jpeg', 0.9);
  });

  $('rec').addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) return msg('Video recording is not supported in this browser. Choose a file instead.', true);
    chunks = []; recorder = new MediaRecorder(stream, {mimeType: mime});
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      clearTimeout(stopTimer); vf.classList.remove('rec'); $('rec').textContent = 'Record video';
      const type = mime.split(';')[0];
      setBlob(new File(chunks, 'clip.' + (type === 'video/mp4' ? 'mp4' : 'webm'), {type}));
    };
    recorder.start(); vf.classList.add('rec'); $('rec').textContent = 'Stop (max 15 s)';
    stopTimer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), 15000);
  });

  $('file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 40 * 1024 * 1024) return msg('That file is larger than 40 MB.', true);
    setBlob(f);
  });

  // ---- location: GPS or tap the map ----
  const map = makeMap('pick');
  function setLoc(lat, lng, fly) {
    $('lat').value = lat.toFixed(6); $('lng').value = lng.toFixed(6);
    if (!map) return;
    if (marker) marker.setLatLng([lat, lng]); else marker = L.marker([lat, lng]).addTo(map);
    if (fly) map.setView([lat, lng], 12);
  }
  if (map) map.on('click', e => setLoc(e.latlng.lat, e.latlng.lng, false));
  ['lat', 'lng'].forEach(id => $(id).addEventListener('change', () => {
    const a = parseFloat($('lat').value), b = parseFloat($('lng').value); if (!isNaN(a) && !isNaN(b)) setLoc(a, b, true);
  }));
  $('geo').addEventListener('click', () => {
    if (!navigator.geolocation) return msg('Location is not available. Tap the map instead.', true);
    navigator.geolocation.getCurrentPosition(p => setLoc(p.coords.latitude, p.coords.longitude, true),
      () => msg('Could not get your location. Tap the map instead.', true), {enableHighAccuracy: true, timeout: 10000});
  });

  $('obs').addEventListener('submit', async e => {
    e.preventDefault();
    if (!blob) return msg('Take or choose a photo or video first.', true);
    const fd = new FormData();
    fd.append('file', blob, blob.name || 'upload');
    fd.append('species', $('species').value); fd.append('notes', $('notes').value);
    fd.append('lat', $('lat').value); fd.append('lng', $('lng').value);
    fd.append('consent', $('consent').checked ? '1' : '0');
    send.disabled = true; msg('Saving…');
    try {
      await api('/api/observations', {method: 'POST', body: fd});
      msg('Saved! Thank you — a researcher will review your sighting.');
      blob = null; prev.hidden = true; prev.replaceChildren(); $('notes').value = '';
    } catch (err) { msg(err.message, true); send.disabled = false; }
  });

  window.addEventListener('pagehide', () => stream && stream.getTracks().forEach(t => t.stop()));
})();
