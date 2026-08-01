/*
 * 6 nimmt! rules engine.
 *
 * Pure, deterministic and side-effect free. Shared verbatim between the
 * Cloudflare Durable Object (authoritative) and the browser client (used only
 * for local previews such as "which row would this card land in").
 *
 * Official rules implemented:
 *  - 104 cards, numbered 1-104.
 *  - Bull heads: 55 -> 7; multiples of 11 -> 5; multiples of 10 -> 3;
 *    multiples of 5 -> 2; everything else -> 1.
 *  - 2-10 players, 10 cards each, 4 face-up cards start the 4 rows.
 *  - Every trick: all players choose simultaneously, then cards resolve in
 *    ascending order.
 *  - A card joins the row whose end card is the highest one still lower than
 *    it. Becoming the 6th card takes the 5 cards below it.
 *  - A card lower than every row end lets its owner take a whole row of their
 *    choice; the played card then starts that row.
 *  - A round is 10 tricks. The game ends after the round in which somebody
 *    reaches 66 bull heads; fewest bull heads wins.
 *  - Professional variant: the deck is trimmed to cards 1..(10 x players + 4),
 *    so every card in the deck is in play.
 */

export const ROW_COUNT = 4;
export const ROW_LIMIT = 5;
export const HAND_SIZE = 10;
export const TARGET_SCORE = 66;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const FULL_DECK = 104;

/** Bull heads (penalty points) printed on a card. */
export function bullHeads(card) {
  if (card === 55) return 7;
  if (card % 11 === 0) return 5;
  if (card % 10 === 0) return 3;
  if (card % 5 === 0) return 2;
  return 1;
}

/** Total bull heads of a list of cards. */
export function bullTotal(cards) {
  let total = 0;
  for (const c of cards) total += bullHeads(c);
  return total;
}

/** Highest card number in play for a given player count and variant. */
export function deckSize(playerCount, proVariant) {
  if (!proVariant) return FULL_DECK;
  return playerCount * HAND_SIZE + ROW_COUNT;
}

export function buildDeck(playerCount, proVariant) {
  const size = deckSize(playerCount, proVariant);
  const deck = new Array(size);
  for (let i = 0; i < size; i++) deck[i] = i + 1;
  return deck;
}

/** Deterministic PRNG so a game can be replayed from its seed. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(deck, rng) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Index of the row a card must join, or -1 when the card is lower than every
 * row end and its owner has to take a row instead.
 */
export function targetRow(rows, card) {
  let best = -1;
  let bestEnd = -1;
  for (let i = 0; i < rows.length; i++) {
    const end = rows[i][rows[i].length - 1];
    if (end < card && end > bestEnd) {
      bestEnd = end;
      best = i;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Game lifecycle
 * ------------------------------------------------------------------ */

/**
 * Deal a fresh round. `players` is the ordered player list; each entry keeps
 * its running `score` across rounds.
 */
export function dealRound(game, seed) {
  const rng = makeRng(seed);
  const deck = shuffle(buildDeck(game.players.length, game.proVariant), rng);
  let at = 0;
  for (const p of game.players) {
    p.hand = deck.slice(at, at + HAND_SIZE).sort((a, b) => a - b);
    at += HAND_SIZE;
    p.roundTaken = [];
  }
  game.rows = [];
  for (let i = 0; i < ROW_COUNT; i++) game.rows.push([deck[at++]]);
  game.selections = {};
  game.pending = [];
  game.chooser = null;
  game.trick = 1;
  game.trickId = (game.trickId || 0) + 1;
  game.log = [];
  game.phase = 'select';
  return game;
}

export function createGame(players, proVariant, seed) {
  const game = {
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hand: [],
      roundTaken: [],
    })),
    proVariant: !!proVariant,
    rows: [],
    selections: {},
    pending: [],
    chooser: null,
    round: 1,
    trick: 1,
    trickId: 0,
    log: [],
    phase: 'select',
    winners: [],
  };
  return dealRound(game, seed);
}

export function playerById(game, id) {
  return game.players.find((p) => p.id === id) || null;
}

/** True when every player has committed a card for this trick. */
export function allSelected(game) {
  return game.players.every((p) => game.selections[p.id] !== undefined);
}

/**
 * Commit a card for a player. Returns an error string, or null on success.
 * Does not advance the trick; call `resolveIfReady` afterwards.
 */
export function selectCard(game, playerId, card) {
  if (game.phase !== 'select') return 'not_selecting';
  const player = playerById(game, playerId);
  if (!player) return 'no_such_player';
  // A card played face down cannot be taken back, same as at the table.
  if (game.selections[playerId] !== undefined) return 'already_selected';
  if (!player.hand.includes(card)) return 'card_not_in_hand';
  game.selections[playerId] = card;
  return null;
}

