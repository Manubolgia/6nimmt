/*
 * Controller: owns client state, drives the screens, paces the trick
 * animation and talks to the room server.
 */

import { $, $$, delegate, sleep } from './dom.js';
import {
  createClient,
  createRoom,
  playerId,
  saveName,
  savedName,
  savedRoom,
} from './net.js';
import { MIN_PLAYERS } from './engine.js';
import { REVEAL_MS, SWEEP_MS, TURN_SECONDS, stepMs } from './timing.js';
import { watchViewport } from './layout.js';
import {
  renderGame,
  renderHome,
  renderJoin,
  renderLobby,
  renderScores,
  renderSettings,
  rulesSheet,
  standingsSheet,
} from './screens.js';

function beatMs() {
  return stepMs(app.state ? app.state.players.length : 4);
}

const THEME_KEY = '6nimmt.theme';
const THEMES = ['system', 'light', 'dark'];

const CODE_CHARS = /[^A-HJ-NP-Z2-9]/g;

/** Errors that mean the seat is gone, not that one action failed. */
const FATAL = new Set(['no_such_room', 'room_full', 'game_in_progress', 'kicked']);

const ERRORS = {
  no_such_room: 'No room with that code',
  room_full: 'That room is full',
  game_in_progress: 'That game has already started',
  kicked: 'You were removed from the room',
  need_more_players: `Need at least ${MIN_PLAYERS} players`,
  not_host: 'Only the host can do that',
  already_selected: 'Your card is already down',
  card_not_in_hand: 'You no longer hold that card',
  not_your_choice: 'Not your row to take',
  closed: 'Disconnected from the room',
};

const app = {
  screen: 'home',
  name: savedName(),
  codeDraft: '',
  state: null,
  status: 'offline',
  selected: null,
  busy: false,
  notice: '',
  theme: loadTheme(),
  canInstall: false,
  rejoining: false,
  view: emptyView(),
  /** Local deadline for the turn clock, translated out of server time. */
  clock: null,
};

function emptyView() {
  return {
    trickId: 0,
    shown: 0,
    resolved: 0,
    rows: null,
    sweep: null,
    land: null,
    caughtUp: true,
  };
}

let installPrompt = null;
let animating = false;
let currentScreen = null;
let toastTimer = null;
let clockTimer = null;

const client = createClient({
  onState(state) {
    app.busy = false;
    app.rejoining = false;
    app.notice = '';
    adoptState(state);
  },
  onError(code, detail) {
    app.busy = false;
    const text = ERRORS[code] || detail || 'Something went wrong';
    if (FATAL.has(code)) {
      const rejoining = app.rejoining;
      client.leave();
      app.state = null;
      app.view = emptyView();
      app.rejoining = false;
      // A stale remembered room is not worth an error screen: the player just
      // opened the app and the room has since expired.
      app.screen = rejoining ? 'home' : 'join';
      app.notice = rejoining ? '' : text;
      render();
    } else {
      toast(text);
    }
  },
  onStatus(status) {
    app.status = status;
    render();
  },
});

/* ----------------------------- rendering ----------------------------- */

const RENDERERS = {
  home: renderHome,
  join: renderJoin,
  lobby: renderLobby,
  game: renderGame,
  scores: renderScores,
  settings: renderSettings,
};

function screenId() {
  const s = app.state;
  if (!s) return app.screen;
  if (s.status === 'lobby') return 'lobby';
  if (!app.view.caughtUp) return 'game';
  if (s.status === 'finished') return 'scores';
  if (s.game && s.game.phase === 'round_over') return 'scores';
  return 'game';
}

/** Horizontal strips keep their scroll position across re-renders. */
const KEEP_SCROLL = ['#reveal', '#roster'];

/*
 * A screen is rebuilt from scratch on every state change, which restarts any
 * CSS animation on it. The entrance animations are therefore gated on the
 * content actually being new — otherwise the hand would flicker its way back in
 * several times a trick.
 */
let lastHand = null;
let lastTrick = null;

function render() {
  const id = screenId();
  const node = document.getElementById('screen-' + id);
  if (!node) return;

  const scrolls = KEEP_SCROLL.map((sel) => {
    const el = $(sel);
    return el ? [sel, el.scrollLeft] : null;
  }).filter(Boolean);

  const s = app.state;
  const handSig = s && s.hand ? s.hand.join(',') : '';
  app.view.freshHand = handSig !== lastHand;
  lastHand = handSig;
  const trickSig = s && s.game ? `${s.game.round}.${s.game.trickId}` : '';
  app.view.freshTrick = trickSig !== lastTrick;
  lastTrick = trickSig;

  node.innerHTML = RENDERERS[id](app);

  for (const [sel, left] of scrolls) {
    const el = $(sel);
    if (el) el.scrollLeft = left;
  }

  if (currentScreen !== id) {
    for (const el of $$('.screen')) {
      el.classList.toggle('is-active', el === node);
      if (el !== node) el.classList.remove('is-entering');
    }
    // Restart the entrance animation, which needs the class to actually change.
    node.classList.remove('is-entering');
    void node.offsetWidth;
    node.classList.add('is-entering');
    currentScreen = id;
  }

  tickClock();
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-active');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-active'), 2600);
}

