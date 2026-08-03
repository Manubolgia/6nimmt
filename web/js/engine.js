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
 *
 * One house rule is implemented alongside them, off by default and independent
 * of the professional variant. It runs in one of two modes, which are two quite
 * different games:
 *  - normal   — three of the dealt cards are replaced by wildcards. They are
 *               worth no bull heads, resolve after every numbered card, and are
 *               placed on a row of their owner's choosing.
 *  - negative — no wildcard is ever dealt. Instead a wildcard may appear on the
 *               board by itself, seeded as the second card of any row that has
 *               just been reduced to a single card (at the deal, and after every
 *               take). Each wildcard in a row multiplies what that row is worth
 *               by -1, so taking that row pays bull heads back. Because such a
 *               row is a prize, nobody may *choose* it when a card too low to
 *               place lets them take a row; the only way into it is being caught
 *               by it with the sixth card.
 */

export const ROW_COUNT = 4;
export const ROW_LIMIT = 5;
export const HAND_SIZE = 10;
export const TARGET_SCORE = 66;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const FULL_DECK = 104;
export const WILD_COUNT = 3;
/** Wildcard modes, in the order the lobby offers them. */
export const WILD_MODES = ['normal', 'negative'];
export const DEFAULT_WILD_MODE = 'normal';
/**
 * Negative mode: the chance, rolled once per row whenever that row is down to a
 * single card, that a wildcard is seeded into it as its second card.
 */
export const WILD_SEED_CHANCE = 0.35;
/** Negative mode seeds wildcards into the second slot of a row. */
export const WILD_SEED_SLOT = 1;
/**
 * At most this many rows may be paying out at once. One row always has to be
 * left claimable, or a player holding a card too low to place would have nowhere
 * legal to go.
 */
export const MAX_NEGATIVE_ROWS = ROW_COUNT - 1;

/** Anything unrecognised falls back to the plain mode. */
export function cleanWildMode(mode) {
  return WILD_MODES.includes(mode) ? mode : DEFAULT_WILD_MODE;
}

/** True when this game's wildcards turn the rows they sit in negative. */
export function negativeWilds(game) {
  return !!(game && game.wildVariant && game.wildMode === 'negative');
}

/** Wildcards are negative so they can never collide with a printed number. */
export function isWild(card) {
  return card < 0;
}

/** Sort key: wildcards rank after every numbered card, in a stable order. */
export function cardOrder(card) {
  return isWild(card) ? FULL_DECK + 1 - card : card;
}

/**
 * The value a row ends on. Wildcards carry no number of their own, so the
 * highest numbered card still beneath them is what later cards compare against;
 * a row holding nothing but wildcards ends on 0 and takes anything.
 */
export function rowEnd(row) {
  for (let i = row.length - 1; i >= 0; i--) {
    if (!isWild(row[i])) return row[i];
  }
  return 0;
}

/** Bull heads (penalty points) printed on a card. */
export function bullHeads(card) {
  if (isWild(card)) return 0;
  if (card === 55) return 7;
  if (card % 11 === 0) return 5;
  if (card % 10 === 0) return 3;
  if (card % 5 === 0) return 2;
  return 1;
}

/**
 * The sign a pile of cards scores at. Always +1 in normal play; in negative mode
 * each wildcard in the pile flips it, so one wildcard turns the pile into a
 * refund and a second one turns it back into a cost.
 */
export function wildSign(cards, negative) {
  if (!negative) return 1;
  let sign = 1;
  for (const c of cards) {
    if (isWild(c)) sign = -sign;
  }
  return sign;
}

/**
 * Total bull heads of a list of cards. With `negative` set — the negative
 * wildcard mode — the total is signed by the wildcards among them.
 */
export function bullTotal(cards, negative) {
  let total = 0;
  for (const c of cards) total += bullHeads(c);
  // `|| 0` so a row of nothing but wildcards is 0 rather than -0, which would
  // otherwise print as "-0".
  return total * wildSign(cards, negative) || 0;
}

/**
 * Whether a row may be chosen by a player whose card was too low to place.
 * In negative mode a row that pays out is a prize, so it is off limits: the only
 * way to collect one is to be caught by it with the sixth card. Every row is
 * open in every other case, and a row is never off limits to a wildcard being
 * placed on it, which is what `wild` says.
 */
export function rowPickable(row, negative, wild) {
  if (!negative || wild) return true;
  return bullTotal(row, negative) >= 0;
}

/**
 * The rows a chooser is actually allowed to take, as indices. Never empty:
 * `MAX_NEGATIVE_ROWS` already keeps one row claimable, so the fallback here only
 * covers a board assembled by hand rather than dealt.
 */
