/*
 * WebSocket client for a room.
 *
 * Identity is a random id kept in localStorage, so closing the tab, locking the
 * phone or losing signal reconnects into the same seat with the same hand.
 */

import { serverUrl, socketUrl } from './config.js';

const ID_KEY = '6nimmt.playerId';
const NAME_KEY = '6nimmt.name';
const ROOM_KEY = '6nimmt.room';

export function playerId() {
  let id = null;
  try {
    id = localStorage.getItem(ID_KEY);
  } catch (_) {
    /* private mode */
  }
  if (!id) {
    id = randomId();
    try {
      localStorage.setItem(ID_KEY, id);
    } catch (_) {
      /* private mode */
    }
  }
  return id;
}

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch (_) {
    return '';
  }
}

export function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch (_) {
    /* private mode */
  }
}

/**
 * The room the player is currently in. Remembered so a reload, a phone
 * unlocking or the PWA being restarted drops them straight back into their
 * seat rather than on the home screen.
 */
export function savedRoom() {
  try {
    return localStorage.getItem(ROOM_KEY) || '';
  } catch (_) {
    return '';
  }
}

function rememberRoom(code) {
  try {
    if (code) localStorage.setItem(ROOM_KEY, code);
    else localStorage.removeItem(ROOM_KEY);
  } catch (_) {
    /* private mode */
  }
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ask the server for a fresh, unused room code. */
export async function createRoom() {
  const res = await fetch(`${serverUrl()}/api/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error(`server said ${res.status}`);
  const body = await res.json();
  if (!body.code) throw new Error('malformed response');
  return body.code;
}

const BACKOFF = [800, 1600, 3200, 5000, 8000];

export function createClient(handlers) {
  let socket = null;
  let wanted = false;
  let attempt = 0;
  let timer = null;
  let session = null;
  const queue = [];

  function status(value, detail) {
    handlers.onStatus?.(value, detail);
  }

  function open() {
    if (!wanted || !session) return;
    clearTimeout(timer);
    status(attempt === 0 ? 'connecting' : 'reconnecting');

    const url = new URL(socketUrl(session.code));
    url.searchParams.set('playerId', session.playerId);
    url.searchParams.set('name', session.name);

    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      attempt = 0;
      status('online');
      while (queue.length) ws.send(queue.shift());
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (msg.type === 'error') handlers.onError?.(msg.code, msg.detail);
      else if (msg.type === 'state') handlers.onState?.(msg.state);
      else if (msg.type === 'bye') {
        wanted = false;
        handlers.onError?.(msg.code || 'closed');
      }
    });

    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      if (wanted) scheduleRetry();
      else status('offline');
    });

    ws.addEventListener('error', () => {
      if (socket === ws) ws.close();
    });
  }

  function scheduleRetry() {
    status('reconnecting');
    const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt += 1;
    clearTimeout(timer);
    timer = setTimeout(open, wait);
  }

  return {
    join(code, name) {
      session = { code: code.toUpperCase(), name, playerId: playerId() };
      rememberRoom(session.code);
      wanted = true;
      attempt = 0;
      queue.length = 0;
      if (socket) socket.close();
      socket = null;
      open();
    },
    send(message) {
      const data = JSON.stringify(message);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
      else queue.push(data);
    },
    leave() {
      rememberRoom(null);
      wanted = false;
      clearTimeout(timer);
      queue.length = 0;
      if (socket) socket.close();
      socket = null;
      session = null;
      status('offline');
    },
    get code() {
      return session ? session.code : null;
    },
  };
}
