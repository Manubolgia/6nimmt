/* Every screen renders to a string of HTML; app.js owns the state and events. */

import { esc } from './dom.js';
import { icon, markSvg } from './art.js';
import {
  BULL_GLYPH,
  cardFace,
  cardLabel,
  revealMarkup,
  rowsMarkup,
  waitingMarkup,
} from './cards.js';
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROW_LIMIT,
  TARGET_SCORE,
  WILD_COUNT,
  bullHeads,
  deckSize,
  isWild,
  previewPlay,
} from './engine.js';
import { TURN_SECONDS } from './timing.js';

const STATUS_TEXT = {
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  online: '',
  offline: 'Offline',
};

/**
 * Whoever has the fewest bull heads right now. Nobody leads a table where
 * nothing has been taken yet, and a tie leads jointly.
 */
function leaders(players) {
  const best = Math.min(...players.map((p) => p.score));
  const worst = Math.max(...players.map((p) => p.score));
  if (worst === 0) return new Set();
  return new Set(players.filter((p) => p.score === best).map((p) => p.id));
}

function clockSetting(seconds) {
  return seconds > 0 ? `${seconds}s` : 'Off';
}

/* ------------------------------- home ------------------------------- */

export function renderHome(app) {
  const busy = app.busy ? ' disabled' : '';
  return `
    <div class="grow center pad stack--xl">
      <div class="brand">
        <div class="brand__mark">${markSvg({ size: '100%' })}</div>
        <div>
          <div class="brand__name">6&nbsp;nimmt!</div>
          <div class="subtitle">Take 5 &middot; ${MIN_PLAYERS}&ndash;${MAX_PLAYERS} players</div>
        </div>
      </div>

      <div class="stack">
        <label class="label" for="name-input">Your name</label>
        <input class="field" id="name-input" type="text" maxlength="14"
          autocomplete="nickname" enterkeyhint="done" placeholder="Name"
          value="${esc(app.name)}" />
      </div>

      <div class="stack">
        <button class="btn btn--primary" data-act="create"${busy}>
          ${icon('plus')}<span>Create room</span>
        </button>
        <button class="btn" data-act="goto-join"${busy}>
          ${icon('enter')}<span>Join room</span>
        </button>
      </div>
      ${app.notice ? notice(app.notice) : ''}
    </div>
    <div class="hr"></div>
    <div class="pad btn-row">
      <button class="btn btn--ghost" data-act="rules">Rules</button>
      <button class="btn btn--ghost" data-act="settings">Settings</button>
    </div>
  `;
}

function notice(text) {
  return `<div class="notice">${icon('warn')}<span>${esc(text)}</span></div>`;
}

/* ------------------------------- join ------------------------------- */

export function renderJoin(app) {
  return `
    ${head('Join room', 'home')}
    <div class="grow center pad stack--lg">
      <div class="stack">
        <label class="label" for="code-input">Room code</label>
        <input class="field field--code" id="code-input" type="text" maxlength="4"
          inputmode="text" autocapitalize="characters" autocorrect="off"
          spellcheck="false" enterkeyhint="go" placeholder="&mdash;&mdash;&mdash;&mdash;"
          value="${esc(app.codeDraft)}" />
      </div>
      <div class="stack">
        <label class="label" for="join-name">Your name</label>
        <input class="field" id="join-name" type="text" maxlength="14"
          autocomplete="nickname" enterkeyhint="go" placeholder="Name"
          value="${esc(app.name)}" />
      </div>
      <button class="btn btn--primary" data-act="join"
        ${app.codeDraft.length === 4 ? '' : 'disabled'}>
        ${icon('enter')}<span>Join</span>
      </button>
      ${app.notice ? notice(app.notice) : ''}
    </div>
  `;
}

function head(title, backTo) {
  return `
    <div class="screen-head">
      <button class="icon-btn" data-act="back" data-to="${backTo}" aria-label="Back">
        ${icon('back')}
      </button>
      <div class="screen-head__title">${esc(title)}</div>
    </div>
  `;
}

/* ------------------------------ lobby ------------------------------- */

