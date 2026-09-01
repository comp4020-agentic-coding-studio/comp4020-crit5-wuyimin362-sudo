# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The link-preview card

`public/card.png` (1200x630) is the image a shared link shows; `index.html`'s
head points at it. Replace it and the `description` meta, and copy the head
block into any new page. The card URL resolves against the page that names it,
like any link --- `./card.png` is wrong one directory down, and nothing in CI
checks it, so look at the deployed head when you add pages.

## The checks

`pnpm check` runs them (`pnpm check:evidence` is the extra gate before you
ship); CI runs the same plus links, secrets and the deploy. Read the failure.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## Running the checks

Carried forward from earlier weeks — general operating discipline, not tied to
any one stack:

- **Never pipe a check into `tail`, `head`, or `grep` in a command whose exit
  code you then act on.** A pipeline's status is the *last* command's, so
  `pnpm check | tail -6 && git commit` commits whatever `tail` felt about
  life — which is always success. This put a red state into the history once
  already. Either redirect and inspect (`pnpm check > /tmp/check.log 2>&1; echo
  $?`) or `set -o pipefail` first.
- **The shell's working directory persists between tool calls.** A `cd /tmp` to
  run a screenshot tool leaves the *next* build looking for a `package.json` in
  `/tmp`. Prefer absolute paths over `cd`.

## The stack

Vite + TypeScript, the template's default — switched back to this from A1's
vanilla-JS setup for crit 5. Standard Vite dev/build; `tsc --noEmit` for
typechecking.

## This file is yours

A starting point, not a rulebook. As you learn what your prototype needs --- a
convention the work has to hold to, a sensor that keeps catching you out (a
linter, say), a fact about the stack that is easy to get wrong --- write it down
here and wire it into `check`. Growing this file is the work.
