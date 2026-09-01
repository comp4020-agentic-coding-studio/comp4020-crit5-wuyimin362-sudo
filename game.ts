// The rules of the game, with no DOM in sight.
//
// Everything here is pure state plus `step()`, so the spec can drive a whole
// run without a browser and the renderer can be replaced without touching a
// rule. World coordinates put **y increasing upward** — this is a climb, and
// reading `y` as altitude everywhere is worth the one flip in the renderer.
//
// `step()` mutates the state it is given and returns it. At 60fps a fresh
// object graph per frame is pointless garbage; the tests read the same fields
// either way.

export type PlatformKind = "solid" | "broken" | "trampoline";
export type Status = "playing" | "won" | "lost";
export type Input = { left: boolean; right: boolean; fire: boolean };

export const WORLD_WIDTH = 480;
export const VIEW_HEIGHT = 720;

/**
 * Altitude that ends the run as a win.
 *
 * Not guessed: scripts/sim.ts autoplays 24 seeds and reports time-to-summit.
 * At 12,000 a competent run finished in 52s, which fails the half of the
 * brief asking for something still interesting at five minutes. 24,000 puts
 * the autoplayer near two minutes, and it is slower than that floor for a
 * human still learning which platforms hold.
 */
export const SUMMIT_Y = 24_000;

const GRAVITY = -1800; // px/s², pulling toward y = 0
const BOUNCE_V = 780; // upward speed a solid platform returns
const TRAMPOLINE_V = 1500; // the reward for routing through one
const MOVE_ACCEL = 2600;
const MOVE_MAX = 420;
const DRAG = 0.86; // horizontal damping per frame-ish, applied via dt below
const PLAYER_W = 34;
const PLAYER_H = 34;
const PLATFORM_W = 84;
const PLATFORM_H = 14;
const MONSTER_W = 42;
const MONSTER_H = 42;
const MISSILE_V = 900;
const JETPACK_V = 900; // sustained climb while fuel burns
const JETPACK_MS = 1400;
const CAMERA_LEAD = VIEW_HEIGHT * 0.42; // how far above the bottom the player rides
const KILL_BONUS = 140; // altitude credited for a monster shot down

/** The player never has to discover firing, so a kill has to be worth routing for. */
export const MONSTER_KILL_BONUS = KILL_BONUS;

export interface Platform {
  id: number;
  x: number; // left edge
  y: number; // top surface, world coords
  kind: PlatformKind;
  alive: boolean;
}

export interface Monster {
  id: number;
  x: number;
  y: number;
  alive: boolean;
  driftPhase: number;
}

export interface Missile {
  id: number;
  x: number;
  y: number;
}

export interface Pickup {
  id: number;
  x: number;
  y: number;
  alive: boolean;
}

export interface Player {
  x: number; // centre
  y: number; // feet
  vx: number;
  vy: number;
  jetpackMs: number;
}

export interface GameState {
  status: Status;
  player: Player;
  platforms: Platform[];
  monsters: Monster[];
  missiles: Missile[];
  pickups: Pickup[];
  cameraY: number;
  maxY: number; // best altitude reached, the score
  bonusY: number; // altitude credited by kills, folded into progress
  generatedTo: number;
  nextId: number;
  rng: () => number;
  /** Frames where the player was falling — the renderer leans on this. */
  fell: boolean;
}

/**
 * A seeded LCG. Deterministic generation means the spec can assert what the
 * world looks like, and every player gets the same mountain to learn.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Horizontal overlap, measured across the seam as well as directly.
 *
 * The player wraps from one edge to the other but the world does not, and for
 * a while only the movement knew that: a straight `ax < bx + bw` comparison
 * silently missed every collision spanning x=0, so platforms near the edges
 * could not be landed on from the other side and monsters there were
 * harmless. Movement that wraps and collision that does not is worse than
 * neither, because the rule you learn at the middle of the screen quietly
 * stops applying at its edges.
 */
function overlapsX(ax: number, aw: number, bx: number, bw: number): boolean {
  for (const shift of [-WORLD_WIDTH, 0, WORLD_WIDTH]) {
    const left = ax + shift;
    if (left < bx + bw && left + aw > bx) return true;
  }
  return false;
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ay < by + bh && ay + ah > by && overlapsX(ax, aw, bx, bw);
}

