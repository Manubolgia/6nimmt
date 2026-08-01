import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FULL_DECK,
  HAND_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROW_COUNT,
  ROW_LIMIT,
  TARGET_SCORE,
  buildDeck,
  bullHeads,
  bullTotal,
  cheapestRow,
  chooseRow,
  createGame,
  deckSize,
  makeRng,
  nextRound,
  previewPlay,
  resolveIfReady,
  selectCard,
  targetRow,
} from '../web/js/engine.js';

/* ----------------------------- bull heads ----------------------------- */

test('bull heads follow the printed values', () => {
  assert.equal(bullHeads(55), 7, '55 is the seven-head card');
  for (const n of [11, 22, 33, 44, 66, 77, 88, 99]) assert.equal(bullHeads(n), 5);
  for (const n of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) assert.equal(bullHeads(n), 3);
  for (const n of [5, 15, 25, 35, 45, 65, 75, 85, 95]) assert.equal(bullHeads(n), 2);
  for (const n of [1, 2, 3, 4, 6, 7, 8, 9, 12, 104]) assert.equal(bullHeads(n), 1);
});

test('every card has a value and the deck totals 171 bull heads', () => {
  let total = 0;
  const counts = {};
  for (let n = 1; n <= FULL_DECK; n++) {
    const b = bullHeads(n);
    assert.ok([1, 2, 3, 5, 7].includes(b), `card ${n} has an impossible value ${b}`);
    counts[b] = (counts[b] || 0) + 1;
    total += b;
  }
  // Card counts as printed on the physical deck.
  assert.deepEqual(counts, { 1: 76, 2: 9, 3: 10, 5: 8, 7: 1 });
  assert.equal(total, 171);
});

/* ------------------------------- deck --------------------------------- */

test('the standard deck is always all 104 cards', () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    assert.equal(deckSize(n, false), 104);
    assert.deepEqual(buildDeck(n, false).slice(-1), [104]);
  }
});

test('the professional deck is ten cards per player plus the four starters', () => {
  assert.equal(deckSize(2, true), 24);
  assert.equal(deckSize(4, true), 44);
  assert.equal(deckSize(7, true), 74);
  // At ten players the professional deck is the whole deck.
  assert.equal(deckSize(MAX_PLAYERS, true), FULL_DECK);
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    assert.equal(deckSize(n, true), n * HAND_SIZE + ROW_COUNT);
  }
});

/* ---------------------------- row targeting --------------------------- */

test('a card joins the row with the highest end card still below it', () => {
  const rows = [[10], [30], [55], [70]];
  assert.equal(targetRow(rows, 60), 2);
  assert.equal(targetRow(rows, 71), 3);
  assert.equal(targetRow(rows, 11), 0);
  assert.equal(targetRow(rows, 9), -1, 'lower than every row end');
});

test('preview reports placing, sweeping and being too low', () => {
  const rows = [[10], [30, 31, 32, 33, 34], [55], [70]];
  assert.deepEqual(previewPlay(rows, 40), {
    row: 1,
    takes: true,
    bulls: bullTotal([30, 31, 32, 33, 34]),
    kind: 'sixth',
  });
  assert.equal(previewPlay(rows, 20).kind, 'place');
  assert.equal(previewPlay(rows, 1).kind, 'too_low');
});

test('the cheapest row is the one with the fewest bull heads', () => {
  //            3 bulls        1 bull        2 bulls
  const rows = [[10, 20], [3], [5], [11]];
  assert.equal(cheapestRow(rows), 1);
});

/* ------------------------------ dealing ------------------------------- */

function newGame(playerCount, proVariant = false, seed = 1) {
  const players = [];
  for (let i = 0; i < playerCount; i++) players.push({ id: `p${i}`, name: `P${i}` });
  return createGame(players, proVariant, seed);
}

