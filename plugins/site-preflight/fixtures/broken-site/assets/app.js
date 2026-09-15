// The planted secret. It is a made-up placeholder with no provider prefix, so
// the repository's own secret scan has nothing to catch, and it still matches
// site-preflight's generic "a name that means credential, assigned a long
// opaque string" pattern — which is the pattern that finds the real ones.
// site-preflight reports the file, the line and the first four characters. It
// never prints the value, and this comment is the only place in the tree that
// explains what it is.
const api_key = "demo_placeholder_not_a_credential";

async function loadOrders() {
  const res = await fetch('/api/orders', { headers: { 'x-demo': api_key } });
  return res.json();
}

window.addEventListener('load', () => {
  loadOrders().catch(() => {});
});