/**
 * The opening screen has to teach itself, so the first few platforms are
 * placed by hand rather than generated:
 *
 *   - a wide solid ledge under the player, who is already bouncing
 *   - one solid platform straight above it, plainly reachable
 *   - a solid and a **broken** side by side, low enough that falling through
 *     the broken one costs height instead of the run
 *
 * That last pair is the whole tutorial: the contrast says "these differ", and
 * the first mistake is survivable. Mario 1-1's first goomba, in a ledge.
 */
function seedOpening(state: GameState): void {
  const mid = WORLD_WIDTH / 2;
  const add = (x: number, y: number, kind: PlatformKind) => {
    state.platforms.push({ id: state.nextId++, x, y, kind, alive: true });
  };

  // Every gap here is under the 169px a bounce buys, and the geometry is
  // checked by spec/crit-5.test.ts rather than by eye — the first draft put
  // the second platform 180px up and the player could not leave the ground.
  add(mid - PLATFORM_W, 80, "solid"); // double-wide start, hard to miss
  add(mid, 80, "solid"); //             spans x 156..324
  add(mid - PLATFORM_W / 2, 210, "solid"); // the invitation: straight up
  add(130, 340, "solid"); // the lesson: a solid one...
  add(250, 366, "broken"); // ...and a broken one right beside it
  add(mid - PLATFORM_W / 2, 470, "solid"); // the reward for reading it right

  // Falling through that broken platform drops the player back onto the
  // double-wide start ledge, which is deliberately wide enough to catch them:
  // the lesson costs about 280px of climb, not the run.
  state.generatedTo = 470;
}

/** How far a bounce off a solid platform lifts you. The ladder depends on it. */
export const BOUNCE_HEIGHT = (BOUNCE_V * BOUNCE_V) / (2 * -GRAVITY);

/** Shortest distance between two x positions, going either way round the seam. */
export function wrapDistanceX(a: number, b: number): number {
  const d = Math.abs(a - b) % WORLD_WIDTH;
  return Math.min(d, WORLD_WIDTH - d);
}

/**
 * How far sideways a jump of `gap` height can be *relied* on to carry you.
 *
 * A vertical gap under BOUNCE_HEIGHT is necessary but not sufficient — you
 * also have to arrive over the platform before you fall past its surface.
 *
 * The number here assumes the worst honest case: you land already travelling
 * at full speed **away** from where you need to go, because you had to move
 * sideways to reach the rung you are standing on. Reversing costs the whole
 * accelerate-decelerate round trip, and the two halves cancel out, so the
 * useful displacement is just top speed times whatever time is left over.
 *
 * The optimistic version of this — standing start, perfect timing — gives
 * 226..271px and was worse than useless: it declared the old random placement
 * (up to 240px away) fine, while play said otherwise. This gives 124..169px,
 * which matches what the game actually felt like.
 */
export function horizontalReach(gap: number): number {
  if (gap >= BOUNCE_HEIGHT) return 0;
  const g = -GRAVITY;
  const airborne = BOUNCE_V / g + Math.sqrt((2 * (BOUNCE_HEIGHT - gap)) / g);
  const reversal = (2 * MOVE_MAX) / MOVE_ACCEL;
  if (airborne <= reversal) return 0;
  return MOVE_MAX * (airborne - reversal);
}

/**
 * The furthest two rung centres may sit apart and still be a fair jump.
 * Landing counts as any overlap, so the player's centre only has to get
 * within half a platform plus half a player of the target's centre.
 */
export function maxRungSpacingX(gap: number): number {
  return horizontalReach(gap) + PLATFORM_W / 2 + PLAYER_W / 2;
}

/**
 * Hazards arrive with altitude, and difficulty is a function of height rather
 * than of a level table — so the curve is a couple of numbers to tune after
 * actually playing it, not a data file to rewrite.
 *
 * Exported because the spec asserts a property of the world this builds:
 * consecutive landable platforms must stay within one bounce of each other.
 */
