import { describe, expect, it } from "vitest";
import { applyMove, createGame } from "../game.ts";

// Crit 5 spec: "it can be lost: a wrong move is possible, and play ends
// somewhere — a win, a loss or a finish." `game.ts` is yours to write: a
// DOM-free module holding the game's rules, separate from however you render
// them, so this test outlives whatever rendering approach you pick. `"lose"`
// below is a placeholder move — swap it for whatever your real losing move
// actually is as you build; the contract is only that some move exists that
// takes status away from "playing".
describe("crit 5 spec: play can end", () => {
  it("starts in a playing state", () => {
    expect(createGame().status).toBe("playing");
  });

  it("a wrong move ends play", () => {
    const ended = applyMove(createGame(), "lose");
    expect(ended.status).not.toBe("playing");
  });
});
