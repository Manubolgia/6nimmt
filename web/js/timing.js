/*
 * How long the trick animation takes.
 *
 * Shared between the client, which paces the animation, and the room server,
 * which has to hand out the turn clock only once the animation everyone is
 * watching has finished — otherwise a ten-second turn would be half spent
 * watching the previous trick resolve.
 */

/**
 * The turn clock the host can pick from, in seconds: how long a player has to
 * commit a card or take a row before it is done for them. 0 turns the clock
 * off, leaving only the grace period that covers players who have dropped out.
 */
export const TURN_SECONDS = [0, 5, 10, 15, 20, 30, 45, 60];
export const DEFAULT_TURN_SECONDS = 10;

/** Beat after the cards are turned face up, before the first one resolves. */
export const REVEAL_MS = 520;
/** Beat while a taken row fades out. */
export const SWEEP_MS = 200;

/* Resolving ten cards one at a time would drag, so the per-card beat shrinks
   as the table grows, keeping a trick around three seconds. */
const STEP_BUDGET_MS = 3000;
const STEP_MIN_MS = 200;
const STEP_MAX_MS = 420;

export function stepMs(playerCount) {
  const count = playerCount || 4;
  return Math.max(STEP_MIN_MS, Math.min(STEP_MAX_MS, STEP_BUDGET_MS / count));
}

/**
 * Total time the client spends replaying `log`. `need_choice` is a marker, not
 * a beat: it costs nothing and the pause it causes is the chooser's own clock.
 */
export function trickAnimationMs(log, playerCount) {
  const step = stepMs(playerCount);
  let total = 0;
  for (const entry of log || []) {
    if (entry.t === 'reveal') total += REVEAL_MS;
    else if (entry.t === 'place') total += step;
    else if (entry.t === 'take') total += SWEEP_MS + step;
  }
  return total;
}