export function pickableRows(rows, negative, wild) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (rowPickable(rows[i], negative, wild)) out.push(i);
  }
  if (out.length > 0) return out;
  return rows.map((_, i) => i);
}

/**
 * The rows this game's current chooser may take, given the card they are
 * resolving. The one place the restriction is decided, so the server, the board
 * and auto-play can never disagree about which rows are open.
 */
export function allowedRows(game, card) {
  return pickableRows(game.rows, negativeWilds(game), isWild(card));
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
 * Index of the row a numbered card must join, or -1 when the card is lower than
 * every row end and its owner has to take a row instead. Wildcards never reach
 * here: their owner always names the row.
 */
export function targetRow(rows, card) {
  let best = -1;
  let bestEnd = -1;
  for (let i = 0; i < rows.length; i++) {
    const end = rowEnd(rows[i]);
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
 * Replace `WILD_COUNT` of the cards that are about to be dealt with wildcards.
 * They displace numbered cards rather than being added to the deck, so the deal
 * still comes out at ten each plus four starters — and because only the dealt
 * portion is touched, no row ever starts on a wildcard.
 *
 * Normal mode only; negative mode never deals a wildcard, it seeds them onto the
 * board instead — see `seedWildcards`.
 */
function sowWildcards(deck, dealtCount, rng) {
  const at = new Set();
  while (at.size < WILD_COUNT) at.add(Math.floor(rng() * dealtCount));
  let n = 1;
  for (const i of at) deck[i] = -n++;
}

/**
 * Seeded wildcards are identified apart from each other only so that two in one
 * row stay distinct cards; the counter runs for the life of the game.
 */
function nextWildId(game) {
  game.wildSeq = (game.wildSeq || 0) + 1;
  return -game.wildSeq;
}

/**
 * The roll that decides whether a freshly emptied row gets a wildcard. Drawn
 * from a stream seeded by the round's own seed, and stepped by a counter kept on
 * the game, so the sequence is reproducible from the stored state alone rather
 * than depending on when the function happened to be called.
 */
function seedRoll(game) {
  game.wildRolls = (game.wildRolls || 0) + 1;
  return makeRng(((game.wildSeed || 0) + game.wildRolls * 0x9e3779b9) >>> 0)();
}

/** How many rows are currently paying out rather than costing. */
export function negativeRowCount(rows, negative) {
  let n = 0;
  for (const row of rows) {
    if (bullTotal(row, negative) < 0) n += 1;
  }
  return n;
}

/**
 * Roll for a wildcard in the second slot of a single-card row, and seed one if
 * the roll succeeds and the board has room for another paying row. Returns true
 * when a wildcard was planted.
 */
function trySeedRow(game, index) {
  const row = game.rows[index];
  if (row.length !== 1 || isWild(row[0])) return false;
  // The cap is what keeps a chooser from being locked out: with one row always
  // claimable, the pick restriction can never leave them nowhere to go.
  if (negativeRowCount(game.rows, true) >= MAX_NEGATIVE_ROWS) return false;
  if (seedRoll(game) >= WILD_SEED_CHANCE) return false;
  row.push(nextWildId(game));
  return true;
}

/**
 * Negative mode: give every row that sits on a single card a chance of a
 * wildcard in its second slot. Called at the deal; after a take only the row
 * that was just cleared is rolled for. Rows that already hold more than their
 * starter are left alone.
 */
function seedWildcards(game) {
  if (!negativeWilds(game)) return;
  for (let i = 0; i < game.rows.length; i++) trySeedRow(game, i);
}

/**
 * Deal a fresh round. `players` is the ordered player list; each entry keeps
 * its running `score` across rounds.
 */
export function dealRound(game, seed) {
  const rng = makeRng(seed);
  const deck = shuffle(buildDeck(game.players.length, game.proVariant), rng);
  // Negative mode keeps wildcards out of every hand: they only ever arrive on
  // the board, so they cannot be hoarded for the last trick.
  if (game.wildVariant && !negativeWilds(game)) {
    sowWildcards(deck, game.players.length * HAND_SIZE, rng);
  }
  let at = 0;
  for (const p of game.players) {
    p.hand = deck.slice(at, at + HAND_SIZE).sort((a, b) => cardOrder(a) - cardOrder(b));
    at += HAND_SIZE;
    p.roundTaken = [];
  }
  game.rows = [];
  for (let i = 0; i < ROW_COUNT; i++) game.rows.push([deck[at++]]);
  // The seeding stream belongs to the round, so a round replays identically from
  // its seed; the wildcard ids keep counting up across rounds.
  game.wildSeed = seed >>> 0;
  game.wildRolls = 0;
  seedWildcards(game);
  game.selections = {};
  game.pending = [];
  game.chooser = null;
  game.trick = 1;
  game.trickId = (game.trickId || 0) + 1;
  game.log = [];
  game.phase = 'select';
  return game;
}

export function createGame(players, options, seed) {
  const game = {
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hand: [],
      roundTaken: [],
    })),
    proVariant: !!(options && options.proVariant),
    wildVariant: !!(options && options.wildVariant),
    wildMode: cleanWildMode(options && options.wildMode),
    rows: [],
    selections: {},
    pending: [],
    chooser: null,
    wildSeq: 0,
    wildSeed: 0,
    wildRolls: 0,
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
    .sort((a, b) => cardOrder(a.card) - cardOrder(b.card));
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
    const wild = isWild(next.card);
    const row = wild ? -1 : targetRow(game.rows, next.card);
    if (row === -1) {
      game.phase = 'choose_row';
      game.chooser = next.playerId;
      game.log.push({
        t: 'need_choice',
        playerId: next.playerId,
        card: next.card,
        reason: wild ? 'wild' : 'too_low',
      });
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
  // In negative mode a row carrying a wildcard pays out instead of costing, so
  // this is the one place a score can go down.
  const bulls = bullTotal(taken, negativeWilds(game));
  const player = playerById(game, playerId);
  player.score += bulls;
  player.roundTaken = player.roundTaken.concat(taken);
  game.rows[row] = [card];
  // The row is back to a single card, so in negative mode it gets its own roll
  // for a fresh wildcard before the snapshot the clients animate against.
  if (negativeWilds(game)) trySeedRow(game, row);
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
 * The player named by `game.chooser` resolves their card into `row`: a card
 * that was too low takes the row, a wildcard simply joins it unless the row is
 * already full. Returns an error string or null.
 */
export function chooseRow(game, playerId, row) {
  if (game.phase !== 'choose_row') return 'not_choosing';
  if (game.chooser !== playerId) return 'not_your_choice';
  if (!Number.isInteger(row) || row < 0 || row >= ROW_COUNT) return 'bad_row';
  const pick = game.pending[0];
  // A row that pays out cannot simply be claimed — unless every row does, in
  // which case somebody still has to take one and the rule steps aside.
  const allowed = allowedRows(game, pick && pick.card);
  if (!allowed.includes(row)) return 'row_not_pickable';
  const next = game.pending.shift();
  game.chooser = null;
  game.phase = 'resolving';
  if (isWild(next.card) && game.rows[row].length < ROW_LIMIT) {
    game.rows[row].push(next.card);
    game.log.push({
      t: 'place',
      playerId: next.playerId,
      card: next.card,
      row,
      reason: 'wild',
      rows: snapshot(game.rows),
    });
  } else {
    takeRow(game, next.playerId, row, next.card, isWild(next.card) ? 'wild' : 'too_low');
  }
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

/**
 * Row a bot/auto-play should take. Normally the one with the fewest bull heads —
 * in negative mode that may be a row that pays out, on the rare board where every
 * row does and the restriction has lifted. A wildcard costs nothing at all unless
 * the row is full, so among the rows with room it takes the emptiest.
 *
 * Only ever returns a row the rules would actually accept, so the turn clock
 * cannot play an illegal choice on a disconnected player's behalf.
 */
export function cheapestRow(rows, card, negative) {
  const allowed = pickableRows(rows, negative, isWild(card));
  let best = allowed[0];
  let bestCost = Infinity;
  let bestLen = Infinity;
  for (const i of allowed) {
    const free = isWild(card) && rows[i].length < ROW_LIMIT;
    const cost = free ? 0 : bullTotal(rows[i], negative);
    const len = rows[i].length;
    if (cost < bestCost || (cost === bestCost && len < bestLen)) {
      bestCost = cost;
      bestLen = len;
      best = i;
    }
  }
  return best;
}

/**
 * What happens if `card` is played into `rows` right now, ignoring the other
 * players' cards. Used for the client-side hint on the selected card.
 */
export function previewPlay(rows, card, negative) {
  if (isWild(card)) return { row: -1, takes: false, bulls: 0, kind: 'wild' };
  const row = targetRow(rows, card);
  if (row === -1) return { row: -1, takes: true, bulls: null, kind: 'too_low' };
  if (rows[row].length >= ROW_LIMIT) {
    return { row, takes: true, bulls: bullTotal(rows[row], negative), kind: 'sixth' };
  }
  // What the card does to the row's value: in negative mode a row that has been
  // flipped by a wildcard gets cheaper, not dearer, as it grows.
  const adds = bullHeads(card) * wildSign(rows[row], negative);
  return { row, takes: false, bulls: 0, adds, kind: 'place' };
}