test('the deal gives everyone ten cards and starts four rows', () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    for (const pro of [false, true]) {
      const game = newGame(n, pro, 7 + n);
      assert.equal(game.players.length, n);
      assert.equal(game.rows.length, ROW_COUNT);
      const seen = new Set();
      for (const p of game.players) {
        assert.equal(p.hand.length, HAND_SIZE);
        for (const c of p.hand) {
          assert.ok(!seen.has(c), `card ${c} was dealt twice`);
          seen.add(c);
        }
      }
      for (const row of game.rows) {
        assert.equal(row.length, 1);
        assert.ok(!seen.has(row[0]));
        seen.add(row[0]);
      }
      assert.equal(seen.size, n * HAND_SIZE + ROW_COUNT);
      const highest = deckSize(n, pro);
      for (const c of seen) assert.ok(c >= 1 && c <= highest);
      if (pro) {
        assert.equal(seen.size, highest, 'the professional deck is fully dealt');
      }
    }
  }
});

test('hands are dealt sorted so auto-play picks the lowest card', () => {
  const game = newGame(5, false, 99);
  for (const p of game.players) {
    assert.deepEqual(p.hand, p.hand.slice().sort((a, b) => a - b));
  }
});

/* ------------------------------- play --------------------------------- */

test('a card cannot be changed once it is face down', () => {
  const game = newGame(3, false, 3);
  const [a] = game.players;
  assert.equal(selectCard(game, a.id, a.hand[0]), null);
  assert.equal(selectCard(game, a.id, a.hand[1]), 'already_selected');
});

test('a card that is not in hand is rejected', () => {
  const game = newGame(3, false, 3);
  const [a] = game.players;
  const missing = [...Array(105).keys()].find((c) => c > 0 && !a.hand.includes(c));
  assert.equal(selectCard(game, a.id, missing), 'card_not_in_hand');
});

test('cards resolve in ascending order regardless of who played them', () => {
  const game = newGame(4, false, 12);
  for (const p of game.players) selectCard(game, p.id, p.hand[9]);
  resolveIfReady(game);
  const reveal = game.log[0];
  assert.equal(reveal.t, 'reveal');
  const cards = reveal.cards.map((c) => c.card);
  assert.deepEqual(cards, cards.slice().sort((a, b) => a - b));
});

test('the sixth card sweeps the five below it and starts the row again', () => {
  const game = newGame(2, false, 5);
  // Force a known table rather than relying on the shuffle.
  game.rows = [[1], [2], [3], [40, 41, 42, 43, 44]];
  game.players[0].hand = [50];
  game.players[1].hand = [90];
  selectCard(game, 'p0', 50);
  selectCard(game, 'p1', 90);
  resolveIfReady(game);

  assert.equal(game.players[0].score, bullTotal([40, 41, 42, 43, 44]));
  assert.deepEqual(game.rows[3], [50, 90], 'the taker starts the row, then 90 follows');
  assert.equal(game.players[1].score, 0);
  const take = game.log.find((e) => e.t === 'take');
  assert.equal(take.reason, 'sixth');
  assert.equal(take.playerId, 'p0');
});

test('a card below every row lets its owner take any row', () => {
  const game = newGame(2, false, 5);
  game.rows = [[10], [20], [30], [40]];
  game.players[0].hand = [5];
  game.players[1].hand = [99];
  selectCard(game, 'p0', 5);
  selectCard(game, 'p1', 99);
  resolveIfReady(game);

  assert.equal(game.phase, 'choose_row');
  assert.equal(game.chooser, 'p0');
  assert.equal(chooseRow(game, 'p1', 0), 'not_your_choice');
  assert.equal(chooseRow(game, 'p0', 9), 'bad_row');

  assert.equal(chooseRow(game, 'p0', 2), null);
  assert.equal(game.players[0].score, bullHeads(30));
  assert.deepEqual(game.rows[2], [5]);
  assert.deepEqual(game.rows[3], [40, 99], 'the higher card resolved afterwards');
});

test('a row is never longer than five cards', () => {
  const game = newGame(2, false, 8);
  game.rows = [[1], [2], [3], [4]];
  game.players[0].hand = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  game.players[1].hand = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99];
  for (let trick = 0; trick < HAND_SIZE; trick++) {
    selectCard(game, 'p0', game.players[0].hand[0]);
    selectCard(game, 'p1', game.players[1].hand[0]);
    resolveIfReady(game);
    assert.notEqual(game.phase, 'choose_row');
    for (const row of game.rows) assert.ok(row.length <= ROW_LIMIT);
  }
});

/* ------------------------- full-game simulation ------------------------ */

/**
 * Plays a whole game with pseudo-random choices and checks the invariants that
 * must hold at every step.
 */
