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

/** Altitude that ends the run as a win. Tuned so a first climb runs 3–4 min. */
export const SUMMIT_Y = 12_000;

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
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
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

  add(mid - PLATFORM_W, 80, "solid"); // double-wide start, hard to miss
  add(mid, 80, "solid");
  add(mid - PLATFORM_W / 2, 260, "solid"); // the invitation: straight up
  add(60, 440, "solid"); // the lesson: solid and broken, side by side
  add(WORLD_WIDTH - 60 - PLATFORM_W, 470, "broken");
  add(mid - PLATFORM_W / 2, 640, "solid"); // recovery, so the lesson isn't fatal

  state.generatedTo = 760;
}

/**
 * Platforms thin out and hazards arrive with altitude. Difficulty is a
 * function of height, not of a level table, so the curve is one number to
 * tune after actually playing it.
 */
function generateTo(state: GameState, targetY: number): void {
  while (state.generatedTo < targetY) {
    const y = state.generatedTo + 110 + state.rng() * 60;
    if (y > SUMMIT_Y) {
      state.generatedTo = targetY;
      return;
    }

    const progress = Math.min(1, y / SUMMIT_Y);
    const x = state.rng() * (WORLD_WIDTH - PLATFORM_W);

    // Broken platforms climb from rare to common; trampolines stay a treat.
    const roll = state.rng();
    let kind: PlatformKind = "solid";
    if (roll < 0.06 + progress * 0.02) kind = "trampoline";
    else if (roll < 0.06 + progress * 0.36) kind = "broken";

    state.platforms.push({ id: state.nextId++, x, y, kind, alive: true });

    // Monsters from a quarter of the way up, never on the same row as the
    // platform that gets you there.
    if (progress > 0.22 && state.rng() < 0.1 + progress * 0.14) {
      state.monsters.push({
        id: state.nextId++,
        x: state.rng() * (WORLD_WIDTH - MONSTER_W),
        y: y + 60,
        alive: true,
        driftPhase: state.rng() * Math.PI * 2,
      });
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
  generateTo(state, VIEW_HEIGHT * 2);
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
      const withinX = p.x + PLAYER_W / 2 > plat.x && p.x - PLAYER_W / 2 < plat.x + PLATFORM_W;
      if (!withinX) continue;

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
  generateTo(state, state.cameraY + VIEW_HEIGHT * 2);

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
