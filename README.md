# 6 nimmt!

Online multiplayer **6 nimmt!** (Take 5) for 2–10 players. Installable as a
phone app, hosted on GitHub Pages, with rooms running on Cloudflare Durable
Objects. No accounts, no sign-in: the host creates a room, everybody else types
in the four-letter code.

The rules are the published ones, implemented in full — see
[Rules fidelity](#rules-fidelity) — plus one optional house rule, wildcards.

---

## How it plays

1. Host taps **Create room** and reads out the four-letter code.
2. Everyone else picks a name, taps **Join room** and types the code.
3. The host optionally turns on the **professional variant** or **wildcards**
   (normal or negative), sets the turn clock, and starts.
4. Each trick everyone commits a card at the same time; the cards are then
   revealed and resolved lowest-first.

Whoever has the fewest bull heads is marked in gold, on the table and on the
scoreboard.

Closing the tab, locking the phone or losing signal is safe: rejoining restores
the same seat and the same hand.

### The turn clock

Every choice — committing a card, taking a row — is on a clock, ten seconds by
default. When it runs out the choice is made for you: your lowest card, or the
cheapest row. The host can set it to anything from 5 to 60 seconds, or off.

The clock only starts once the previous trick has finished resolving on screen,
so the ten seconds are ten seconds of thinking rather than ten seconds of
watching an animation. With the clock off, a player who has actually dropped out
is still played for after 30 seconds, so the table is never stuck.

## Rules fidelity

| | |
|---|---|
| Deck | 104 cards, numbered 1–104 |
| Bull heads | 55 → 7; multiples of 11 → 5; multiples of 10 → 3; other multiples of 5 → 2; everything else → 1 |
| Players | 2–10 |
| Deal | 10 cards each, then 4 face-up cards start the 4 rows |
| Trick | all players choose simultaneously; cards resolve in ascending order |
| Placing | a card joins the row whose end card is the highest one still lower than it |
| Sixth card | taking a row to six cards means taking the five below it; the played card starts the row again |
| Too low | a card below every row end lets its owner take any one row; the played card starts that row |
| Round | 10 tricks, then a fresh deal |
| Game end | after the round in which somebody reaches 66 bull heads — fewest bull heads wins |
| Professional variant | deck trimmed to cards 1…(10 × players + 4), so nothing is left out of play |

Two points worth spelling out, because implementations differ:

- **The game ends at the end of a round, not the instant somebody passes 66.**
  With simultaneous play there is no other coherent moment to stop.
- **A card played face down cannot be taken back.** The server rejects a second
  `play` for the same trick.

Ties for the win are reported as ties; nobody is broken out arbitrarily.

## Wildcards

An optional house rule, off by default and independent of the professional
variant — the two combine.

A wildcard is worth no bull heads and carries no number of its own, so later
cards read its row as ending on the highest number underneath it. Where
wildcards come from, and what they do, depends on the mode chosen next to the
toggle in the lobby — the two are quite different games.

### Normal

Three of the cards dealt out are wildcards. They replace numbered cards rather
than being added to the deck, so the deal is still ten each plus four starters,
and a row never begins on one.

| | |
|---|---|
| Bull heads | none |
| Order | wildcards resolve after every numbered card in the trick |
| Placing | the owner names any row; the wildcard joins it for nothing |
| Full row | naming a row that already holds five takes it, as a sixth card would |
| Afterwards | a row holding only wildcards ends on nothing and is the last resort |

The effect is that a wildcard is an escape from a bad hand, and a way to leave
somebody else a row they cannot avoid.

### Negative

No wildcard is ever dealt. They appear on the board by themselves instead:
whenever a row is down to a single card — at the deal, and again every time a
row is taken — that row is rolled for, and on a hit a wildcard is planted as its
second card. Players play *around* them rather than with them.

| | |
|---|---|
| Chance | 35% per row, rolled each time that row is reduced to one card |
| Position | always the second card of the row |
| Worth | each wildcard in a row multiplies what that row is worth by −1 |
| Cap | at most 3 rows may be paying out at once |
| Choosing | a row that pays out **cannot be chosen** by a player whose card was too low to place |

Taking a row that holds a wildcard pays its bull heads back instead of charging
them, so a score can fall — below zero, if the round goes that way. Two
wildcards in the same row cancel and it costs again, as a third would flip it
back.

Because a paying row is a prize rather than a penalty, it is off limits to
anyone *choosing* a row: the only way into one is to be caught by it with the
sixth card. That is what makes the negative rows worth playing around — they sit
there as traps you steer other people into, and since wildcards are never in
anybody's hand they cannot be hoarded for the last trick. The cap of three
guarantees at least one row stays claimable, so a low card is never stranded.

Everything else is unchanged: the game still ends after the round in which
somebody reaches 66, and the fewest bull heads still wins.

## Architecture

```
web/          the board — plain ES modules, no build step, deployed to Pages
  js/engine.js    the rules; pure functions, no I/O
  js/timing.js    how long the trick animation runs; shared with the server
  js/layout.js    solves for the one card size the whole board uses
worker/       the room server — Cloudflare Worker + Durable Object
tools/        icon rasteriser, Workers shim, local dev server
test/         node:test suites for the rules, the room protocol and the layout
```

`web/js/engine.js` is imported unchanged by both the browser and the Durable
Object, so there is exactly one implementation of the rules. The server is
authoritative: a client is only ever sent its own hand, and other players'
cards appear only once they have been revealed. `test/room.test.mjs` asserts
that.

Each room is one Durable Object, addressed by `idFromName(code)`, holding the
game and its WebSockets. Every change re-broadcasts a per-player view of the
state; the client replays the trick log to animate the resolution.

`web/js/timing.js` is shared the same way. The client uses it to pace that
animation and the server uses it to work out when the animation will have
finished, which is when the turn clock starts.

The board is sized in script, not in CSS: `web/js/layout.js` solves for one card
size that lets four rows, the reveal strip and two lines of hand fit the screen
exactly, and publishes it as `--card`. Rows, hand and reveal strip all draw that
same card, so a card is the same size wherever it appears and nothing scrolls.
`test/layout.test.mjs` checks the arithmetic across the phones it has to
survive.

## Running it locally

```bash
npm install     # the only dependency is `ws`, for the dev server
npm run dev     # http://localhost:8787
npm test        # rules + room protocol
```

`npm run dev` serves `web/` and hosts rooms by running the real Durable Object
on a small shim (`tools/workers-shim.mjs`), so local play exercises the same
server code that gets deployed. Open the URL in two windows to play against
yourself. Rooms live in memory and vanish on restart.

## Deploying

### The board (GitHub Pages)

`.github/workflows/deploy.yml` runs the tests, checks the committed icons still
match the artwork, and publishes `web/` on every push to `main`. Enable it once
under **Settings → Pages → Source → GitHub Actions**.

### The game server (Cloudflare)

```bash
cd worker
npm install
npx wrangler deploy
```

Durable Objects need a Cloudflare account; the SQLite-backed ones this uses are
available on the free plan. `wrangler deploy` prints a
`https://6nimmt.<subdomain>.workers.dev` URL — put it in `web/js/config.js` as
`DEFAULT_SERVER` and push.

You can also point a build at a server without redeploying: open the board with
`?server=https://your-worker.workers.dev` once, and it is remembered in
`localStorage`. There is deliberately no field for this in the app — the address
belongs to the deploy, not to the player.

`.github/workflows/deploy-worker.yml` does the same from CI on demand, given
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Design

Minimal, sharp and phone-first. Every corner is square and there are no
gradients or shadows; the life comes from movement rather than decoration.
Cards rise into the hand when a new one is dealt, flash as they land on a row,
and drop away when a row is taken; screens and sheets move rather than cut.
Everything is held back by `prefers-reduced-motion`.

Colour follows 60/30/10:

| | Light | Dark |
|---|---|---|
| 60 — ground | bone `#f2ede4` | charcoal `#17181a` |
| 30 — ink and type | graphite `#26282b` | bone `#ede6da` |
| 10 — accent | ink blue `#1b3a8c` | vermilion `#e2452b` |

The accent is reserved for things that carry weight: bull heads, your turn, a
row you are about to take. Two colours sit outside the scheme because they mean
one specific thing each — gold for whoever is winning, violet for wildcards. The
theme follows the system by default and can be pinned under Settings.

All artwork is drawn here, as flat polygon geometry on a 100×100 grid in
`web/js/art.js` — the bull head, the four-bar app mark, and every interface
glyph. No emoji, no icon fonts, nothing traced. `tools/gen-icons.mjs`
scan-converts the same polygons into the PNG launcher icons with a hand-written
rasteriser and node's zlib, so the installed icon and the in-app art cannot
drift apart:

```bash
npm run icons
```

## Licence

The code here is original. *6 nimmt!* is a game by Wolfgang Kramer, published by
AMIGO Spiel + Freizeit GmbH; this project is an unofficial implementation and is
not affiliated with or endorsed by them.
