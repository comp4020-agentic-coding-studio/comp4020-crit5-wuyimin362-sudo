# Crit 5 — Ascent

## What was the breakthrough that moved the work forward?

Writing a robot to play the game instead of playing it myself.

The game rendered beautifully and I was about to start tuning how it *felt*.
Instead I wrote a greedy autoplayer that runs 24 seeded games headless. Its
first run came back **0 wins and 0 deaths out of 24** — every game bounced in
place until the clock ran out, because a bounce lifts exactly 169px and I had
spaced platforms up to 170px apart. The start ledge sat 180px below the
platform above it: nobody could ever have left the ground.

The breakthrough wasn't the arithmetic. It was realising the bug was invisible
to playtesting. "I can't get past this bit" and "this bit is impossible" feel
identical from the keyboard, and I'd have blamed my own thumbs for an hour
before suspecting the generator.

## What did this work change about who I want to be as a software developer?

I've been treating tests as proof that code I already believe in works. Tonight
the useful thing did the opposite — it told me the thing I was proud of was
broken in a way I couldn't see by looking. I want to be the kind of developer
who builds the instrument before trusting the impression, especially when the
impression is flattering.

The other half is less comfortable. I then spent three rounds debugging the
*instrument* while blaming the game, and one of those rounds diagnosed a copy
of the logic the simulator wasn't even running. Being measured isn't the same
as being right, and I'd like to get faster at noticing which one I'm doing.