/**
 * If every player has chosen, reveal and resolve as far as possible. Stops
 * early when somebody has to pick a row.
 */
export function resolveIfReady(game) {
  if (game.phase !== 'select' || !allSelected(game)) return false;
  const reveal = game.players
    .map((p) => ({ playerId: p.id, card: game.selections[p.id] }))
    .sort((a, b) => a.card - b.card);
  for (const entry of reveal) {
    const player = playerById(game, entry.playerId);
    player.hand = player.hand.filter((c) => c !== entry.card);
  }
  game.selections = {};
  game.pending = reveal;
  // A new resolution id: clients key their trick animation off this, so it has
  // to change exactly when the log is replaced, not when the trick counter is.
  game.trickId += 1;
  // The pre-trick rows travel with the reveal so a client that arrives late can
  // replay the whole trick from the start.
  game.log = [
    { t: 'reveal', cards: reveal.map((r) => ({ ...r })), rows: snapshot(game.rows) },
  ];
  game.phase = 'resolving';
  advance(game);
  return true;
}

/** Resolve pending cards until a choice is needed or the trick is done. */
function advance(game) {
  while (game.pending.length > 0) {
    const next = game.pending[0];
    const row = targetRow(game.rows, next.card);
    if (row === -1) {
      game.phase = 'choose_row';
      game.chooser = next.playerId;
      game.log.push({ t: 'need_choice', playerId: next.playerId, card: next.card });
      return;
    }
    game.pending.shift();
    if (game.rows[row].length >= ROW_LIMIT) {
      takeRow(game, next.playerId, row, next.card, 'sixth');
    } else {
      game.rows[row].push(next.card);
      game.log.push({
        t: 'place',
        playerId: next.playerId,
        card: next.card,
        row,
        rows: snapshot(game.rows),
      });
    }
  }
  endTrick(game);
}

function snapshot(rows) {
  return rows.map((r) => r.slice());
}

function takeRow(game, playerId, row, card, reason) {
  const taken = game.rows[row];
  const bulls = bullTotal(taken);
  const player = playerById(game, playerId);
  player.score += bulls;
  player.roundTaken = player.roundTaken.concat(taken);
  game.rows[row] = [card];
  game.log.push({
    t: 'take',
    playerId,
    card,
    row,
    reason,
    taken,
    bulls,
    rows: snapshot(game.rows),
  });
}

/**
 * The player named by `game.chooser` takes `row`. Returns an error string or
 * null.
 */
export function chooseRow(game, playerId, row) {
  if (game.phase !== 'choose_row') return 'not_choosing';
  if (game.chooser !== playerId) return 'not_your_choice';
  if (!Number.isInteger(row) || row < 0 || row >= ROW_COUNT) return 'bad_row';
  const next = game.pending.shift();
  game.chooser = null;
  game.phase = 'resolving';
  takeRow(game, next.playerId, row, next.card, 'too_low');
  advance(game);
  return null;
}

function endTrick(game) {
  const handsEmpty = game.players.every((p) => p.hand.length === 0);
  if (!handsEmpty) {
    game.trick += 1;
    game.phase = 'select';
    return;
  }
  const reached = game.players.some((p) => p.score >= TARGET_SCORE);
  if (reached) {
    const best = Math.min(...game.players.map((p) => p.score));
    game.winners = game.players.filter((p) => p.score === best).map((p) => p.id);
    game.phase = 'game_over';
  } else {
    game.phase = 'round_over';
  }
}

/** Start the next round after `phase === 'round_over'`. */
export function nextRound(game, seed) {
  if (game.phase !== 'round_over') return 'not_round_over';
  game.round += 1;
  dealRound(game, seed);
  return null;
}

/* ------------------------------------------------------------------ *
 * Helpers used by the UI and by auto-play for disconnected players
 * ------------------------------------------------------------------ */

/** Row a bot/auto-play should take: the one with the fewest bull heads. */
export function cheapestRow(rows) {
  let best = 0;
  let bestBulls = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const bulls = bullTotal(rows[i]);
    if (bulls < bestBulls) {
      bestBulls = bulls;
      best = i;
    }
  }
  return best;
}

/**
 * What happens if `card` is played into `rows` right now, ignoring the other
 * players' cards. Used for the client-side hint on the selected card.
 */
export function previewPlay(rows, card) {
  const row = targetRow(rows, card);
  if (row === -1) return { row: -1, takes: true, bulls: null, kind: 'too_low' };
  if (rows[row].length >= ROW_LIMIT) {
    return { row, takes: true, bulls: bullTotal(rows[row]), kind: 'sixth' };
  }
  return { row, takes: false, bulls: 0, kind: 'place' };
}