function simulate(playerCount, proVariant, seed) {
  const rng = makeRng(seed);
  const game = newGame(playerCount, proVariant, seed);
  const highest = deckSize(playerCount, proVariant);
  let rounds = 0;
  let tricks = 0;

  for (let guard = 0; guard < 5000; guard++) {
    if (game.phase === 'select') {
      const before = game.trick;
      for (const p of game.players) {
        const card = p.hand[Math.floor(rng() * p.hand.length)];
        assert.equal(selectCard(game, p.id, card), null);
      }
      resolveIfReady(game);
      if (game.trick !== before || game.phase !== 'select') tricks += 1;
    } else if (game.phase === 'choose_row') {
      assert.equal(chooseRow(game, game.chooser, Math.floor(rng() * ROW_COUNT)), null);
    } else if (game.phase === 'round_over') {
      rounds += 1;
      checkConservation(game, highest);
      assert.ok(game.players.every((p) => p.score < TARGET_SCORE));
      assert.equal(nextRound(game, seed + rounds), null);
    } else if (game.phase === 'game_over') {
      rounds += 1;
      break;
    } else {
      assert.fail(`unexpected phase ${game.phase}`);
    }

    // Invariants that must hold after every single action.
    for (const row of game.rows) {
      assert.ok(row.length >= 1 && row.length <= ROW_LIMIT);
    }
    const seen = new Set();
    for (const row of game.rows) {
      for (const c of row) {
        assert.ok(c >= 1 && c <= highest);
        assert.ok(!seen.has(c), `card ${c} is on the table twice`);
        seen.add(c);
      }
    }
    for (const p of game.players) {
      for (const c of p.hand) {
        assert.ok(!seen.has(c), `card ${c} is both on the table and in a hand`);
        seen.add(c);
      }
    }
  }

  assert.equal(game.phase, 'game_over');
  assert.ok(game.players.some((p) => p.score >= TARGET_SCORE));
  const best = Math.min(...game.players.map((p) => p.score));
  assert.deepEqual(
    game.winners.slice().sort(),
    game.players.filter((p) => p.score === best).map((p) => p.id).sort(),
  );
  assert.ok(rounds >= 1);
  assert.equal(tricks % HAND_SIZE, 0, 'every round is exactly ten tricks');
  return { rounds, tricks, game };
}

/** No bull head is created or lost: table + taken must equal what was dealt. */
function checkConservation(game, highest) {
  const onTable = game.rows.flat();
  const taken = game.players.flatMap((p) => p.roundTaken);
  const all = onTable.concat(taken).sort((a, b) => a - b);
  const expected = game.players.length * HAND_SIZE + ROW_COUNT;
  assert.equal(all.length, expected, 'every dealt card is on the table or taken');
  assert.equal(new Set(all).size, expected, 'no duplicates');
  for (const c of all) assert.ok(c >= 1 && c <= highest);
}

test('random full games hold their invariants at every table size', () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    for (const pro of [false, true]) {
      const { game } = simulate(n, pro, n * 31 + (pro ? 7 : 0));
      assert.equal(game.players.length, n);
    }
  }
});

test('a round is exactly ten tricks and scores carry across rounds', () => {
  const game = newGame(3, false, 21);
  const rng = makeRng(4);
  for (let trick = 1; trick <= HAND_SIZE; trick++) {
    assert.equal(game.trick, trick);
    for (const p of game.players) selectCard(game, p.id, p.hand[0]);
    resolveIfReady(game);
    while (game.phase === 'choose_row') {
      chooseRow(game, game.chooser, Math.floor(rng() * ROW_COUNT));
    }
  }
  assert.equal(game.phase, 'round_over');
  assert.ok(game.players.every((p) => p.hand.length === 0));
  const carried = game.players.map((p) => p.score);
  assert.equal(nextRound(game, 22), null);
  assert.equal(game.round, 2);
  assert.equal(game.trick, 1);
  assert.deepEqual(game.players.map((p) => p.score), carried);
  assert.ok(game.players.every((p) => p.hand.length === HAND_SIZE));
});

test('nextRound is refused unless the round is actually over', () => {
  const game = newGame(3, false, 2);
  assert.equal(nextRound(game, 3), 'not_round_over');
});
