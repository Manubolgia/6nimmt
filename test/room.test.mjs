/*
 * Integration tests for the Durable Object, driven through the same WebSocket
 * messages the browser sends. The Workers runtime globals the room touches are
 * stubbed below; everything else is the real code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HAND_SIZE, ROW_COUNT, TARGET_SCORE } from '../web/js/engine.js';

/* --------------------------- runtime stubs --------------------------- */

import { ShimCtx, installWorkersGlobals, shimRequest } from '../tools/workers-shim.mjs';

installWorkersGlobals();

const { GameRoom } = await import('../worker/src/index.js');

/* ------------------------------ harness ------------------------------ */

async function newRoom(code = 'ABCD') {
  const ctx = new ShimCtx();
  const room = new GameRoom(ctx, {});
  await ctx.pending;
  const res = await room.fetch(shimRequest(`https://room/reserve?code=${code}`));
  assert.ok(res.ok, 'reserve should succeed on a fresh room');
  return { ctx, room, code };
}

/** Connect a player and return a handle that tracks their latest state. */
async function connect(room, code, id, name) {
  const url = `https://room/api/rooms/${code}/socket?code=${code}` +
    `&playerId=${id}&name=${encodeURIComponent(name)}`;
  const res = await room.fetch(shimRequest(url, { upgrade: true }));
  const client = res.webSocket;
  const server = client.peer;
  const handle = {
    id,
    name,
    client,
    server,
    get messages() {
      return client.received.map((raw) => JSON.parse(raw));
    },
    get state() {
      const states = handle.messages.filter((m) => m.type === 'state');
      return states.length ? states[states.length - 1].state : null;
    },
    get errors() {
      return handle.messages.filter((m) => m.type === 'error').map((m) => m.code);
    },
    get bye() {
      const m = handle.messages.find((x) => x.type === 'bye');
      return m ? m.code : null;
    },
    send(msg) {
      return room.webSocketMessage(server, JSON.stringify(msg));
    },
    disconnect() {
      server.readyState = 3;
      return room.webSocketClose(server);
    },
  };
  return handle;
}

async function openGame(playerCount, { proVariant = false } = {}) {
  const { room, code, ctx } = await newRoom();
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(await connect(room, code, `p${i}`, `Player${i}`));
  }
  if (proVariant) await players[0].send({ type: 'setVariant', proVariant: true });
  await players[0].send({ type: 'start' });
  return { room, code, ctx, players };
}

/** Play one trick: everyone plays their lowest card, choices go to row 0. */
async function playTrick(players) {
  for (const p of players) {
    const s = p.state;
    if (s.yourCard !== null) continue;
    await p.send({ type: 'play', card: s.hand[0] });
  }
  await settleChoices(players);
}

async function settleChoices(players) {
  for (let guard = 0; guard < 20; guard++) {
    const s = players[0].state;
    if (!s.game || s.game.phase !== 'choose_row') return;
    const chooser = players.find((p) => p.id === s.game.chooser);
    await chooser.send({ type: 'take', row: 0 });
  }
  assert.fail('choose_row never cleared');
}

/* ------------------------------- tests -------------------------------- */

test('a code can only be reserved once while the room is alive', async () => {
  const { room } = await newRoom('WXYZ');
  const again = await room.fetch(shimRequest('https://room/reserve?code=WXYZ'));
  assert.equal(again.status, 409);
});

test('joining a room that was never reserved is refused', async () => {
  const ctx = new ShimCtx();
  const room = new GameRoom(ctx, {});
  await ctx.pending;
  const player = await connect(room, 'ZZZZ', 'p0', 'Nobody');
  assert.equal(player.bye, 'no_such_room');
});

test('players see each other in the lobby and the first one hosts', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  const b = await connect(room, code, 'p1', 'Bo');

  assert.equal(a.state.players.length, 2);
  assert.equal(a.state.isHost, true);
  assert.equal(b.state.isHost, false);
  assert.deepEqual(
    b.state.players.map((p) => p.name),
    ['Ada', 'Bo'],
  );
  assert.equal(b.state.code, code);
});

test('only the host can change the variant or start the game', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  const b = await connect(room, code, 'p1', 'Bo');

  await b.send({ type: 'setVariant', proVariant: true });
  assert.deepEqual(b.errors, ['not_host']);
  assert.equal(a.state.proVariant, false);

  await b.send({ type: 'start' });
  assert.equal(b.errors.at(-1), 'not_host');
  assert.equal(a.state.status, 'lobby');

  await a.send({ type: 'start' });
  assert.equal(a.state.status, 'playing');
});

