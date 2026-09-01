import { beforeEach, describe, expect, it } from "vitest";
import {
  createGame,
  makeRng,
  resetCooldown,
  SUMMIT_Y,
  step,
  type GameState,
  type Input,
} from "../game.ts";

// Crit 5's spec, as far as a machine can hold it. The lines about teaching
// itself and about a stranger finishing inside five minutes are settled by
// four people playing it cold — they are not in here, and pretending
// otherwise would be worse than leaving them out.

const IDLE: Input = { left: false, right: false, fire: false };
const FIRE: Input = { left: false, right: false, fire: true };

/**
 * A hand-built state, rather than a generated world: every test below is
 * about one rule, so the world around that rule should hold still.
 * `generatedTo` is parked past the horizon to keep generation out of it.
 */
function bare(overrides: Partial<GameState> = {}): GameState {
  return {
    status: "playing",
    player: { x: 240, y: 1010, vx: 0, vy: -600, jetpackMs: 0 },
    platforms: [],
    monsters: [],
    missiles: [],
    pickups: [],
    cameraY: 0,
    maxY: 1010,
    bonusY: 0,
    generatedTo: 100_000,
    nextId: 1,
    rng: makeRng(1),
    fell: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetCooldown();
});

// ---------------------------------------------------------------------------
// The focused test the spec asks for. A broken platform is *the* wrong move:
// it is the one thing on screen that punishes you for not looking, and the
// whole opening is built to teach it at a survivable price.
// ---------------------------------------------------------------------------
describe("a broken platform is the wrong move", () => {
  it("gives way instead of bouncing, and does not come back", () => {
    const platform = { id: 1, x: 200, y: 1000, kind: "broken" as const, alive: true };
    const state = bare({ platforms: [platform] });

    step(state, IDLE, 0.05);

    expect(state.player.vy, "a broken platform must not launch the player").toBeLessThan(0);
    expect(platform.alive, "it breaks on the one touch it gets").toBe(false);
  });

  it("a solid platform in the same place does bounce", () => {
    const platform = { id: 1, x: 200, y: 1000, kind: "solid" as const, alive: true };
    const state = bare({ platforms: [platform] });

    step(state, IDLE, 0.05);

    expect(state.player.vy).toBeGreaterThan(0);
    expect(platform.alive).toBe(true);
  });

  it("a trampoline bounces harder than a solid platform", () => {
    const solid = bare({ platforms: [{ id: 1, x: 200, y: 1000, kind: "solid", alive: true }] });
    const tramp = bare({
      platforms: [{ id: 1, x: 200, y: 1000, kind: "trampoline", alive: true }],
    });

    step(solid, IDLE, 0.05);
    step(tramp, IDLE, 0.05);

    expect(tramp.player.vy).toBeGreaterThan(solid.player.vy);
  });
});

// ---------------------------------------------------------------------------
// "play ends somewhere — a win, a loss or a finish"
// ---------------------------------------------------------------------------
describe("play ends somewhere", () => {
  it("starts out playing", () => {
    expect(createGame().status).toBe("playing");
  });

  it("is lost by falling below the camera", () => {
    const state = bare({
      player: { x: 240, y: 100, vx: 0, vy: -600, jetpackMs: 0 },
      cameraY: 500,
    });

    step(state, IDLE, 0.05);

    expect(state.status).toBe("lost");
  });

  it("is lost by touching a monster", () => {
    const state = bare({
      monsters: [{ id: 1, x: 230, y: 1005, alive: true, driftPhase: 0 }],
    });

    step(state, IDLE, 0.05);

    expect(state.status).toBe("lost");
  });

  it("is won by reaching the summit", () => {
    const state = bare({
      player: { x: 240, y: SUMMIT_Y - 10, vx: 0, vy: 600, jetpackMs: 0 },
      cameraY: SUMMIT_Y - 400,
      maxY: SUMMIT_Y - 10,
    });

    step(state, IDLE, 0.05);

    expect(state.status).toBe("won");
  });
});

// ---------------------------------------------------------------------------
// Firing is the layer nothing on screen names, so it has to stay optional —
// a player who never presses space must still be able to climb. These two
// assert that bargain: shooting works, and monsters can be outrun without it.
// ---------------------------------------------------------------------------
describe("firing is a reward, not a requirement", () => {
  it("a missile kills a monster and credits altitude", () => {
    const monster = { id: 1, x: 230, y: 1060, alive: true, driftPhase: 0 };
    const state = bare({ monsters: [monster] });

    for (let i = 0; i < 15 && monster.alive; i++) {
      step(state, FIRE, 0.016);
    }

    expect(monster.alive).toBe(false);
    expect(state.bonusY).toBeGreaterThan(0);
  });

  it("never firing is survivable: a monster off to the side is just scenery", () => {
    const state = bare({
      platforms: [{ id: 1, x: 200, y: 1000, kind: "solid", alive: true }],
      monsters: [{ id: 2, x: 0, y: 1400, alive: true, driftPhase: 0 }],
    });

    for (let i = 0; i < 30; i++) step(state, IDLE, 0.016);

    expect(state.status).toBe("playing");
  });
});

// ---------------------------------------------------------------------------
// The opening screen is the only tutorial this game gets, so its shape is a
// contract rather than a happy accident: the first thing above the start
// ledge must reward the obvious move.
// ---------------------------------------------------------------------------
describe("the opening teaches itself", () => {
  it("starts the player already moving, so bouncing reads as automatic", () => {
    expect(createGame().player.vy).toBeGreaterThan(0);
  });

  it("puts a solid platform first, so the opening move always works", () => {
    const start = createGame();
    const above = start.platforms.filter((p) => p.y > 100).sort((a, b) => a.y - b.y);

    expect(above[0]?.kind, "the first platform a player aims for cannot betray them").toBe("solid");
  });

  it("puts a broken platform in the opening, next to a solid one", () => {
    const start = createGame();
    const opening = start.platforms.filter((p) => p.y < 760);
    const broken = opening.find((p) => p.kind === "broken");

    expect(broken, "the lesson has to be on screen early").toBeTruthy();
    const neighbour = opening.find((p) => p.kind === "solid" && Math.abs(p.y - broken!.y) < 60);
    expect(neighbour, "shown against a solid one, so the contrast is the teacher").toBeTruthy();
  });
});
