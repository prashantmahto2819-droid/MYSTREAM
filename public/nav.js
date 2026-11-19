// Tabs: one topic per screen, remembered in the URL hash.
const tabs = ['studio', 'destinations', 'videos', 'recordings', 'activity', 'settings'];
function show(id) {
  if (!tabs.includes(id)) id = 'studio';
  for (const sec of document.querySelectorAll('[data-tab]')) sec.classList.toggle('off', sec.dataset.tab !== id);
  for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('active', b.dataset.nav === id);
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}
for (const b of document.querySelectorAll('[data-nav]')) b.addEventListener('click', () => show(b.dataset.nav));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