/* ------------------------------ turn clock ---------------------------- */

/**
 * Paint the countdown. Deliberately outside `render`: the numbers move every
 * frame and rebuilding the board that often would restart every animation on
 * it and fight whatever the thumb is doing.
 */
function tickClock() {
  const fill = $('#clock-fill');
  if (!fill) return;
  const s = app.state;
  const total = (s && s.turnSeconds ? s.turnSeconds : 0) * 1000;
  if (!app.clock || !total) return;
  // While the previous trick is still resolving the clock has not started yet,
  // so it sits full rather than counting down time nobody can use.
  const left = Math.max(0, Math.min(total, app.clock.endsAt - Date.now()));
  fill.style.transform = `scaleX(${(left / total).toFixed(4)})`;
  const num = $('#clock-num');
  if (num) num.textContent = Math.ceil(left / 1000);
  const clock = $('#clock');
  if (clock) clock.classList.toggle('clock--urgent', left <= 3200);
}

function watchClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 100);
}

function openSheet(html) {
  $('#sheet-panel').innerHTML = html;
  $('#sheet').classList.add('is-active');
  $('#sheet').setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  $('#sheet').classList.remove('is-active');
  $('#sheet').setAttribute('aria-hidden', 'true');
}

/* --------------------------- state + anim ---------------------------- */

function adoptState(state) {
  const prev = app.state;
  app.state = state;
  // The deadline is in the server's clock; carry it over using the server's own
  // idea of "now" so a phone set to the wrong time still counts down correctly.
  app.clock = state.deadlineAt
    ? { endsAt: Date.now() + (state.deadlineAt - state.now) }
    : null;

  if (!state.game) {
    app.view = emptyView();
    app.selected = null;
    render();
    return;
  }

  if (app.view.trickId !== state.game.trickId) {
    const reveal = state.game.log.find((e) => e.t === 'reveal');
    const base = reveal ? reveal.rows : state.game.rows;
    app.view = {
      ...emptyView(),
      trickId: state.game.trickId,
      rows: base.map((r) => r.slice()),
      caughtUp: state.game.log.length === 0,
    };
    app.selected = null;
  }

  if (state.yourCard !== null) app.selected = null;
  if (!prev || prev.status !== state.status) closeSheet();

  render();
  runAnimation();
}

async function runAnimation() {
  if (animating) return;
  animating = true;
  try {
    for (;;) {
      const g = app.state && app.state.game;
      if (!g || g.trickId !== app.view.trickId) break;
      if (app.view.shown >= g.log.length) break;

      const entry = g.log[app.view.shown];
      app.view.shown += 1;
      app.view.caughtUp = false;

      if (entry.t === 'reveal') {
        app.view.rows = entry.rows.map((r) => r.slice());
        app.view.resolved = 0;
        app.view.land = null;
        render();
        await sleep(REVEAL_MS);
      } else if (entry.t === 'place') {
        app.view.rows = entry.rows.map((r) => r.slice());
        app.view.resolved += 1;
        app.view.land = { row: entry.row, slot: entry.rows[entry.row].length - 1 };
        render();
        await sleep(beatMs());
      } else if (entry.t === 'take') {
        app.view.sweep = entry.row;
        app.view.land = null;
        render();
        await sleep(SWEEP_MS);
        app.view.sweep = null;
        app.view.rows = entry.rows.map((r) => r.slice());
        app.view.resolved += 1;
        // The taker's own card is all that is left of the row it just cleared.
        app.view.land = { row: entry.row, slot: 0 };
        render();
        await sleep(beatMs());
      } else if (entry.t === 'need_choice') {
        // Only pause here while the choice is still outstanding. Once it has
        // been made the log continues past this marker, and a replay — after a
        // reconnect, say — has to run straight through it.
        if (app.view.shown >= g.log.length) break;
      }
    }
  } finally {
    animating = false;
    const g = app.state && app.state.game;
    app.view.caughtUp = !g || app.view.shown >= g.log.length;
    if (app.view.caughtUp && g) {
      app.view.rows = g.rows.map((r) => r.slice());
      app.view.land = null;
    }
    render();
  }
}

/* ------------------------------ actions ------------------------------ */

async function createAndJoin() {
  if (!requireName()) return;
  app.busy = true;
  app.notice = '';
  render();
  try {
    const code = await createRoom();
    client.join(code, app.name);
  } catch (_) {
    app.busy = false;
    app.notice = 'Could not reach the game server';
    render();
  }
}

function requireName() {
  const name = (app.name || '').trim();
  if (!name) {
    toast('Enter a name first');
    const field = $('#name-input') || $('#join-name');
    if (field) field.focus();
    return false;
  }
  app.name = name;
  saveName(name);
  return true;
}