export function renderLobby(app) {
  const s = app.state;
  if (!s) return '';
  const count = s.players.length;
  const seats = s.players
    .map((p, i) => {
      const tags = [];
      if (p.isHost) tags.push('Host');
      if (p.id === s.you) tags.push('You');
      if (!p.connected) tags.push('Away');
      const canKick = s.isHost && p.id !== s.you;
      return `
        <div class="seat${p.id === s.you ? ' seat--you' : ''}">
          <span class="seat__idx num">${i + 1}</span>
          <span class="dot ${p.connected ? 'dot--on' : 'dot--off'}"></span>
          <span class="seat__name">${esc(p.name)}</span>
          <span class="seat__tag">${tags.join(' &middot; ')}</span>
          ${canKick ? `<button class="icon-btn icon-btn--bare" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${icon('close')}</button>` : ''}
        </div>`;
    })
    .join('');

  // Always describe what the variant would do, whether or not it is on.
  const highest = deckSize(Math.max(count, MIN_PLAYERS), true);

  return `
    ${head('Room', 'leave')}
    <div class="grow scroll pad stack stack--lg">
      <div class="code-plate">
        <div>
          <div class="label">Room code</div>
          <div class="code-plate__code">${esc(s.code)}</div>
        </div>
        <button class="icon-btn" data-act="copy" aria-label="Copy room code">
          ${icon('copy')}
        </button>
      </div>

      <div class="stack">
        <div class="label">Players ${count}/${MAX_PLAYERS}</div>
        ${seats}
        ${count < MIN_PLAYERS ? '<div class="seat seat--empty"><span class="seat__name">Waiting for one more player</span></div>' : ''}
      </div>

      <div class="stack">
        <div class="label">Variants</div>
        <button class="toggle" data-act="variant" aria-pressed="${s.proVariant}"
          ${s.isHost ? '' : 'disabled'}>
          <span>
            <span class="toggle__name">Professional variant</span><br />
            <span class="toggle__hint">Deck trimmed to 1&ndash;${highest}, so every card is dealt</span>
          </span>
          <span class="toggle__box">${icon('check')}</span>
        </button>
        <button class="toggle toggle--wild" data-act="wild" aria-pressed="${!!s.wildVariant}"
          ${s.isHost ? '' : 'disabled'}>
          <span>
            <span class="toggle__name">${icon('bolt')}Wildcards</span><br />
            <span class="toggle__hint">${WILD_COUNT} cards are dealt wild &middot; free to place, and
              they go wherever you say</span>
          </span>
          <span class="toggle__box">${icon('check')}</span>
        </button>
      </div>

      <div class="stack">
        <div class="label">Turn clock</div>
        <div class="stepper">
          <span>
            <span class="toggle__name">${icon('timer')}${clockSetting(s.turnSeconds)}</span><br />
            <span class="toggle__hint">${
              s.turnSeconds > 0
                ? 'Per choice, then it is played for you'
                : 'No limit; only dropouts are played for'
            }</span>
          </span>
          <span class="stepper__btns">
            <button class="icon-btn" data-act="clock" data-step="-1" aria-label="Less time"
              ${s.isHost && s.turnSeconds !== TURN_SECONDS[0] ? '' : 'disabled'}>${icon('minus')}</button>
            <button class="icon-btn" data-act="clock" data-step="1" aria-label="More time"
              ${s.isHost && s.turnSeconds !== TURN_SECONDS[TURN_SECONDS.length - 1] ? '' : 'disabled'}>${icon('plus')}</button>
          </span>
        </div>
      </div>
    </div>
    <div class="pad stack">
      ${
        s.isHost
          ? `<button class="btn btn--primary" data-act="start" ${count >= MIN_PLAYERS ? '' : 'disabled'}>
              <span>${count >= MIN_PLAYERS ? 'Start game' : `Need ${MIN_PLAYERS - count} more`}</span>
            </button>`
          : '<button class="btn" disabled><span>Waiting for host</span></button>'
      }
      <button class="btn btn--ghost" data-act="rules">Rules</button>
    </div>
  `;
}

/* ------------------------------- game -------------------------------- */

