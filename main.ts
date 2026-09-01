// Wiring only: input in, fixed-step simulation, renderer out. Every rule
// lives in game.ts and everything you can see lives in render.ts.

import { createGame, resetCooldown, step, type GameState, type Input } from "./game.ts";
import { createRenderer } from "./render.ts";

const found = document.querySelector<HTMLCanvasElement>("#stage");
if (!found) throw new Error("#stage is missing from the page");
// Rebound to a non-nullable const: narrowing from the guard above does not
// follow the querySelector result into the event handlers below.
const canvas: HTMLCanvasElement = found;

const renderer = createRenderer(canvas);
let state: GameState = createGame();

const input: Input = { left: false, right: false, fire: false };
const held = new Set<string>();

function restart(): void {
  resetCooldown();
  state = createGame();
  input.left = false;
  input.right = false;
  input.fire = false;
  held.clear();
}

// --- keyboard --------------------------------------------------------------
// Arrows and WASD both, because a stranger tries one or the other and the
// game gets no second chance to explain itself.
const LEFT_KEYS = new Set(["ArrowLeft", "KeyA"]);
const RIGHT_KEYS = new Set(["ArrowRight", "KeyD"]);

function syncKeys(): void {
  input.left = [...held].some((k) => LEFT_KEYS.has(k));
  input.right = [...held].some((k) => RIGHT_KEYS.has(k));
  input.fire = held.has("Space");
}

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault(); // otherwise the page scrolls
  if (state.status !== "playing") {
    restart();
    return;
  }
  held.add(e.code);
  syncKeys();
});

window.addEventListener("keyup", (e) => {
  held.delete(e.code);
  syncKeys();
});

window.addEventListener("blur", () => {
  held.clear();
  syncKeys();
});

// --- pointer / touch -------------------------------------------------------
// Hold a side to steer. A quick tap fires — which is also how most people
// poke at a phone game they have not been told anything about, so the
// hidden layer is reachable on a touchscreen without a word of prompting.
const TAP_MS = 200;
const TAP_SLOP = 12;
const pointers = new Map<number, { x: number; y: number; t: number; moved: boolean }>();
let touchFireUntil = 0;

function syncPointers(): void {
  let left = false;
  let right = false;
  for (const p of pointers.values()) {
    const rect = canvas.getBoundingClientRect();
    if (p.x < rect.left + rect.width / 2) left = true;
    else right = true;
  }
  input.left = left;
  input.right = right;
}

canvas.addEventListener("pointerdown", (e) => {
  if (state.status !== "playing") {
    restart();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });
  syncPointers();
});

canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) p.moved = true;
  p.x = e.clientX;
  p.y = e.clientY;
  syncPointers();
});

function endPointer(e: PointerEvent): void {
  const p = pointers.get(e.pointerId);
  if (p && !p.moved && performance.now() - p.t < TAP_MS) {
    touchFireUntil = performance.now() + 90; // one shot, long enough to register
  }
  pointers.delete(e.pointerId);
  syncPointers();
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("resize", () => renderer.resize());

// --- loop ------------------------------------------------------------------
// A fixed step keeps the physics identical on a 60Hz laptop and a 120Hz
// phone; the accumulator is capped so a backgrounded tab does not resume by
// simulating four seconds of falling at once.
const STEP = 1 / 120;
let accumulator = 0;
let previous = performance.now();

function frame(now: number): void {
  const elapsed = Math.min(0.25, (now - previous) / 1000);
  previous = now;
  accumulator += elapsed;

  while (accumulator >= STEP) {
    input.fire = held.has("Space") || now < touchFireUntil;
    step(state, input, STEP);
    accumulator -= STEP;
  }

  renderer.draw(state, now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
