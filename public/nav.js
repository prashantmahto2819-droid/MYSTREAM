// Tabs: one topic per screen, remembered in the URL hash.
const tabs = ['home', 'studio', 'destinations', 'videos', 'recordings', 'activity', 'settings'];
function show(id) {
  if (!tabs.includes(id)) id = 'home';
  for (const sec of document.querySelectorAll('[data-tab]')) sec.classList.toggle('off', sec.dataset.tab !== id);
  for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('active', b.dataset.nav === id);
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}
for (const b of document.querySelectorAll('[data-nav]')) b.addEventListener('click', () => show(b.dataset.nav));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));

// Popups (native <dialog>): any [data-open="id"] opens it, [data-close] or a click on the backdrop closes it.
document.addEventListener('click', (e) => {
  const o = e.target.closest?.('[data-open]');
  if (o) { const d = document.getElementById(o.dataset.open); if (d && !d.open) d.showModal(); return; }
  const c = e.target.closest?.('[data-close]');
  if (c) { c.closest('dialog')?.close(); return; }
  if (e.target.tagName === 'DIALOG' && e.target.open) e.target.close();
});

// Studio side panels: the icon rail opens one panel at a time (click again to hide the drawer).
const drawer = document.getElementById('st-drawer');
function openPanel(id) {
  if (!drawer) return;
  const same = !drawer.classList.contains('closed') && drawer.dataset.open === id;
  drawer.classList.toggle('closed', same);
  drawer.dataset.open = same ? '' : id;
  for (const p of drawer.querySelectorAll('[data-panelbody]')) p.classList.toggle('off', p.dataset.panelbody !== id);
  for (const b of document.querySelectorAll('[data-panel]')) b.classList.toggle('active', !same && b.dataset.panel === id);
  try { localStorage.setItem('vs_panel', same ? '' : id); } catch { /* ignore */ }
}
for (const b of document.querySelectorAll('[data-panel]')) b.addEventListener('click', () => openPanel(b.dataset.panel));
if (drawer) {
  let start = 'sources';
  try { const v = localStorage.getItem('vs_panel'); if (v !== null && v !== '') start = v; } catch { /* ignore */ }
  drawer.classList.add('closed'); drawer.dataset.open = ''; openPanel(start);
}
