/*
 * Just enough of the Workers runtime to run the real Durable Object outside
 * Cloudflare — used by the tests and by tools/dev-server.mjs, so local play and
 * CI exercise the same worker/src/index.js that gets deployed.
 */

import { webcrypto } from 'node:crypto';

/** One end of a WebSocketPair. Sending on one end delivers on the other. */
export class ShimSocket {
  constructor(role) {
    this.role = role;
    this.readyState = 1;
    this.attachment = null;
    this.received = [];
    this.peer = null;
    /** Set by the host to observe traffic arriving on this end. */
    this.onmessage = null;
    /** Set by the host to observe the far end hanging up. */
    this.onclose = null;
  }

  accept() {
    this.readyState = 1;
  }

  serializeAttachment(value) {
    this.attachment = JSON.parse(JSON.stringify(value));
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket closed');
    const target = this.peer || this;
    target.received.push(data);
    if (target.onmessage) target.onmessage(data);
  }

  close(code, reason) {
    this.readyState = 3;
    if (this.peer && this.peer.onclose) this.peer.onclose(code, reason);
  }
}

export class ShimStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }
  async deleteAll() {
    this.map.clear();
    this.alarm = null;
  }
  async setAlarm(at) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

export class ShimCtx {
  constructor() {
    this.storage = new ShimStorage();
    this.sockets = [];
    this.pending = Promise.resolve();
  }
  blockConcurrencyWhile(fn) {
    this.pending = fn();
    return this.pending;
  }
  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((ws) => ws.readyState !== 3);
  }
}

export class ShimResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
    this.headers = new Headers(init.headers || {});
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return String(this.body);
  }
}

/**
 * Install the globals worker/src/index.js expects. Call before importing it.
 */
export function installWorkersGlobals() {
  globalThis.Response = ShimResponse;
  // `crypto` is only global from Node 19 on; the worker uses it for room codes
  // and deal seeds.
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  globalThis.WebSocketPair = function WebSocketPair() {
    const client = new ShimSocket('client');
    const server = new ShimSocket('server');
    client.peer = server;
    server.peer = client;
    return { 0: client, 1: server };
  };
}

/** A request shaped the way the Durable Object reads it. */
export function shimRequest(url, { upgrade = false, method = 'GET' } = {}) {
  return {
    url,
    method,
    headers: new Headers(upgrade ? { Upgrade: 'websocket' } : {}),
  };
}