export function renderGame(app) {
  const s = app.state;
  if (!s || !s.game) return '';
  const g = s.game;
  const rows = app.view.rows || g.rows;
  const names = new Map(s.players.map((p) => [p.id, p.name]));

  const picking = g.phase === 'choose_row' && g.chooser === s.you && app.view.caughtUp;
  const selecting = g.phase === 'select' && s.yourCard === null;
  const preview =
    selecting && app.selected !== null ? previewPlay(rows, app.selected) : null;
  const choice = pendingChoice(g);
  const wildPick = picking && choice && isWild(choice.card);

  const reveal = g.log.find((e) => e.t === 'reveal');
  // The strip keeps its place even before the first reveal, so the board never
  // jumps under a thumb that is already reaching for a card.
  const revealBlock = reveal
    ? revealMarkup(reveal.cards, names, app.view.resolved)
    : waitingMarkup(s.players);

  return `
    <div class="board">
      <div class="topbar">
        <span class="topbar__code">${esc(s.code)}</span>
        <span class="topbar__meta">Round ${g.round} &middot; Trick ${g.trick}/${HAND_SIZE}</span>
        ${connBadge(app.status)}
        <button class="icon-btn" data-act="standings" aria-label="Standings">
          ${icon('standings')}
        </button>
      </div>

      <div class="roster" id="roster">${roster(s)}</div>

      <div class="board__main">
        <div class="rows">
          ${rowsMarkup(rows, {
            pick: picking,
            sweep: app.view.sweep,
            land: app.view.land,
            targetRow: preview && !preview.takes ? preview.row : undefined,
            hot: preview && preview.takes && preview.row >= 0 ? [preview.row] : [],
            costly: wildPick
              ? rows.map((r, i) => (r.length >= ROW_LIMIT ? i : -1)).filter((i) => i >= 0)
              : [],
          })}
        </div>

        <div class="reveal${app.view.freshTrick ? ' is-fresh' : ''}" id="reveal">${revealBlock}</div>
      </div>

      <div class="status ${picking || selecting ? 'status--act' : ''}">
        <span class="status__text">${statusLine(app, s, g)}</span>
        ${clockMarkup(s)}
      </div>

      <div class="hand-wrap">
        <div class="hint ${preview && preview.takes ? 'hint--warn' : ''}">
          ${handHint(app, s, g, preview, wildPick)}
        </div>
        <div class="hand${app.view.freshHand ? ' is-dealt' : ''}" id="hand">${hand(app, s, g)}</div>
        ${playButton(app, s, g, picking)}
      </div>
    </div>
  `;
}

/** The card whose owner is being asked to name a row, if anyone is. */
function pendingChoice(g) {
  if (g.phase !== 'choose_row') return null;
  const marks = g.log.filter((e) => e.t === 'need_choice');
  return marks.length ? marks[marks.length - 1] : null;
}

/**
 * The turn clock. Only the shell is rendered: app.js ticks the numbers so the
 * countdown does not force the whole board through a re-render every second.
 */
function clockMarkup(s) {
  if (!s.turnSeconds || !s.deadlineAt) return '';
  return `
    <div class="clock" id="clock" aria-hidden="true">
      <span class="clock__bar"><span class="clock__fill" id="clock-fill"></span></span>
      <span class="clock__num num" id="clock-num">${s.turnSeconds}</span>
    </div>`;
}

function connBadge(status) {
  const text = STATUS_TEXT[status];
  if (!text) return '';
  return `<span class="label conn">${icon('signal', { size: 12 })}${esc(text)}</span>`;
}

function roster(s) {
  const ahead = leaders(s.players);
  return s.players
    .map((p) => {
      const cls = ['chip'];
      if (p.id === s.you) cls.push('chip--you');
      if (!p.connected) cls.push('chip--gone');
      if (p.hasSelected) cls.push('chip--ready');
      if (ahead.has(p.id)) cls.push('chip--lead');
      return `
        <div class="${cls.join(' ')}">
          <span class="dot ${p.hasSelected ? 'dot--on' : 'dot--off'}"></span>
          ${ahead.has(p.id) ? `<span class="chip__crown" title="Fewest bull heads">${icon('crown')}</span>` : ''}
          <span class="chip__name">${esc(p.name)}</span>
          <span class="chip__score">${BULL_GLYPH}<span class="num">${p.score}</span></span>
        </div>`;
    })
    .join('');
}

function statusLine(app, s, g) {
  if (!app.view.caughtUp) return 'Resolving';
  if (g.phase === 'choose_row') {
    const choice = pendingChoice(g);
    const wild = choice && isWild(choice.card);
    if (g.chooser === s.you) {
      return wild ? 'Wildcard &mdash; name a row' : 'Too low &mdash; take a row';
    }
    return `${esc(nameOf(s, g.chooser))} is ${wild ? 'placing a wildcard' : 'taking a row'}`;
  }
  if (g.phase === 'round_over') return 'Round complete';
  if (g.phase === 'game_over') return 'Game over';
  if (g.phase === 'select') {
    if (s.yourCard === null) return 'Choose a card';
    const waiting = s.players.filter((p) => !p.hasSelected).length;
    return waiting === 0
      ? 'Revealing'
      : `Waiting for ${waiting} player${waiting === 1 ? '' : 's'}`;
  }
  return 'Resolving';
}

function nameOf(s, id) {
  const p = s.players.find((x) => x.id === id);
  return p ? p.name : 'Someone';
}

