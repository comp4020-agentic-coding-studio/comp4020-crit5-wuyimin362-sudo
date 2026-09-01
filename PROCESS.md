# Process overview

## What I built

**Ascent** — a wordless vertical climb. You bounce automatically off neon
platforms, steer, and reach a lit gate 24,000px up before you fall out of
frame. Broken platforms give way. Monsters kill on contact and can be shot,
but never have to be.

## The moments that mattered

**The game was impossible, and looked fine.** Instead of playtesting I wrote an
autoplayer — `scripts/sim.ts`, 24 seeds, headless. First run: **0 wins, 0
deaths**. Every seed bounced in place until the clock ran out. A bounce lifts
exactly 169px and I had spaced platforms up to 170px apart; the opening ledge
sat 180px under the platform above it, so nobody could ever leave the ground.
Broken platforms were rungs too, so two in a row built a wall. The fix that
mattered was conceptual, not numeric: a broken platform is **never** a rung,
it's a decoy beside one — which turns it into the choice the spec's "wrong
move" actually wants. Now 18/24 summit and 23/24 end inside five minutes
([`20180b3`](../../commit/20180b3)).

I'd cite this one because the bug was invisible to playtesting: "too hard" and
"impossible" feel identical from the keyboard.

**Keeping the spacebar, and paying for it in design.** Nothing on screen can
name a key, so rather than cut firing I made the climb not depend on it —
monsters are dodgeable, the craft is drawn visibly armed. Checked, not assumed:
17/24 summit with firing disabled, and a test holds that bargain
([`065f8c7`](../../commit/065f8c7)).

Both fixes landed as sensors rather than patches — no gap may exceed a bounce,
no monster may sit on a rung — and they outlive this brief.

## Left to a person

Whether the opening truly teaches itself. The autoplayer already knows how to
play.