test('the host picks the wildcard mode, and only a real one', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  const b = await connect(room, code, 'p1', 'Bo');
  assert.equal(a.state.wildMode, 'normal', 'wildcards start out plain');

  await b.send({ type: 'setWildMode', wildMode: 'negative' });
  assert.deepEqual(b.errors, ['not_host']);
  assert.equal(a.state.wildMode, 'normal');

  await a.send({ type: 'setWildMode', wildMode: 'sideways' });
  assert.equal(a.errors.at(-1), 'bad_wild_mode');
  assert.equal(a.state.wildMode, 'normal');

  await a.send({ type: 'setWild', wildVariant: true });
  await a.send({ type: 'setWildMode', wildMode: 'negative' });
  assert.equal(b.state.wildMode, 'negative', 'and everyone is told');

  await a.send({ type: 'start' });
  await a.send({ type: 'setWildMode', wildMode: 'normal' });
  assert.equal(a.errors.at(-1), 'already_started', 'the mode is locked at the deal');
  assert.equal(a.state.wildMode, 'negative');
});

test('a lone player cannot start', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  await a.send({ type: 'start' });
  assert.deepEqual(a.errors, ['need_more_players']);
});

test('the eleventh player is turned away', async () => {
  const { room, code } = await newRoom();
  for (let i = 0; i < 10; i++) await connect(room, code, `p${i}`, `P${i}`);
  const extra = await connect(room, code, 'p10', 'Late');
  assert.equal(extra.bye, 'room_full');
});

test('nobody can join once the cards are dealt', async () => {
  const { room, code, players } = await openGame(3);
  const late = await connect(room, code, 'pX', 'Late');
  assert.equal(late.bye, 'game_in_progress');
  assert.equal(players[0].state.players.length, 3);
});

test('the deal is private: you only ever receive your own hand', async () => {
  const { players } = await openGame(4);
  const hands = players.map((p) => p.state.hand);
  for (const hand of hands) assert.equal(hand.length, HAND_SIZE);

  const everything = JSON.stringify(players[0].messages);
  for (const card of hands[1]) {
    if (hands[0].includes(card)) continue;
    // Another player's card may only appear once it has been played.
    assert.ok(
      !new RegExp(`"hand":\\[[^\\]]*\\b${card}\\b`).test(everything),
      `card ${card} leaked into another player's view`,
    );
  }
  for (const p of players[0].state.players) {
    assert.equal(p.handCount, HAND_SIZE);
    assert.equal(p.hasSelected, false);
  }
});

test('a played card shows as committed without revealing it', async () => {
  const { players } = await openGame(3);
  const [a, b] = players;
  const card = a.state.hand[0];
  await a.send({ type: 'play', card });

  assert.equal(a.state.yourCard, card);
  assert.equal(b.state.yourCard, null);
  const seatOfA = b.state.players.find((p) => p.id === a.id);
  assert.equal(seatOfA.hasSelected, true);
  assert.equal(seatOfA.handCount, HAND_SIZE, 'the card is still in hand until reveal');
  assert.equal(b.state.game.log.length, 0, 'nothing is revealed yet');
});

test('playing a card twice, or a card you do not hold, is refused', async () => {
  const { players } = await openGame(3);
  const [a] = players;
  await a.send({ type: 'play', card: a.state.hand[0] });
  await a.send({ type: 'play', card: a.state.hand[1] });
  assert.deepEqual(a.errors, ['already_selected']);

  const [, b] = players;
  const notMine = [...Array(105).keys()].find((c) => c > 0 && !b.state.hand.includes(c));
  await b.send({ type: 'play', card: notMine });
  assert.deepEqual(b.errors, ['card_not_in_hand']);
});

test('the trick resolves once every player has committed', async () => {
  const { players } = await openGame(3);
  for (const p of players) await p.send({ type: 'play', card: p.state.hand[0] });
  await settleChoices(players);

  const s = players[0].state;
  assert.equal(s.hand.length, HAND_SIZE - 1);
  assert.equal(s.game.trick, 2);
  const reveal = s.game.log.find((e) => e.t === 'reveal');
  assert.equal(reveal.cards.length, 3);
  assert.deepEqual(
    reveal.cards.map((c) => c.card),
    reveal.cards.map((c) => c.card).slice().sort((x, y) => x - y),
  );
});

