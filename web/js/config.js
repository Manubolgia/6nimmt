/*
 * Where the game server lives.
 *
 * The board itself is static (GitHub Pages); rooms run in a Cloudflare Durable
 * Object. Set DEFAULT_SERVER once after `wrangler deploy` — or override it at
 * runtime with ?server=https://... , which is persisted so testers can point a
 * hosted build at their own worker.
 */
export const DEFAULT_SERVER = 'https://6nimmt.manuobelleiro00.workers.dev';

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

export function setServerUrl(url) {
  const value = normalise(url);
  try {
    localStorage.setItem(KEY, value);
  } catch (_) {
    /* private mode */
  }
  return value;
}

export function isServerConfigured() {
  return !serverUrl().includes('example.workers.dev');
}

export function socketUrl(code) {
  const base = serverUrl();
  const ws = base.replace(/^http/, 'ws');
  return `${ws}/api/rooms/${encodeURIComponent(code)}/socket`;
}