function handHint(app, s, g, preview, wildPick) {
  if (g.phase === 'choose_row' && g.chooser === s.you && app.view.caughtUp) {
    return wildPick
      ? `${icon('bolt')}<span>Tap any row &middot; a full one costs you</span>`
      : `${icon('warn')}<span>Tap a row to take it</span>`;
  }
  if (!preview) return '<span>&nbsp;</span>';
  // A preview of this card alone: a lower card from someone else resolves first
  // and can change where it lands.
  if (preview.kind === 'wild') {
    return `${icon('bolt')}<span>Wildcard &middot; resolves last, you pick the row</span>`;
  }
  if (preview.kind === 'too_low') {
    return `${icon('warn')}<span>Below every row &middot; you take one</span>`;
  }
  if (preview.kind === 'sixth') {
    return `${icon('warn')}<span>Takes row ${preview.row + 1} &middot; ${preview.bulls}${BULL_GLYPH}</span>`;
  }
  return `<span>Row ${preview.row + 1} &middot; adds ${bullHeads(app.selected)}${BULL_GLYPH} to it</span>`;
}

function hand(app, s, g) {
  const locked = g.phase !== 'select' || s.yourCard !== null || !app.view.caughtUp;
  return s.hand
    .map((card, i) => {
      const committed = s.yourCard === card;
      const sel = committed || app.selected === card;
      return `<button class="hand__card" data-act="pick" data-card="${card}" style="--i:${i}"
        ${locked ? 'disabled' : ''} aria-pressed="${sel}"
        aria-label="${cardLabel(card)}">
        ${cardFace(card, { sel })}
      </button>`;
    })
    .join('');
}

function playButton(app, s, g, picking) {
  if (picking) {
    return '<button class="btn" disabled><span>Choose a row above</span></button>';
  }
  if (g.phase === 'select' && s.yourCard === null) {
    const ready = app.selected !== null && app.view.caughtUp;
    const name = isWild(app.selected) ? 'the wildcard' : app.selected;
    return `<button class="btn btn--primary" data-act="play" ${ready ? '' : 'disabled'}>
      <span>${app.selected === null ? 'Select a card' : `Play ${name}`}</span>
    </button>`;
  }
  if (g.phase === 'select') {
    return '<button class="btn" disabled><span>Card played</span></button>';
  }
  return '<button class="btn" disabled><span>&mdash;</span></button>';
}

/* ------------------------------ scores ------------------------------- */

export function renderScores(app) {
  const s = app.state;
  if (!s || !s.game) return '';
  const g = s.game;
  const over = g.phase === 'game_over';
  const ranked = s.players.slice().sort((a, b) => a.score - b.score);
  const winners = new Set(g.winners || []);
  const ahead = over ? winners : leaders(s.players);

  const rows = ranked
    .map((p, i) => {
      const cls = ['score-row'];
      if (over && winners.has(p.id)) cls.push('score-row--win');
      if (ahead.has(p.id)) cls.push('score-row--lead');
      return `
        <div class="${cls.join(' ')}" style="--i:${i}">
          <span class="score-row__rank num">${i + 1}</span>
          ${ahead.has(p.id) ? `<span class="score-row__crown">${icon('crown')}</span>` : ''}
          <span class="score-row__name">${esc(p.name)}${p.id === s.you ? ' &middot; you' : ''}</span>
          <span class="score-row__delta num">+${p.roundScore}</span>
          <span class="score-row__total num">${BULL_GLYPH}${p.score}</span>
        </div>`;
    })
    .join('');

  const title = over ? 'Final standings' : `Round ${g.round} complete`;
  const sub = over
    ? `${esc(ranked.filter((p) => winners.has(p.id)).map((p) => p.name).join(', '))} ${winners.size > 1 ? 'tie for the win' : 'wins'} with the fewest bull heads`
    : `Game ends after the round somebody reaches ${TARGET_SCORE}`;

  return `
    <div class="pad stack stack--tight screen-title">
      <div class="title">${title}</div>
      <div class="subtitle">${sub}</div>
    </div>
    <div class="grow scroll pad stack">${rows}</div>
    <div class="pad stack">
      ${
        over
          ? s.isHost
            ? `<button class="btn btn--primary" data-act="rematch"><span>Rematch</span></button>
               <button class="btn btn--ghost" data-act="to-lobby"><span>Back to lobby</span></button>`
            : '<button class="btn" disabled><span>Waiting for host</span></button>'
          : s.isHost
            ? '<button class="btn btn--primary" data-act="next-round"><span>Next round</span></button>'
            : '<button class="btn" disabled><span>Waiting for host</span></button>'
      }
      <button class="btn btn--ghost" data-act="leave"><span>Leave room</span></button>
    </div>
  `;
}

