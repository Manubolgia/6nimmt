/*
 * 6 nimmt! game server.
 *
 * One Durable Object per room holds the authoritative game state; clients only
 * ever receive their own hand, so the deck cannot be read out of the wire. The
 * rules live in ../../web/js/engine.js and are shared verbatim with the client.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  TARGET_SCORE,
  chooseRow,
  cheapestRow,
  createGame,
  nextRound,
  resolveIfReady,
  selectCard,
} from '../../web/js/engine.js';

/* Unambiguous alphabet: no I/O/0/1. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const SOCKET_PATH = /^\/api\/rooms\/([A-Za-z0-9]{1,8})\/socket$/;

/** Grace period before a disconnected player's move is played for them. */
const AUTO_PLAY_MS = 30_000;
/** Rooms with nobody connected are dropped after this long. */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) },
  });
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, target: TARGET_SCORE });
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const res = await stub.fetch(
          new Request(`https://room/reserve?code=${code}`, { method: 'POST' }),
        );
        if (res.ok) return json({ code });
      }
      return json({ error: 'no_code_available' }, { status: 503 });
    }

    const socket = url.pathname.match(SOCKET_PATH);
    if (socket) {
      const code = socket[1].toUpperCase();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
      // Forwarded as-is: rebuilding an upgrade request risks losing headers.
      return stub.fetch(request);
    }

    return json({ error: 'not_found' }, { status: 404 });
  },
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    /** Socket currently inside its close handler; ignored by connectedIds(). */
    this.closing = null;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
    });
  }

  /* ---------------------------- plumbing ---------------------------- */

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/reserve') {
      const code = url.searchParams.get('code');
      if (this.room && !this.expired()) {
        return json({ error: 'taken' }, { status: 409 });
      }
      this.room = this.blankRoom(code);
      await this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected_websocket' }, { status: 426 });
    }

    const path = url.pathname.match(SOCKET_PATH);
    const code = path ? path[1].toUpperCase() : '';
    const id = url.searchParams.get('playerId') || '';
    const name = cleanName(url.searchParams.get('name'));

    if (!id) return json({ error: 'missing_player' }, { status: 400 });
    if (!this.room || this.expired()) {
      // Room codes are typed by hand; an unknown one is a typo, not a bug.
      return this.rejectSocket('no_such_room');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: id });

    const problem = this.admit(id, name);
    if (problem) {
      server.send(JSON.stringify({ type: 'bye', code: problem }));
      server.close(1008, problem);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.room.code = this.room.code || code;
    this.touch();
    await this.persist();
    this.broadcast();
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Reject before the handshake so the client sees a clean failure. */
  rejectSocket(code) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(JSON.stringify({ type: 'bye', code }));
    server.close(1008, code);
    return new Response(null, { status: 101, webSocket: client });
  }

  blankRoom(code) {
    return {
      code,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      hostId: null,
      proVariant: false,
      status: 'lobby',
      players: [],
      game: null,
      roundStartScores: {},
    };
  }

  expired() {
    return Date.now() - (this.room.lastActivity || 0) > ROOM_TTL_MS;
  }

  touch() {
    this.room.lastActivity = Date.now();
  }

  persist() {
    return this.ctx.storage.put('room', this.room);
  }

  /* ------------------------------ seats ------------------------------ */

  admit(id, name) {
    const room = this.room;
    const existing = room.players.find((p) => p.id === id);
    if (existing) {
      if (name) existing.name = name;
      return null;
    }
    if (room.status !== 'lobby') return 'game_in_progress';
    if (room.players.length >= MAX_PLAYERS) return 'room_full';
    room.players.push({ id, name: name || `Player ${room.players.length + 1}` });
    if (!room.hostId) room.hostId = id;
    return null;
  }

  /**
   * Ids with at least one live socket. A closing socket is still listed by
   * `getWebSockets()` inside its own close handler, so it is passed in as
   * `except` and skipped.
   */
  connectedIds(except) {
    const skip = except || this.closing;
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      if (ws.readyState === WebSocket.CLOSED) continue;
      const att = ws.deserializeAttachment();
      if (att && att.playerId) ids.add(att.playerId);
    }
    return ids;
  }

  /** The host, or the first connected player when the host has dropped. */
  hostId() {
    const live = this.connectedIds();
    if (this.room.hostId && live.has(this.room.hostId)) return this.room.hostId;
    const stand = this.room.players.find((p) => live.has(p.id));
    return stand ? stand.id : this.room.hostId;
  }

  /* ---------------------------- messaging ---------------------------- */

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att || !att.playerId) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    const error = this.handle(att.playerId, msg);
    if (error) {
      ws.send(JSON.stringify({ type: 'error', code: error }));
      return;
    }
    this.touch();
    await this.persist();
    this.broadcast();
    await this.scheduleAlarm();
  }

  async webSocketClose(ws) {
    this.closing = ws;
    try {
      const room = this.room;
      const att = ws.deserializeAttachment();
      if (room && att && room.status === 'lobby') {
        // Nothing is at stake before the deal, so free the seat immediately.
        const live = this.connectedIds();
        if (!live.has(att.playerId)) {
          room.players = room.players.filter((p) => p.id !== att.playerId);
          if (room.hostId && !room.players.some((p) => p.id === room.hostId)) {
            room.hostId = room.players.length ? room.players[0].id : null;
          }
          await this.persist();
        }
      }
      this.broadcast();
      await this.scheduleAlarm();
    } finally {
      this.closing = null;
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** Returns an error code, or null when the action was applied. */
  handle(playerId, msg) {
    const room = this.room;
    if (!room) return 'no_room';
    const isHost = this.hostId() === playerId;

    switch (msg.type) {
      case 'ping':
        return null;

      case 'setName': {
        const player = room.players.find((p) => p.id === playerId);
        if (!player) return 'not_seated';
        const name = cleanName(msg.name);
        if (!name) return 'bad_name';
        player.name = name;
        if (room.game) {
          const seat = room.game.players.find((p) => p.id === playerId);
          if (seat) seat.name = name;
        }
        return null;
      }

      case 'setVariant':
        if (!isHost) return 'not_host';
        if (room.status !== 'lobby') return 'already_started';
        room.proVariant = !!msg.proVariant;
        return null;

      case 'kick': {
        if (!isHost) return 'not_host';
        if (room.status !== 'lobby') return 'already_started';
        if (msg.id === playerId) return 'cannot_kick_host';
        room.players = room.players.filter((p) => p.id !== msg.id);
        for (const ws of this.ctx.getWebSockets()) {
          const att = ws.deserializeAttachment();
          if (att && att.playerId === msg.id) {
            ws.send(JSON.stringify({ type: 'bye', code: 'kicked' }));
            ws.close(1000, 'kicked');
          }
        }
        return null;
      }

      case 'start': {
        if (!isHost) return 'not_host';
        if (room.status !== 'lobby') return 'already_started';
        if (room.players.length < MIN_PLAYERS) return 'need_more_players';
        room.game = createGame(room.players, room.proVariant, randomSeed());
        room.status = 'playing';
        room.roundStartScores = zeroScores(room.players);
        return null;
      }

      case 'play': {
        if (room.status !== 'playing') return 'not_playing';
        const err = selectCard(room.game, playerId, msg.card);
        if (err) return err;
        resolveIfReady(room.game);
        this.syncStatus();
        return null;
      }

      case 'take': {
        if (room.status !== 'playing') return 'not_playing';
        const err = chooseRow(room.game, playerId, msg.row);
        if (err) return err;
        this.syncStatus();
        return null;
      }

      case 'next': {
        if (!isHost) return 'not_host';
        if (room.status !== 'playing') return 'not_playing';
        room.roundStartScores = currentScores(room.game);
        return nextRound(room.game, randomSeed());
      }

      case 'rematch': {
        if (!isHost) return 'not_host';
        if (room.status !== 'finished') return 'not_finished';
        room.game = createGame(room.players, room.proVariant, randomSeed());
        room.status = 'playing';
        room.roundStartScores = zeroScores(room.players);
        return null;
      }

      case 'toLobby': {
        if (!isHost) return 'not_host';
        if (room.status !== 'finished') return 'not_finished';
        room.game = null;
        room.status = 'lobby';
        return null;
      }

      default:
        return 'unknown_message';
    }
  }

  syncStatus() {
    if (this.room.game && this.room.game.phase === 'game_over') {
      this.room.status = 'finished';
    }
  }

  /* ---------------------------- broadcasting -------------------------- */

  viewFor(playerId) {
    const room = this.room;
    const live = this.connectedIds();
    const game = room.game;
    const host = this.hostId();

    const players = room.players.map((p, seat) => {
      const inGame = game ? game.players.find((g) => g.id === p.id) : null;
      return {
        id: p.id,
        name: p.name,
        seat,
        connected: live.has(p.id),
        isHost: p.id === host,
        score: inGame ? inGame.score : 0,
        roundScore: inGame ? inGame.score - (room.roundStartScores[p.id] || 0) : 0,
        handCount: inGame ? inGame.hand.length : 0,
        hasSelected: game ? game.selections[p.id] !== undefined : false,
      };
    });

    const me = game ? game.players.find((g) => g.id === playerId) : null;

    return {
      code: room.code,
      status: room.status,
      proVariant: room.proVariant,
      you: playerId,
      isHost: host === playerId,
      target: TARGET_SCORE,
      players,
      hand: me ? me.hand.slice() : [],
      yourCard: game && game.selections[playerId] !== undefined ? game.selections[playerId] : null,
      game: game
        ? {
            phase: game.phase,
            round: game.round,
            trick: game.trick,
            trickId: game.trickId,
            rows: game.rows.map((r) => r.slice()),
            chooser: game.chooser,
            log: game.log,
            winners: game.winners,
          }
        : null,
    };
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) continue;
      try {
        ws.send(JSON.stringify({ type: 'state', state: this.viewFor(att.playerId) }));
      } catch (_) {
        /* socket already gone */
      }
    }
  }

  /* ------------------------------ alarms ------------------------------ */

  /** Players who owe an action right now but are not connected. */
  stalled() {
    const room = this.room;
    if (!room || room.status !== 'playing' || !room.game) return [];
    const live = this.connectedIds();
    const game = room.game;
    if (game.phase === 'select') {
      return game.players
        .filter((p) => game.selections[p.id] === undefined && !live.has(p.id))
        .map((p) => p.id);
    }
    if (game.phase === 'choose_row' && game.chooser && !live.has(game.chooser)) {
      return [game.chooser];
    }
    return [];
  }

  async scheduleAlarm() {
    if (this.stalled().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + AUTO_PLAY_MS);
      return;
    }
    const idleAt = (this.room?.lastActivity || Date.now()) + ROOM_TTL_MS;
    await this.ctx.storage.setAlarm(idleAt);
  }

  async alarm() {
    if (!this.room) return;

    if (this.expired() && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }

    const game = this.room.game;
    let acted = false;
    for (const id of this.stalled()) {
      if (game.phase === 'select') {
        const seat = game.players.find((p) => p.id === id);
        if (seat && seat.hand.length) {
          selectCard(game, id, seat.hand[0]); // hands are kept sorted ascending
          acted = true;
        }
      } else if (game.phase === 'choose_row') {
        chooseRow(game, id, cheapestRow(game.rows));
        acted = true;
      }
    }
    if (acted) {
      if (game.phase === 'select') resolveIfReady(game);
      this.syncStatus();
      await this.persist();
      this.broadcast();
    }
    await this.scheduleAlarm();
  }
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}

function zeroScores(players) {
  const out = {};
  for (const p of players) out[p.id] = 0;
  return out;
}

function currentScores(game) {
  const out = {};
  for (const p of game.players) out[p.id] = p.score;
  return out;
}