function joinRoom() {
  if (!requireName()) return;
  if (app.codeDraft.length !== 4) return;
  app.busy = true;
  app.notice = '';
  render();
  client.join(app.codeDraft, app.name);
}

function leaveRoom() {
  client.leave(); // also forgets the remembered room
  app.state = null;
  app.view = emptyView();
  app.selected = null;
  app.screen = 'home';
  closeSheet();
  render();
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(app.theme) + 1) % THEMES.length];
  app.theme = next;
  applyTheme();
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {
    /* private mode */
  }
  render();
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch (_) {
    /* private mode */
  }
  return 'system';
}

function applyTheme() {
  document.documentElement.setAttribute(
    'data-theme',
    app.theme === 'system' ? '' : app.theme,
  );
}

/* ------------------------------ wiring ------------------------------- */

const ACTIONS = {
  create: createAndJoin,
  'goto-join': () => {
    app.screen = 'join';
    app.notice = '';
    render();
  },
  back: (el) => {
    if (el.dataset.to === 'leave') leaveRoom();
    else {
      app.screen = el.dataset.to || 'home';
      app.notice = '';
      render();
    }
  },
  join: joinRoom,
  leave: leaveRoom,
  settings: () => {
    app.screen = 'settings';
    render();
  },
  rules: () => openSheet(rulesSheet()),
  standings: () => openSheet(standingsSheet(app)),
  'close-sheet': closeSheet,
  theme: cycleTheme,
  install: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    app.canInstall = false;
    render();
  },
  copy: async () => {
    const code = app.state && app.state.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copied');
    } catch (_) {
      toast(code);
    }
  },
  variant: () => client.send({ type: 'setVariant', proVariant: !app.state.proVariant }),
  wild: () => client.send({ type: 'setWild', wildVariant: !app.state.wildVariant }),
  'wild-mode': (el) => client.send({ type: 'setWildMode', wildMode: el.dataset.mode }),
  clock: (el) => {
    const at = TURN_SECONDS.indexOf(app.state.turnSeconds);
    const next = at + Number(el.dataset.step);
    if (next < 0 || next >= TURN_SECONDS.length) return;
    client.send({ type: 'setTurnSeconds', seconds: TURN_SECONDS[next] });
  },
  kick: (el) => client.send({ type: 'kick', id: el.dataset.id }),
  start: () => client.send({ type: 'start' }),
  pick: (el) => {
    const card = Number(el.dataset.card);
    app.selected = app.selected === card ? null : card;
    render();
  },
  play: () => {
    if (app.selected === null) return;
    client.send({ type: 'play', card: app.selected });
  },
  'next-round': () => client.send({ type: 'next' }),
  rematch: () => client.send({ type: 'rematch' }),
  'to-lobby': () => client.send({ type: 'toLobby' }),
};

function boot() {
  applyTheme();
  watchViewport();
  watchClock();

  const root = $('#app');

  delegate(root, '[data-act]', 'click', (event, el) => {
    const action = ACTIONS[el.dataset.act];
    if (!action) return;
    event.preventDefault();
    action(el, event);
  });

  // Taking a row: the whole row is the target, not just its bull-head badge.
  delegate(root, '.row--pick', 'click', (event, el) => {
    const row = Number(el.dataset.rowIndex);
    if (Number.isInteger(row)) client.send({ type: 'take', row });
  });

  root.addEventListener('input', (event) => {
    const el = event.target;
    if (el.id === 'name-input' || el.id === 'join-name') {
      app.name = el.value.slice(0, 14);
      saveName(app.name.trim());
      return;
    }
    if (el.id === 'code-input') {
      const clean = el.value.toUpperCase().replace(CODE_CHARS, '').slice(0, 4);
      if (el.value !== clean) el.value = clean;
      app.codeDraft = clean;
      const button = root.querySelector('[data-act="join"]');
      if (button) button.disabled = clean.length !== 4;
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const id = event.target.id;
    if (id === 'code-input' || id === 'join-name') {
      event.preventDefault();
      joinRoom();
    } else if (id === 'name-input') {
      event.preventDefault();
      event.target.blur();
    }
  });

  $('#sheet').addEventListener('click', (event) => {
    if (event.target.id === 'sheet') closeSheet();
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    app.canInstall = true;
    if (currentScreen === 'settings') render();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    app.canInstall = false;
  });

  // A phone that has been asleep comes back with a dead socket; nudge it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && client.code) {
      client.send({ type: 'ping' });
    }
  });

  playerId(); // mint the persistent identity on first run
  render();

  // Straight back into a room that is still remembered from last time.
  const room = savedRoom();
  if (room && app.name.trim()) {
    app.rejoining = true;
    client.join(room, app.name.trim());
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* offline install is a bonus, not a requirement */
      });
    });
  }
}

boot();