/* ----------------------------- settings ------------------------------ */

export function renderSettings(app) {
  const theme = app.theme;
  return `
    ${head('Settings', 'home')}
    <div class="grow scroll pad stack stack--lg">
      <div class="stack">
        <div class="label">Appearance</div>
        <button class="toggle" data-act="theme" aria-pressed="${theme === 'dark'}">
          <span>
            <span class="toggle__name">${theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Match system'}</span><br />
            <span class="toggle__hint">Tap to cycle system, light, dark</span>
          </span>
          <span class="toggle__box toggle__box--plain">
            ${theme === 'dark' ? icon('moon') : icon('sun')}
          </span>
        </button>
      </div>

      ${
        app.canInstall
          ? `<div class="stack">
              <div class="label">Install</div>
              <button class="btn" data-act="install">${icon('plus')}<span>Add to home screen</span></button>
            </div>`
          : ''
      }
    </div>
  `;
}

/* ------------------------------ sheets ------------------------------- */

export function rulesSheet() {
  return `
    <div class="stack stack--lg">
      <div class="screen-head screen-head--bare">
        <div class="screen-head__title">Rules</div>
        <button class="icon-btn" data-act="close-sheet" aria-label="Close">${icon('close')}</button>
      </div>
      <dl class="rules">
        <dt>Goal</dt>
        <dd>Collect as few bull heads as possible. The game ends after the round in
          which somebody reaches ${TARGET_SCORE}; fewest bull heads wins.</dd>

        <dt>Deck</dt>
        <dd>Cards 1&ndash;104. Card 55 is worth 7 bull heads, multiples of 11 are
          worth 5, multiples of 10 are worth 3, other multiples of 5 are worth 2,
          and everything else 1.</dd>

        <dt>Deal</dt>
        <dd>${HAND_SIZE} cards each, then four face-up cards start the four rows.</dd>

        <dt>The trick</dt>
        <dd>Everyone plays one card face down, then all are revealed and resolved
          in ascending order &mdash; lowest card first.</dd>

        <dt>Placing</dt>
        <dd>A card joins the row whose end card is the highest one still lower than
          it. A row never grows past five cards: play the sixth and you take the
          five below it, and your card starts the row again.</dd>

        <dt>Too low</dt>
        <dd>If your card is lower than every row&rsquo;s end card, you take a whole
          row of your choice and your card starts that row.</dd>

        <dt>Professional variant</dt>
        <dd>The deck is trimmed to ten cards per player plus the four starters, so
          nothing is left out of play and counting cards is possible.</dd>

        <dt>Wildcards</dt>
        <dd>An optional twist, and it combines with the professional variant.
          ${WILD_COUNT} of the cards dealt out are wildcards: worth no bull heads,
          they resolve after every numbered card in the trick, and their owner
          names the row. A row with room takes one for nothing; a full row costs
          you its five cards as usual. A wildcard has no number of its own, so
          later cards read the row as ending on the highest number underneath.</dd>
      </dl>
      <button class="btn btn--ghost" data-act="close-sheet"><span>Close</span></button>
    </div>
  `;
}

export function standingsSheet(app) {
  const s = app.state;
  const ranked = s.players.slice().sort((a, b) => a.score - b.score);
  const ahead = leaders(s.players);
  return `
    <div class="stack stack--lg">
      <div class="screen-head screen-head--bare">
        <div class="screen-head__title">Standings</div>
        <button class="icon-btn" data-act="close-sheet" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="stack">
        ${ranked
          .map(
            (p, i) => `
          <div class="score-row${ahead.has(p.id) ? ' score-row--lead' : ''}" style="--i:${i}">
            <span class="score-row__rank num">${i + 1}</span>
            ${ahead.has(p.id) ? `<span class="score-row__crown">${icon('crown')}</span>` : ''}
            <span class="score-row__name">${esc(p.name)}${p.connected ? '' : ' &middot; away'}</span>
            <span class="score-row__delta num">+${p.roundScore}</span>
            <span class="score-row__total num">${BULL_GLYPH}${p.score}</span>
          </div>`,
          )
          .join('')}
      </div>
      <div class="subtitle">Game ends after the round somebody reaches ${TARGET_SCORE}.</div>
      <button class="btn btn--ghost" data-act="leave"><span>Leave room</span></button>
      <button class="btn btn--ghost" data-act="close-sheet"><span>Close</span></button>
    </div>
  `;
}
