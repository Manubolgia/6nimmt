/*
 * Local development server: serves web/ and hosts rooms by running the real
 * Durable Object from worker/src/index.js on top of the shim in
 * tools/workers-shim.mjs. Nothing Cloudflare-specific is needed to play.
 *
 *   npm install && npm run dev   ->   http://localhost:8787
 *
 * Rooms live in memory only; restarting the server clears them.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

import { ShimCtx, installWorkersGlobals, shimRequest } from './workers-shim.mjs';

installWorkersGlobals();
const { GameRoom } = await import('../worker/src/index.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function roomFor(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const ctx = new ShimCtx();
    entry = { ctx, room: new GameRoom(ctx, {}) };
    rooms.set(code, entry);
  }
  return entry;
}

async function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    const { room, ctx } = roomFor(code);
    await ctx.pending;
    const res = await room.fetch(shimRequest(`https://room/reserve?code=${code}`));
    if (res.ok) return code;
  }
  return null;
}

/* ------------------------------- HTTP -------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'] });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const code = await newCode();
    res.writeHead(code ? 200 : 503, { 'Content-Type': TYPES['.json'] });
    res.end(JSON.stringify(code ? { code } : { error: 'no_code_available' }));
    return;
  }

  // Static files, restricted to web/.
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT + sep) && path !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (_) {
    res.writeHead(404).end('not found');
  }
});

/* ----------------------------- WebSocket ------------------------------ */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{1,8})\/socket$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const code = match[1].toUpperCase();
  const { room, ctx } = roomFor(code);
  await ctx.pending;

  const forward = new URL(url.toString(), 'https://room');
  forward.searchParams.set('code', code);
  const res = await room.fetch(shimRequest(forward.toString(), { upgrade: true }));
  const shimClient = res.webSocket;
  if (!shimClient) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Anything the room already queued during the handshake goes out first.
    for (const frame of shimClient.received) ws.send(frame);
    shimClient.onmessage = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    };
    shimClient.onclose = () => ws.close();

    ws.on('message', (data) => {
      room.webSocketMessage(shimClient.peer, data.toString()).catch(report);
    });
    ws.on('close', () => {
      shimClient.peer.readyState = 3;
      room.webSocketClose(shimClient.peer).catch(report);
    });
    ws.on('error', report);
  });
});

function report(err) {
  process.stderr.write(`room error: ${err && err.stack ? err.stack : err}\n`);
}

/*
 * The shim has no alarm scheduler, so poll the rooms instead: this is what
 * plays for a disconnected player after the grace period.
 */
setInterval(() => {
  const now = Date.now();
  for (const { room, ctx } of rooms.values()) {
    if (ctx.storage.alarm && ctx.storage.alarm <= now) {
      ctx.storage.alarm = null;
      room.alarm().catch(report);
    }
  }
}, 1000).unref();

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `6 nimmt! dev server on http://localhost:${PORT}\n` +
      `open it in two windows and use ?server=http://localhost:${PORT} if the\n` +
      'board is hosted elsewhere.\n',
  );
});