test('a whole game runs to a winner and the scores add up', async () => {
  const { players } = await openGame(4, { proVariant: true });

  for (let guard = 0; guard < 400; guard++) {
    const s = players[0].state;
    if (s.status === 'finished') break;
    if (s.game.phase === 'round_over') {
      await players[0].send({ type: 'next' });
      continue;
    }
    await playTrick(players);
  }

  const s = players[0].state;
  assert.equal(s.status, 'finished');
  assert.equal(s.game.phase, 'game_over');
  assert.ok(s.players.some((p) => p.score >= TARGET_SCORE));

  const best = Math.min(...s.players.map((p) => p.score));
  assert.deepEqual(
    s.game.winners.slice().sort(),
    s.players.filter((p) => p.score === best).map((p) => p.id).sort(),
  );
  for (const p of players) {
    assert.deepEqual(
      p.state.players.map((x) => x.score),
      s.players.map((x) => x.score),
      'every client agrees on the score',
    );
  }
});

test('rows stay legal for every player view throughout a round', async () => {
  const { players } = await openGame(5);
  for (let trick = 0; trick < HAND_SIZE; trick++) {
    await playTrick(players);
    for (const p of players) {
      const rows = p.state.game.rows;
      assert.equal(rows.length, ROW_COUNT);
      for (const row of rows) assert.ok(row.length >= 1 && row.length <= 5);
    }
  }
  // A round that crosses the target ends the game outright, which random play
  // now reaches often enough to matter.
  assert.ok(['round_over', 'game_over'].includes(players[0].state.game.phase));
  assert.ok(players.every((p) => p.state.hand.length === 0));
});

test('a dropped player keeps their seat and hand when they come back', async () => {
  const { room, code, players } = await openGame(3);
  const [a, b] = players;
  const hand = a.state.hand.slice();

  await a.disconnect();
  assert.equal(b.state.players.find((p) => p.id === a.id).connected, false);
  assert.equal(b.state.players.length, 3, 'the seat is held during a game');

  const back = await connect(room, code, 'p0', 'Ada');
  assert.deepEqual(back.state.hand, hand);
  assert.equal(back.state.players.find((p) => p.id === 'p0').connected, true);
});

test('leaving the lobby frees the seat and moves the host on', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  const b = await connect(room, code, 'p1', 'Bo');
  await a.disconnect();

  assert.equal(b.state.players.length, 1);
  assert.equal(b.state.isHost, true);
});

/** Wind the turn clock down to zero so the next alarm is actually due. */
async function expireClock(room) {
  assert.ok(room.room.deadlineAt, 'a turn clock should be running');
  room.room.deadlineAt = Date.now() - 1;
  await room.alarm();
}

test('a disconnected player is played for after the grace period', async () => {
  const { room, players } = await openGame(3);
  const [a, b, c] = players;
  const lowest = a.state.hand[0];

  await a.disconnect();
  await b.send({ type: 'play', card: b.state.hand[0] });
  await c.send({ type: 'play', card: c.state.hand[0] });
  assert.equal(b.state.game.trick, 1, 'the trick waits for the missing player');
  assert.ok(room.ctx.storage.alarm, 'an auto-play alarm is armed');

  await expireClock(room);
  // If the auto-played card was the low one, the same alarm path has to take a
  // row for them too; connected players choose for themselves.
  for (let guard = 0; guard < 10; guard++) {
    const g = b.state.game;
    if (g.phase !== 'choose_row') break;
    if (g.chooser === a.id) await expireClock(room);
    else await players.find((p) => p.id === g.chooser).send({ type: 'take', row: 0 });
  }

  const reveal = b.state.game.log.find((e) => e.t === 'reveal');
  assert.ok(
    reveal.cards.some((x) => x.playerId === 'p0' && x.card === lowest),
    'their lowest card was played for them',
  );
});

/* ------------------------------ turn clock ---------------------------- */

test('the clock is not up until it runs out', async () => {
  const { room, players } = await openGame(3);
  const before = players[0].state.game.trick;
  await room.alarm();
  assert.equal(players[0].state.game.trick, before, 'nobody was played for early');
  assert.equal(players[0].state.yourCard, null);
});

