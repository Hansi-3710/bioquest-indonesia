document.querySelectorAll('.review').forEach(card => {
  const msg = card.querySelector('.msg');
  card.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api('/research/api/review/' + card.dataset.id, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: btn.dataset.action, species: card.querySelector('.pick').value})});
      card.classList.add('done'); msg.textContent = 'Saved: ' + btn.dataset.action;
      card.querySelectorAll('button').forEach(b => b.disabled = true);
    } catch (e) { msg.textContent = e.message; btn.disabled = false; }
  }));
});
