// A greedy autoplayer, run headless, so the length of the climb is a measured
// number instead of a guess. `node scripts/sim.ts`.
//
// This is not a test and it does not gate anything — it answers one question
// the spec asks and a unit test cannot: does a competent run reach an ending
// inside five minutes? It also checks the bargain the design rests on, that
// the summit is reachable by a player who never discovers the fire key.
//
// The autoplayer is deliberately mediocre: it aims at the lowest reachable
// platform, refuses broken ones when it has a choice, and steers around
// monsters rather than shooting them. A human is better than this at aiming
// and worse at reacting, so treat its time as a floor, not an average.

import {
  createGame,
  resetCooldown,
  SUMMIT_Y,
  step,
  TUNING,
  WORLD_WIDTH,
  type GameState,
  type Input,
} from "../game.ts";

const STEP = 1 / 120;
const TIME_LIMIT = 60 * 8; // give up well past the five minutes we care about

/** Shortest signed distance to a target x, respecting the horizontal wrap. */
function wrapDelta(from: number, to: number): number {
  let d = to - from;
  if (d > WORLD_WIDTH / 2) d -= WORLD_WIDTH;
  if (d < -WORLD_WIDTH / 2) d += WORLD_WIDTH;
  return d;
}

export function chooseInput(state: GameState, allowFire: boolean): Input {
  const p = state.player;

  // Aim at the highest platform this arc can still reach. Using "the lowest
  // platform above me" instead made the autoplayer chase something overhead
  // while falling past the ledge under its feet, which read as the game
  // stalling when it was really the sim playing badly.
  const apex = p.y + (p.vy > 0 ? (p.vy * p.vy) / (2 * 1800) : 0);
  const reachable = state.platforms
    .filter((plat) => plat.alive && plat.y <= apex + 4 && plat.y > p.y - 520)
    .sort((a, b) => b.y - a.y);

  // Prefer a platform with no monster loitering over it.
  const safe = reachable.filter(
    (plat) =>
      !state.monsters.some(
        (m) =>
          m.alive &&
          Math.abs(m.y - plat.y) < 110 &&
          Math.abs(wrapDelta(plat.x + TUNING.PLATFORM_W / 2, m.x + TUNING.MONSTER_W / 2)) < 55,
      ),
  );
  // Never aim at a broken platform: it cannot be landed on, so "a broken one
  // with no monster near it" is not a safer choice than "a solid one that is
  // guarded" — it is not a choice at all.
  //
  // And the target has to be strictly above the player. Ranking purely by
  // safety let the autoplayer nominate the platform it was already standing
  // on, steer to stay there, and bounce until the clock ran out — nine of
  // twenty-four seeds, all of them reported as the game stalling.
  const climbable = reachable.filter((plat) => plat.kind !== "broken");
  const ascending = climbable.filter((plat) => plat.y > p.y + 4);
  const isSafe = (plat: (typeof climbable)[number]) => safe.includes(plat);

  const target =
    ascending.find(isSafe) ?? // best: somewhere higher with nothing guarding it
    ascending[0] ?? // else: higher and guarded beats not climbing at all
    climbable.find(isSafe) ?? // falling with nothing above in reach
    climbable[0];

  let left = false;
  let right = false;
  if (target) {
    const d = wrapDelta(p.x, target.x + TUNING.PLATFORM_W / 2);
    if (d < -6) left = true;
    else if (d > 6) right = true;
  }

  // Only shoot at something actually overhead and close.
  const threat =
    allowFire &&
    state.monsters.some(
      (m) => m.alive && m.y > p.y && m.y - p.y < 300 && Math.abs(wrapDelta(p.x, m.x + 21)) < 40,
    );

  return { left, right, fire: threat };
}

interface Run {
  status: GameState["status"];
  seconds: number;
  metres: number;
}

function play(seed: number, allowFire: boolean): Run {
  resetCooldown();
  const state = createGame(seed);
  let t = 0;
  while (state.status === "playing" && t < TIME_LIMIT) {
    step(state, chooseInput(state, allowFire), STEP);
    t += STEP;
  }
  return {
    status: state.status,
    seconds: t,
    metres: Math.round(state.maxY / 10),
  };
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function report(title: string, runs: Run[]): void {
  const wins = runs.filter((r) => r.status === "won");
  const losses = runs.filter((r) => r.status === "lost");
  const pct = ((wins.length / runs.length) * 100).toFixed(0);
  console.log(`\n${title}`);
  console.log(`  summit reached   ${wins.length}/${runs.length}  (${pct}%)`);
  if (wins.length) {
    console.log(`  median win time  ${median(wins.map((r) => r.seconds)).toFixed(1)}s`);
    console.log(`  fastest          ${Math.min(...wins.map((r) => r.seconds)).toFixed(1)}s`);
  }
  if (losses.length) {
    console.log(`  median fall at   ${median(losses.map((r) => r.metres)).toFixed(0)}m`);
  }
  const stalled = runs.filter((r) => r.status === "playing");
  if (stalled.length) {
    // Neither won nor died: the climb ran out of reachable platforms and the
    // player bounced in place. Always a generation bug, never a hard level.
    console.log(
      `  STALLED          ${stalled.length}/${runs.length} at a median of ` +
        `${median(stalled.map((r) => r.metres)).toFixed(0)}m`,
    );
  }
  const ended = runs.filter((r) => r.status !== "playing" && r.seconds <= 300);
  console.log(`  ended inside 5m  ${ended.length}/${runs.length}`);
}

const seeds = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

console.log(`summit: ${SUMMIT_Y} world units (${Math.round(SUMMIT_Y / 10)}m)`);
report("shooting when threatened", seeds.map((s) => play(s, true)));
report("never firing", seeds.map((s) => play(s, false)));
