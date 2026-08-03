/* Card, row and reveal-strip markup. */

import { bullHeads, bullTotal, isWild, ROW_LIMIT } from './engine.js';
import { bullSvg, icon } from './art.js';
import { esc } from './dom.js';

const BULL_GLYPH = bullSvg();
const WILD_GLYPH = icon('bolt');

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
  if (isWild(card)) cls.push('card--wild');
  if (opts.sel) cls.push('card--sel');
  if (opts.cls) cls.push(opts.cls);
  const face = isWild(card)
    ? `<div class="card__num card__wild">${WILD_GLYPH}</div><div class="card__bulls"></div>`
    : `<div class="card__num num">${card}</div>` +
      `<div class="card__bulls">${bullStrip(bullHeads(card))}</div>`;
  return `<div class="${cls.join(' ')}">${face}</div>`;
}

/** How a card is read out: wildcards have no number to announce. */
export function cardLabel(card) {
  return isWild(card)
    ? 'Wildcard, no bull heads'
    : `Card ${card}, ${bullHeads(card)} bull heads`;
}

/** Face-down placeholder for a player who has committed a card. */
function cardBack() {
  return (
    '<div class="card card--back">' +
    '<div class="card__num num">&middot;</div>' +
    '<div class="card__bulls"></div>' +
    '</div>'
  );
}

/**
 * The strip before anything is revealed: one slot per seat, face down once that
 * player has committed. It holds the place the revealed cards will take, so the
 * board does not jump when the trick turns over.
 * @param {{id: string, name: string, hasSelected: boolean}[]} players
 */
export function waitingMarkup(players) {
  return players
    .map(
      (p, i) => `
        <div class="reveal__item${p.hasSelected ? '' : ' reveal__item--waiting'}" style="--i:${i}">
          <div class="reveal__card">${p.hasSelected ? cardBack() : '<div class="slot slot--empty"></div>'}</div>
          <div class="reveal__who">${esc(p.name)}</div>
        </div>`,
    )
    .join('');
}

/**
 * The four rows.
 * @param {number[][]} rows
 * @param {{negative?: boolean, pick?: boolean, targetRow?: number, hot?: number[],
 *          sweep?: number, land?: {row: number, slot: number}, costly?: number[]}} opts
 *   negative  — negative wildcard mode: a row's total is signed by its wildcards
 *   pick      — rows are tappable (the player must take one)
 *   targetRow — row the currently selected card would join
 *   hot       — rows to mark as expensive to play into
 *   sweep     — row whose cards are fading out on their way to a player
 *   land      — the card that has just this moment been placed
 *   costly    — rows that would cost bull heads to pick right now
 */
export function rowsMarkup(rows, opts = {}) {
  const costly = opts.costly || [];
  return rows
    .map((row, i) => {
      const cls = ['row'];
      if (opts.pick) cls.push('row--pick');
      if (opts.pick || (opts.hot || []).includes(i)) cls.push('row--hot');
      if (opts.sweep === i) cls.push('row--swept');
      if (costly.includes(i)) cls.push('row--costly');
      const total = bullTotal(row, opts.negative);
      if (total < 0) cls.push('row--pays');
      const slots = [];
      for (let s = 0; s < ROW_LIMIT; s++) {
        const card = row[s];
        if (card === undefined) {
          const isTarget = opts.targetRow === i && s === row.length;
          slots.push(
            `<div class="slot slot--empty${isTarget ? ' slot--target' : ''}"></div>`,
          );
        } else {
          const marks = [];
          if (opts.sweep === i) marks.push('card--taken');
          if (opts.land && opts.land.row === i && opts.land.slot === s) {
            marks.push('card--land');
          }
          slots.push(`<div class="slot">${cardFace(card, { cls: marks.join(' ') })}</div>`);
        }
      }
      const shown = total < 0 ? `&minus;${Math.abs(total)}` : `${total}`;
      const read =
        total < 0 ? `${Math.abs(total)} bull heads back` : `${total} bull heads`;
      const label = opts.pick
        ? `<button class="row__bulls" data-row="${i}" aria-label="Take row ${i + 1}, ${read}">${BULL_GLYPH}<span class="num">${shown}</span></button>`
        : `<div class="row__bulls">${BULL_GLYPH}<span class="num">${shown}</span></div>`;
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
        `<div class="${cls.join(' ')}" style="--i:${i}">` +
        `<div class="reveal__card">${cardFace(entry.card)}</div>` +
        `<div class="reveal__who">${esc(who)}</div>` +
        '</div>'
      );
    })
    .join('');
}

export { BULL_GLYPH };
