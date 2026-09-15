// The only script this site serves. It carries no configuration, because a
// bakery front page has nothing to configure, and nothing shaped like a
// credential, because credentials do not belong in anything a browser can read.
document.addEventListener('DOMContentLoaded', () => {
  const hour = new Date().getHours();
  const open = hour >= 7 && hour < 15;
  for (const el of document.querySelectorAll('[data-hours]')) {
    el.textContent = open ? 'Open now' : 'Closed until seven';
  }
});