test('the turn clock plays for whoever is still thinking', async () => {
  const { room, players } = await openGame(3);
  const [a, b, c] = players;
  assert.equal(a.state.turnSeconds, 10, 'ten seconds by default');
  const lowB = b.state.hand[0];
  const lowC = c.state.hand[0];

  await a.send({ type: 'play', card: a.state.hand[0] });
  await expireClock(room);
  await settleClock(room, players);

  const reveal = a.state.game.log.find((e) => e.t === 'reveal');
  assert.equal(reveal.cards.length, 3, 'the trick went ahead without them');
  for (const [id, card] of [
    ['p1', lowB],
    ['p2', lowC],
  ]) {
    assert.ok(
      reveal.cards.some((x) => x.playerId === id && x.card === card),
      `${id} had their lowest card played`,
    );
  }
});

/** Resolve any row choice the clock left outstanding. */
async function settleClock(room, players) {
  for (let guard = 0; guard < 20; guard++) {
    const g = players[0].state.game;
    if (!g || g.phase !== 'choose_row') return;
    await expireClock(room);
  }
  assert.fail('choose_row never cleared');
}

test('the host can retune the clock and turning it off spares the connected', async () => {
  const { room, players } = await openGame(3);
  const [a, b] = players;

  await b.send({ type: 'setTurnSeconds', seconds: 20 });
  assert.equal(b.errors.at(-1), 'not_host');
  await a.send({ type: 'setTurnSeconds', seconds: 7 });
  assert.equal(a.errors.at(-1), 'bad_turn_seconds', 'only the offered steps');

  await a.send({ type: 'setTurnSeconds', seconds: 20 });
  assert.equal(b.state.turnSeconds, 20);
  assert.ok(b.state.deadlineAt - b.state.now > 15_000, 'the new clock took effect');

  await a.send({ type: 'setTurnSeconds', seconds: 0 });
  assert.equal(b.state.deadlineAt, null, 'nobody is on the clock with it off');
  await room.alarm();
  assert.equal(b.state.yourCard, null, 'a connected player is left to think');

  await b.disconnect();
  assert.ok(a.state.deadlineAt, 'a dropout still gets the old grace period');
});

test('the clock starts only once the previous trick has finished resolving', async () => {
  const { players } = await openGame(4);
  for (const p of players) await p.send({ type: 'play', card: p.state.hand[0] });
  await settleChoices(players);

  const s = players[0].state;
  assert.equal(s.game.trick, 2);
  const budget = s.deadlineAt - s.now;
  assert.ok(
    budget > 10_000,
    `the ten seconds start after the animation, got ${budget}ms`,
  );
});

test('the host can rematch and everyone starts from zero', async () => {
  const { players } = await openGame(3);
  for (let guard = 0; guard < 400; guard++) {
    const s = players[0].state;
    if (s.status === 'finished') break;
    if (s.game.phase === 'round_over') {
      await players[0].send({ type: 'next' });
      continue;
    }
    await playTrick(players);
  }
  assert.equal(players[0].state.status, 'finished');

  await players[1].send({ type: 'rematch' });
  assert.equal(players[1].errors.at(-1), 'not_host');

  await players[0].send({ type: 'rematch' });
  const s = players[0].state;
  assert.equal(s.status, 'playing');
  assert.equal(s.game.round, 1);
  assert.ok(s.players.every((p) => p.score === 0));
  assert.equal(s.hand.length, HAND_SIZE);
});

test('the host can send the table back to the lobby', async () => {
  const { players } = await openGame(3);
  for (let guard = 0; guard < 400; guard++) {
    const s = players[0].state;
    if (s.status === 'finished') break;
    if (s.game.phase === 'round_over') {
      await players[0].send({ type: 'next' });
      continue;
    }
    await playTrick(players);
  }
  await players[0].send({ type: 'toLobby' });
  assert.equal(players[2].state.status, 'lobby');
  assert.equal(players[2].state.game, null);
});

test('the host can remove a player before the deal', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  const b = await connect(room, code, 'p1', 'Bo');
  await a.send({ type: 'kick', id: 'p1' });
  assert.equal(b.bye, 'kicked');
  assert.equal(a.state.players.length, 1);
});

test('names are trimmed, capped and stripped of control characters', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  await a.send({ type: 'setName', name: '  a very long name indeed  ' });
  assert.equal(a.state.players[0].name, 'a very long na');
  await a.send({ type: 'setName', name: 'B ob' });
  assert.equal(a.state.players[0].name, 'Bob');
});

test('unknown messages are reported rather than ignored', async () => {
  const { room, code } = await newRoom();
  const a = await connect(room, code, 'p0', 'Ada');
  await a.send({ type: 'nonsense' });
  assert.deepEqual(a.errors, ['unknown_message']);
});
