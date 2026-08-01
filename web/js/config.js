/*
 * Where the game server lives.
 *
 * The board itself is static (GitHub Pages); rooms run in a Cloudflare Durable
 * Object. There is nothing here for a player to configure — the address is
 * baked in at deploy time. Somebody running their own worker points a build at
 * it with ?server=https://... , which is remembered from then on.
 */
const DEFAULT_SERVER = 'https://6nimmt.manuobelleiro00.workers.dev';

const KEY = '6nimmt.server';

function normalise(url) {
  return String(url).trim().replace(/\/+$/, '');
}

export function serverUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('server');
  if (override) {
    try {
      localStorage.setItem(KEY, normalise(override));
    } catch (_) {
      /* private mode */
    }
    return normalise(override);
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch (_) {
    /* private mode */
  }
  return normalise(DEFAULT_SERVER);
}

export function socketUrl(code) {
  const base = serverUrl();
  const ws = base.replace(/^http/, 'ws');
  return `${ws}/api/rooms/${encodeURIComponent(code)}/socket`;
}
