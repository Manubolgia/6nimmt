/*
 * The board is sized in script rather than by CSS, so the arithmetic is worth
 * pinning down: one card size for rows, hand and reveal strip, and a board that
 * fits flush on every phone instead of scrolling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_ASPECT,
  CARD_H_MAX,
  CARD_H_MIN,
  boardHeight,
  boardWidth,
  cardSize,
} from '../web/js/layout.js';

/** Phones the board actually has to survive, plus the extremes either side. */
const VIEWPORTS = [
  [320, 568],
  [360, 640],
  [375, 667],
  [390, 844],
  [412, 915],
  [430, 932],
  [520, 1000],
  [744, 1133],
  [1280, 800],
];

test('the whole board fits the screen at every size', () => {
  for (const [w, h] of VIEWPORTS) {
    const { pad, gap, card, cardH } = cardSize(w, h);
    const used = boardHeight(cardH, pad, gap);
    assert.ok(used <= h, `${w}x${h}: board wants ${used}px of ${h}px`);
    const line = boardWidth(card, pad, gap);
    assert.ok(line <= Math.min(w, 520), `${w}x${h}: a row is ${line}px wide`);
  }
});

test('and the cards are as large as that leaves room for', () => {
  for (const [w, h] of VIEWPORTS) {
    const { pad, gap, cardH } = cardSize(w, h);
    if (cardH >= CARD_H_MAX) continue; // held back by the cap, not by the screen
    const bigger = cardH + 1;
    const overflows =
      boardHeight(bigger, pad, gap) > h ||
      boardWidth(Math.floor(bigger / CARD_ASPECT), pad, gap) > Math.min(w, 520);
    assert.ok(overflows, `${w}x${h}: the card could have been ${bigger}px tall`);
  }
});

test('a window too short for the smallest card gets a scrolling table, not a smaller one', () => {
  const { cardH } = cardSize(320, 420);
  assert.equal(cardH, CARD_H_MIN, 'the card stops shrinking at the floor');
});

test('a card is never too small to read or too big to be a card', () => {
  for (const [w, h] of VIEWPORTS) {
    const { card, cardH } = cardSize(w, h);
    assert.ok(cardH >= CARD_H_MIN, `${w}x${h}: ${card}px is too small to read`);
    assert.ok(cardH <= CARD_H_MAX, `${w}x${h}: ${card}px is bigger than the cap`);
    assert.ok(cardH > card, `${w}x${h}: a card is taller than it is wide`);
    assert.ok(Number.isInteger(card) && Number.isInteger(cardH), 'whole pixels only');
  }
});

test('a taller or wider screen never gives a smaller card', () => {
  for (const [w, h] of VIEWPORTS) {
    const here = cardSize(w, h).card;
    assert.ok(cardSize(w + 60, h).card >= here, `${w}x${h}: wider shrank the card`);
    assert.ok(cardSize(w, h + 60).card >= here, `${w}x${h}: taller shrank the card`);
  }
});

test('the cap keeps a desktop window from drawing playing cards the size of a hand', () => {
  const wide = cardSize(2560, 1440);
  assert.equal(wide.card, 72);
  assert.deepEqual(wide, cardSize(1920, 1440), 'past the cap the size stops moving');
});
