/* Card, row and reveal-strip markup. */

import { bullHeads, bullTotal, ROW_LIMIT } from './engine.js';
import { bullSvg } from './art.js';
import { esc } from './dom.js';

const BULL_GLYPH = bullSvg();

function bullStrip(count) {
  return BULL_GLYPH.repeat(count);
}

/**
 * A single card face.
 * @param {number} card
 * @param {{sel?: boolean, cls?: string}} opts
 */
export function cardFace(card, opts = {}) {
  const cls = ['card'];
  if (opts.sel) cls.push('card--sel');
  if (opts.cls) cls.push(opts.cls);
  return (
    `<div class="${cls.join(' ')}">` +
    `<div class="card__num num">${card}</div>` +
    `<div class="card__bulls">${bullStrip(bullHeads(card))}</div>` +
    '</div>'
  );
}

/** Face-down placeholder used for opponents who have committed a card. */
export function cardBack() {
  return (
    '<div class="card card--back">' +
    '<div class="card__num num">&middot;</div>' +
    '<div class="card__bulls"></div>' +
    '</div>'
  );
}

/**
 * The four rows.
 * @param {number[][]} rows
 * @param {{pick?: boolean, targetRow?: number, hot?: number[], sweep?: number}} opts
 *   pick      — rows are tappable (the player must take one)
 *   targetRow — row the currently selected card would join
 *   sweep     — row whose cards are fading out on their way to a player
 */
export function rowsMarkup(rows, opts = {}) {
  return rows
    .map((row, i) => {
      const cls = ['row'];
      if (opts.pick) cls.push('row--pick');
      if (opts.pick || (opts.hot || []).includes(i)) cls.push('row--hot');
      const total = bullTotal(row);
      const slots = [];
      for (let s = 0; s < ROW_LIMIT; s++) {
        const card = row[s];
        if (card === undefined) {
          const isTarget = opts.targetRow === i && s === row.length;
          slots.push(
            `<div class="slot slot--empty${isTarget ? ' slot--target' : ''}"></div>`,
          );
        } else {
          const sweeping = opts.sweep === i;
          slots.push(
            `<div class="slot">${cardFace(card, { cls: sweeping ? 'card--taken' : '' })}</div>`,
          );
        }
      }
      const label = opts.pick
        ? `<button class="row__bulls" data-row="${i}" aria-label="Take row ${i + 1}, ${total} bull heads">${BULL_GLYPH}<span class="num">${total}</span></button>`
        : `<div class="row__bulls">${BULL_GLYPH}<span class="num">${total}</span></div>`;
      return `<div class="${cls.join(' ')}" data-row-index="${i}">${label}${slots.join('')}</div>`;
    })
    .join('');
}

/**
 * The revealed cards for the current trick, in resolution order.
 * @param {{playerId: string, card: number}[]} reveal
 * @param {Map<string,string>} names
 * @param {number} doneCount how many have already been resolved
 */
export function revealMarkup(reveal, names, doneCount) {
  return reveal
    .map((entry, i) => {
      const cls = ['reveal__item'];
      if (i < doneCount) cls.push('reveal__item--done');
      else if (i === doneCount) cls.push('reveal__item--live');
      const who = names.get(entry.playerId) || '—';
      return (
        `<div class="${cls.join(' ')}">` +
        `<div class="reveal__card">${cardFace(entry.card)}</div>` +
        `<div class="reveal__who">${esc(who)}</div>` +
        '</div>'
      );
    })
    .join('');
}

export { BULL_GLYPH };
