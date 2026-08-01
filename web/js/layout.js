/*
 * One card size for the whole board.
 *
 * Rows, hand and reveal strip all draw the same card, so its size is worked out
 * once from the space actually available and published as CSS variables. The
 * board then fits flush on any phone instead of scrolling, and a card is the
 * same size wherever it appears.
 *
 * The numbers below are the board's fixed furniture. CSS reads them back from
 * the variables this module sets, so there is only one set of measurements and
 * the budget can never drift from the layout.
 */

import { HAND_SIZE, ROW_COUNT, ROW_LIMIT } from './engine.js';

/** Height of each fixed block, borders included (everything is border-box). */
const CHROME = {
  topbar: 46,
  roster: 44,
  status: 38,
  hint: 22,
  action: 52,
};

/** Width of the bull-head column that starts every row. */
const ROW_LABEL = 32;
/** Cards are the proportions of the printed deck. */
export const CARD_ASPECT = 1.4;
const ASPECT = CARD_ASPECT;
/** Hand cards sit in a grid this wide, so ten cards are two tidy lines. */
const HAND_COLUMNS = 5;
/** The board never grows past this, so a desktop window is not absurd. */
const MAX_BOARD = 520;
/**
 * Bounds on the card, as heights because that is what is solved for. They work
 * out at 26px and 72px wide: below 26 a three-digit number stops being legible,
 * and past 72 a card stops looking like a card. A window too short even for the
 * smaller of them gets a board that scrolls rather than one that is unreadable.
 */
export const CARD_H_MIN = 37;
export const CARD_H_MAX = 101;

/** Border and padding around the hand block. */
const HAND_WRAP_TRIM = 17;
/** Padding and the player name printed under each revealed card. */
const REVEAL_TRIM = 28;

const HAND_LINES = Math.ceil(HAND_SIZE / HAND_COLUMNS);
/** Four rows, the reveal strip, and two lines of hand. */
const CARD_LINES = ROW_COUNT + HAND_LINES + 1;

function scale(box) {
  return box < 620 ? { pad: 8, gap: 3 } : box < 760 ? { pad: 11, gap: 4 } : { pad: 14, gap: 4 };
}

function clamp(lo, value, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Height the board needs for a card that tall. The single `pad` is the
 * breathing room above the first row; nothing else stacked down the board is
 * padded vertically.
 */
export function boardHeight(cardH, pad, gap) {
  return (
    CHROME.topbar +
    CHROME.roster +
    CHROME.status +
    CHROME.hint +
    CHROME.action +
    HAND_WRAP_TRIM +
    REVEAL_TRIM +
    pad +
    (ROW_COUNT - 1 + HAND_LINES) * gap +
    CARD_LINES * cardH
  );
}

/** Width one row line needs: the bull-head column, five cards, and the gaps. */
export function boardWidth(card, pad, gap) {
  return 2 * pad + ROW_LABEL + ROW_LIMIT * card + ROW_LIMIT * gap;
}

/**
 * Card size that fits `width` x `height` of usable board.
 *
 * The card's *height* is what is solved for, and in whole pixels: seven of them
 * stack down the board, so a fractional one would round up seven times over and
 * push the last line off the bottom.
 *
 * Exported so it can be reasoned about — and tested — without a DOM.
 */
export function cardSize(width, height) {
  const { pad, gap } = scale(height);
  const board = Math.min(width, MAX_BOARD);

  const byWidth = ((board - boardWidth(0, pad, gap)) / ROW_LIMIT) * ASPECT;
  const byHeight = (height - boardHeight(0, pad, gap)) / CARD_LINES;

  const cardH = clamp(CARD_H_MIN, Math.floor(Math.min(byWidth, byHeight)), CARD_H_MAX);
  return { pad, gap, cardH, card: Math.floor(cardH / ASPECT) };
}

/**
 * Usable box of a screen: its own rect less the safe-area padding the notch
 * takes. Measuring beats guessing at `env()` from script.
 */
function usable(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const trim = (a, b) => parseFloat(style[a] || 0) + parseFloat(style[b] || 0);
  return {
    width: rect.width - trim('paddingLeft', 'paddingRight'),
    height: rect.height - trim('paddingTop', 'paddingBottom'),
  };
}

/**
 * Publish the card size for the current viewport. Safe to call as often as you
 * like: nothing it reads depends on what it writes, so it never oscillates.
 */
export function applyCardSize() {
  const screen = document.getElementById('screen-game');
  if (!screen) return;
  const box = usable(screen);
  if (box.width <= 0 || box.height <= 0) return;
  const { pad, gap, card, cardH } = cardSize(box.width, box.height);
  const root = document.documentElement.style;
  root.setProperty('--card', `${card}px`);
  root.setProperty('--card-h', `${cardH}px`);
  root.setProperty('--pad', `${pad}px`);
  root.setProperty('--gap', `${gap}px`);
  root.setProperty('--row-label', `${ROW_LABEL}px`);
  for (const [name, value] of Object.entries(CHROME)) {
    root.setProperty(`--h-${name}`, `${value}px`);
  }
}

/** Recompute whenever the viewport changes shape. */
export function watchViewport() {
  applyCardSize();
  addEventListener('resize', applyCardSize);
  addEventListener('orientationchange', applyCardSize);
  // iOS resizes the visual viewport without firing `resize` on the window.
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', applyCardSize);
  }
}