export function ensureGenerated(state: GameState, targetY: number): void {
  while (state.generatedTo < targetY) {
    // A solid bounce lifts exactly BOUNCE_V^2 / 2g — 169px at the current
    // tuning — so the gap has to stay comfortably under that. The first
    // version generated 110..170 and produced climbs that simply ended at a
    // wall: the autoplayer neither won nor died on any of 24 seeds, it just
    // bounced in place until the clock ran out. An unreachable gap is not
    // difficulty, it is a dead end, so difficulty lives in what fills the
    // gaps instead.
    const y = state.generatedTo + 92 + state.rng() * 46;
    if (y > SUMMIT_Y) {
      state.generatedTo = targetY;
      return;
    }

    const progress = Math.min(1, y / SUMMIT_Y);

    // The rung below: the next one has to be reachable from it, and the
    // corridor between the two has to stay clear.
    const previous = state.platforms.filter((p) => p.kind !== "broken").at(-1);

    // Placing x at random was the second way this generator built walls, and
    // the one a player actually reported. The vertical gap was always inside
    // a bounce, but the landing spot could be half a world away — 240px, when
    // the widest jump only carries you about 226. It looked like a platform
    // you should be able to reach and simply was not, however well you played.
    //
    const gap = previous ? y - previous.y : 0;
    const fromCentre = previous ? previous.x + PLATFORM_W / 2 : WORLD_WIDTH / 2;
    const budget = previous ? maxRungSpacingX(gap) : WORLD_WIDTH / 2;

    // Platforms cannot straddle the seam, so a candidate near an edge gets
    // clamped — and the clamp moves it, which can quietly push it back out of
    // reach. So the distance is re-measured after clamping and the throw
    // retried, rather than assumed. Falling back to directly overhead is
    // always fair, which makes the worst case dull rather than impossible.
    let centre = fromCentre;
    for (let attempt = 0; attempt < 6; attempt++) {
      const throwTo = fromCentre + (state.rng() * 2 - 1) * budget * 0.85;
      const wrapped = ((throwTo % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
      const candidate = Math.max(
        PLATFORM_W / 2,
        Math.min(WORLD_WIDTH - PLATFORM_W / 2, wrapped),
      );
      if (wrapDistanceX(candidate, fromCentre) <= budget * 0.9) {
        centre = candidate;
        break;
      }
    }
    const x = Math.max(0, Math.min(WORLD_WIDTH - PLATFORM_W, centre - PLATFORM_W / 2));

    // Every rung of the ladder is landable. Broken platforms used to take
    // their turn in this sequence, and two in a row built a wall taller than
    // a bounce: a traced run sat at 1756 forever, reaching 1925 with the next
    // solid platform at 1948. The climb has to stay possible, so a broken
    // platform is never a rung — it is a decoy placed beside one, which is
    // also how the hand-placed opening teaches it.
    const kind: PlatformKind = state.rng() < 0.06 + progress * 0.02 ? "trampoline" : "solid";
    state.platforms.push({ id: state.nextId++, x, y, kind, alive: true });

    // Two prunes, and both exist because generation runs bottom-up: when a
    // monster is placed, the rung above it does not exist yet, so the check at
    // its own placement cannot catch every case.
    //
    // The first keeps a rung landable along its whole length. The second
    // keeps the route between consecutive rungs open — a monster parked in
    // that corridor can wall the climb in, and the spec promises play ends
    // somewhere, which a player bouncing in place forever does not do. A
    // monster nobody has seen yet costs nothing to discard, so anything in
    // the way is dropped rather than worked around.
    const corridorLo = previous ? Math.min(previous.y, y) - 10 : y - 10;
    const corridorHi = y + 10;
    const corridorLeft = (previous ? Math.min(previous.x, x) : x) - 26;
    const corridorRight = (previous ? Math.max(previous.x, x) : x) + PLATFORM_W + 26;

    state.monsters = state.monsters.filter((m) => {
      const onThisRung =
        Math.abs(m.y - y) < 64 && m.x < x + PLATFORM_W + 20 && m.x + MONSTER_W > x - 20;
      const inCorridor =
        m.y > corridorLo &&
        m.y < corridorHi &&
        m.x < corridorRight &&
        m.x + MONSTER_W > corridorLeft;
      return !onThisRung && !inCorridor;
    });

    // The decoy: same height band, opposite half of the screen, so telling
    // them apart is a choice rather than a dead end. Commoner as you climb.
    if (state.rng() < 0.14 + progress * 0.5) {
      const half = WORLD_WIDTH / 2;
      const onLeft = x + PLATFORM_W / 2 < half;
      const decoyX = onLeft
        ? half + 10 + state.rng() * (half - PLATFORM_W - 10)
        : state.rng() * (half - PLATFORM_W - 10);
      state.platforms.push({
        id: state.nextId++,
        x: Math.max(0, Math.min(WORLD_WIDTH - PLATFORM_W, decoyX)),
        y: y + (state.rng() - 0.5) * 44,
        kind: "broken",
        alive: true,
      });
    }

    // Monsters from a quarter of the way up, and never in the column the
    // player is about to fly through. The first version dropped them 60px
    // above a platform with a random x — but a bounce rises 169px straight
    // up, so any monster over the platform you just used was unavoidable
    // death. The autoplayer stopped dead at the altitude they started
    // appearing: every route was a trap, so it refused them all.
    //
    // Placing them half a world away horizontally makes them honest. They
    // are still in the way whenever the next platform is over on their side,
    // which is difficulty you can read and route around, and the promise
    // that a monster can be outrun stays true.
    if (progress > 0.22 && state.rng() < 0.1 + progress * 0.14) {
      const platCentre = x + PLATFORM_W / 2;
      const away =
        (platCentre + WORLD_WIDTH / 2 + (state.rng() - 0.5) * 110 + WORLD_WIDTH) % WORLD_WIDTH;
      const mx = Math.max(0, Math.min(WORLD_WIDTH - MONSTER_W, away - MONSTER_W / 2));
      const my = y + 80 + state.rng() * 50;

      // Half a world from *its own* rung still leaves it free to settle on a
      // neighbouring one. A traced stall found exactly that: a monster at
      // y=7328 parked across the platform at y=7323, which was the only thing
      // in reach, so the climb had nowhere left to go. A rung has to stay
      // landable along its whole length, so a monster that would sit on one
      // is dropped rather than nudged.
      const sitsOnARung = state.platforms.some(
        (plat) =>
          plat.kind !== "broken" &&
          Math.abs(plat.y - my) < 64 &&
          mx < plat.x + PLATFORM_W + 20 &&
          mx + MONSTER_W > plat.x - 20,
      );

      if (!sitsOnARung) {
        state.monsters.push({
          id: state.nextId++,
          x: mx,
          y: my,
          alive: true,
          driftPhase: state.rng() * Math.PI * 2,
        });
      }
    }

    if (state.rng() < 0.035) {
      state.pickups.push({
        id: state.nextId++,
        x: state.rng() * (WORLD_WIDTH - 26),
        y: y + 46,
        alive: true,
      });
    }

    state.generatedTo = y;
  }
}

export function createGame(seed = 20_260_902): GameState {
  const state: GameState = {
    status: "playing",
    player: {
      x: WORLD_WIDTH / 2,
      y: 94,
      vx: 0,
      vy: 0,
      jetpackMs: 0,
    },
    platforms: [],
    monsters: [],
    missiles: [],
    pickups: [],
    cameraY: 0,
    maxY: 94,
    bonusY: 0,
    generatedTo: 0,
    nextId: 1,
    rng: makeRng(seed),
    fell: false,
  };

  seedOpening(state);
  ensureGenerated(state, VIEW_HEIGHT * 2);
  // The player starts mid-bounce: motion on frame one says "this is automatic".
  state.player.vy = BOUNCE_V * 0.55;
  return state;
}

/** Altitude the run is judged on: how high you climbed, plus what you shot. */
export function progressY(state: GameState): number {
  return state.maxY + state.bonusY;
}

let missileCooldown = 0;

export function step(state: GameState, input: Input, dt: number): GameState {
  if (state.status !== "playing") return state;

  const p = state.player;
  const prevY = p.y;

  // --- horizontal: accelerate, cap, damp, wrap ---------------------------
  if (input.left) p.vx -= MOVE_ACCEL * dt;
  if (input.right) p.vx += MOVE_ACCEL * dt;
  if (!input.left && !input.right) p.vx *= Math.pow(DRAG, dt * 60);
  p.vx = Math.max(-MOVE_MAX, Math.min(MOVE_MAX, p.vx));
  p.x += p.vx * dt;
  // Wrapping keeps a mistimed drift from parking you against a wall.
  if (p.x < 0) p.x += WORLD_WIDTH;
  if (p.x > WORLD_WIDTH) p.x -= WORLD_WIDTH;

  // --- vertical ----------------------------------------------------------
  if (p.jetpackMs > 0) {
    p.jetpackMs = Math.max(0, p.jetpackMs - dt * 1000);
    p.vy = JETPACK_V;
  } else {
    p.vy += GRAVITY * dt;
  }
  p.y += p.vy * dt;
  state.fell = p.vy < 0;

  // --- platforms: only ever caught on the way down -----------------------
  if (p.vy < 0) {
    for (const plat of state.platforms) {
      if (!plat.alive) continue;
      const crossed = prevY >= plat.y && p.y <= plat.y;
      if (!crossed) continue;
      if (!overlapsX(p.x - PLAYER_W / 2, PLAYER_W, plat.x, PLATFORM_W)) continue;

      if (plat.kind === "broken") {
        // The wrong move: it gives way, you keep falling, and it is gone.
        plat.alive = false;
      } else {
        p.y = plat.y;
        p.vy = plat.kind === "trampoline" ? TRAMPOLINE_V : BOUNCE_V;
      }
      break;
    }
  }

  // --- pickups: a jetpack is a reward, never a required verb -------------
  for (const pick of state.pickups) {
    if (!pick.alive) continue;
    if (overlaps(p.x - PLAYER_W / 2, p.y, PLAYER_W, PLAYER_H, pick.x, pick.y, 26, 26)) {
      pick.alive = false;
      p.jetpackMs = JETPACK_MS;
    }
  }

  // --- missiles ----------------------------------------------------------
  missileCooldown -= dt;
  if (input.fire && missileCooldown <= 0) {
    state.missiles.push({ id: state.nextId++, x: p.x, y: p.y + PLAYER_H });
    missileCooldown = 0.28;
  }
  for (const m of state.missiles) m.y += MISSILE_V * dt;
  for (const m of state.missiles) {
    for (const mon of state.monsters) {
      if (!mon.alive) continue;
      if (overlaps(m.x - 4, m.y, 8, 14, mon.x, mon.y, MONSTER_W, MONSTER_H)) {
        mon.alive = false;
        m.y = Number.POSITIVE_INFINITY; // culled below
        state.bonusY += KILL_BONUS;
        // A kill leaves a jetpack behind. Without this, firing paid nothing
        // an autoplayer could measure — 24 seeds finished in exactly the same
        // time whether it shot or not, which made "shooting is the hidden
        // layer" a claim with no substance under it. Now the reward is
        // visible, worth routing back for, and teaches itself the first time
        // someone presses the key by accident.
        state.pickups.push({ id: state.nextId++, x: mon.x + 8, y: mon.y + 8, alive: true });
        break;
      }
    }
  }
  state.missiles = state.missiles.filter((m) => m.y < state.cameraY + VIEW_HEIGHT * 1.5);

  // --- monsters: a hazard to read and route around ----------------------
  for (const mon of state.monsters) {
    if (!mon.alive) continue;
    if (overlaps(p.x - PLAYER_W / 2, p.y, PLAYER_W, PLAYER_H, mon.x, mon.y, MONSTER_W, MONSTER_H)) {
      state.status = "lost";
      return state;
    }
  }

  // --- camera, score, generation ----------------------------------------
  state.maxY = Math.max(state.maxY, p.y);
  state.cameraY = Math.max(state.cameraY, p.y - CAMERA_LEAD);
  ensureGenerated(state, state.cameraY + VIEW_HEIGHT * 2);

  // --- endings -----------------------------------------------------------
  if (p.y >= SUMMIT_Y) {
    state.status = "won";
  } else if (p.y < state.cameraY - PLAYER_H) {
    // Fell off the bottom of the screen. The camera never descends, so this
    // is unambiguous: the mountain left without you.
    state.status = "lost";
  }

  return state;
}

/** Reset the module-level fire cooldown. Tests want a clean slate. */
export function resetCooldown(): void {
  missileCooldown = 0;
}

export const TUNING = {
  GRAVITY,
  BOUNCE_V,
  TRAMPOLINE_V,
  PLATFORM_W,
  PLATFORM_H,
  PLAYER_W,
  PLAYER_H,
  MONSTER_W,
  MONSTER_H,
  JETPACK_MS,
  CAMERA_LEAD,
};
