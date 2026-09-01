// Everything you see, and nothing you can lose by. The renderer reads game
// state and never writes it: paper, ink, brush trails, shake and squash live
// here because none of them are rules.
//
// The conceit is that the player *is* the brush. You are a nib climbing a
// hanging scroll, and the trail behind you is the stroke you are painting —
// which is why the trail thickens with speed and tapers to nothing at its
// tail, the way a real stroke does when the brush lifts.
//
// Ink carries the affordances that colour used to. Chinese brush painting
// already has a vocabulary for exactly the distinction this game needs:
//
//   - 浓墨  dense wet ink      -> a solid platform. Full-bellied, it holds.
//   - 飞白  "flying white"     -> a broken one. A dry brush dragged fast
//                                leaves streaks of bare paper through the
//                                stroke; the mark is visibly not solid.
//   - 湿墨  wet ink, bleeding  -> a trampoline. Loaded with water, springy.
//
// That reads without colour at all, which is a better answer to the
// no-instructions rule than the cyan/orange/violet scheme it replaces — and
// it survives a colourblind player, who previously had only hue to go on.

import {
  progressY,
  SUMMIT_Y,
  TUNING,
  VIEW_HEIGHT,
  WORLD_WIDTH,
  type GameState,
} from "./game.ts";

const { PLATFORM_W, PLATFORM_H, PLAYER_W, PLAYER_H, MONSTER_W, MONSTER_H } = TUNING;

// The five tones of ink, plus the paper they sit on and one vermillion for
// the seal and for danger. Nothing else gets a colour.
const PAPER = "#efe7d7";
const PAPER_DEEP = "#e4d9c4";
const INK = "26 24 20"; // rgb triplet, used with varying alpha
const CINNABAR = "#b03a2a";

interface TrailPoint {
  x: number;
  /**
   * World y, not screen y. The scroll moves under the stroke, so a trail
   * recorded in screen space hangs in the air where the world used to be.
   */
  worldY: number;
  w: number;
  break: boolean; // true when the player wrapped the seam between samples
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

function ink(alpha: number): string {
  return `rgba(${INK} / ${alpha})`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic per-id jitter, so a platform's hand-drawn wobble holds still. */
function wobble(id: number, salt: number): number {
  const n = Math.sin(id * 12.9898 + salt * 78.233) * 43_758.5453;
  return n - Math.floor(n); // 0..1
}

export interface Renderer {
  draw(state: GameState, now: number): void;
  resize(): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d")!;
  const particles: Particle[] = [];
  const trail: TrailPoint[] = [];

  let lastVy = 0;
  let lastX = WORLD_WIDTH / 2;
  let shake = 0;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  // The paper is expensive to speckle and never changes, so it is painted
  // once into an offscreen canvas and blitted.
  const paper = document.createElement("canvas");
  paper.width = WORLD_WIDTH;
  paper.height = VIEW_HEIGHT;
  paintPaper(paper.getContext("2d")!);

  function paintPaper(p: CanvasRenderingContext2D): void {
    p.fillStyle = PAPER;
    p.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);

    // A faint warm unevenness, like sizing that took the ink differently.
    // Both circles must share a centre: giving them different ones makes a
    // cone gradient, which showed up as hard diagonal facets across the sheet.
    for (let i = 0; i < 26; i++) {
      const cx = Math.random() * WORLD_WIDTH;
      const cy = Math.random() * VIEW_HEIGHT;
      const g = p.createRadialGradient(cx, cy, 4, cx, cy, 140 + Math.random() * 160);
      g.addColorStop(0, "rgba(212 196 168 / 0.16)");
      g.addColorStop(1, "rgba(212 196 168 / 0)");
      p.fillStyle = g;
      p.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);
    }

    // Fibres: short pale threads pressed into the sheet.
    for (let i = 0; i < 380; i++) {
      const x = Math.random() * WORLD_WIDTH;
      const y = Math.random() * VIEW_HEIGHT;
      const len = 3 + Math.random() * 12;
      const a = Math.random() * Math.PI;
      p.strokeStyle = `rgba(150 136 112 / ${0.03 + Math.random() * 0.07})`;
      p.lineWidth = 0.7;
      p.beginPath();
      p.moveTo(x, y);
      p.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      p.stroke();
    }

    // Speckle.
    for (let i = 0; i < 900; i++) {
      p.fillStyle = `rgba(120 106 84 / ${0.02 + Math.random() * 0.06})`;
      p.beginPath();
      p.arc(Math.random() * WORLD_WIDTH, Math.random() * VIEW_HEIGHT, Math.random() * 0.9, 0, 7);
      p.fill();
    }
  }

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    scale = Math.min(vw / WORLD_WIDTH, vh / VIEW_HEIGHT);
    offsetX = (vw - WORLD_WIDTH * scale) / 2;
    offsetY = (vh - VIEW_HEIGHT * scale) / 2;

    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function sy(worldY: number, cameraY: number): number {
    return VIEW_HEIGHT - (worldY - cameraY);
  }

  /**
   * One brush stroke: thick through the belly, tapering at both ends, with a
   * damp halo where the ink has crept into the paper. `dryness` from 0 to 1
   * scrapes flying-white through it.
   */
  function stroke(
    x: number,
    y: number,
    len: number,
    weight: number,
    darkness: number,
    dryness: number,
    id: number,
  ): void {
    const steps = 22;
    const lift = wobble(id, 1) * 3 - 1.5; // the stroke is not perfectly level
    const belly = 0.62 + wobble(id, 2) * 0.22; // where the brush pressed hardest

    const edge = (t: number): number => {
      // Fat in the middle, tapered at the ends; the peak sits off-centre the
      // way a real stroke does, because the hand accelerates through it.
      const shaped = t < belly ? t / belly : (1 - t) / (1 - belly);
      return Math.pow(Math.max(0, shaped), 0.55);
    };

    const path = (spread: number) => {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = x + len * t;
        const py = y + lift * Math.sin(t * Math.PI) + Math.sin(t * 5 + id) * 0.6;
        ctx.lineTo(px, py - (edge(t) * weight * spread) / 2);
      }
      for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        const px = x + len * t;
        const py = y + lift * Math.sin(t * Math.PI) + Math.sin(t * 5 + id) * 0.6;
        ctx.lineTo(px, py + (edge(t) * weight * spread) / 2);
      }
      ctx.closePath();
    };

    // Bleed halo first, then the body over it.
    ctx.fillStyle = ink(darkness * 0.16);
    path(1.5);
    ctx.fill();
    ctx.fillStyle = ink(darkness);
    path(1);
    ctx.fill();

    if (dryness > 0) {
      // 飞白: drag streaks of bare paper back through the mark. The brush has
      // run out of ink, and the stroke stops being a solid thing.
      const streaks = 4 + Math.floor(dryness * 4);
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      for (let s = 0; s < streaks; s++) {
        const off = (wobble(id, 10 + s) - 0.5) * weight * 0.9;
        const from = wobble(id, 20 + s) * 0.35;
        const to = 0.62 + wobble(id, 30 + s) * 0.38;
        ctx.strokeStyle = `rgba(0 0 0 / ${0.5 + dryness * 0.45})`;
        ctx.lineWidth = 0.8 + wobble(id, 40 + s) * 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i <= 10; i++) {
          const t = from + ((to - from) * i) / 10;
          ctx.lineTo(x + len * t, y + off + Math.sin(t * 7 + s) * 0.8);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawPlatform(
    plat: GameState["platforms"][number],
    screenY: number,
    now: number,
  ): void {
    const id = plat.id;
    if (plat.kind === "trampoline") {
      // 湿墨: loaded with water. Heavier, and it breathes.
      const pulse = 0.9 + 0.1 * Math.sin(now * 0.005 + id);
      stroke(plat.x, screenY + PLATFORM_H / 2, PLATFORM_W, PLATFORM_H * 1.5 * pulse, 0.9, 0, id);
      // Pooling where the ink gathered at the end of the stroke.
      ctx.fillStyle = ink(0.28);
      ctx.beginPath();
      ctx.ellipse(plat.x + PLATFORM_W * 0.62, screenY + PLATFORM_H / 2, 15, 7, 0, 0, 7);
      ctx.fill();
      return;
    }

    if (plat.kind === "broken") {
      // 飞白: a dry brush, dragged. Paler, thinner, shot through with paper.
      stroke(plat.x, screenY + PLATFORM_H / 2, PLATFORM_W, PLATFORM_H * 0.72, 0.42, 1, id);
      return;
    }

    stroke(plat.x, screenY + PLATFORM_H / 2, PLATFORM_W, PLATFORM_H, 0.88, 0, id);
  }

  /** The brush itself: a loaded nib, nose up, wider when it is pressing. */
  function drawNib(cx: number, feetY: number, vy: number, vx: number, now: number): void {
    const t = Math.max(-1, Math.min(1, vy / 900));
    const w = PLAYER_W * (1 - t * 0.14) * 0.66;
    const h = PLAYER_H * (1 + t * 0.2);
    const lean = Math.max(-0.34, Math.min(0.34, vx / 900));

    ctx.save();
    ctx.translate(cx, feetY);
    ctx.rotate(lean);

    // Damp halo around the nib.
    ctx.fillStyle = ink(0.1);
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.45, w * 0.85, h * 0.6, 0, 0, 7);
    ctx.fill();

    // The nib: a teardrop, point upward, belly low.
    ctx.fillStyle = ink(0.94);
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.bezierCurveTo(w * 0.52, -h * 0.62, w * 0.5, -h * 0.12, 0, 0);
    ctx.bezierCurveTo(-w * 0.5, -h * 0.12, -w * 0.52, -h * 0.62, 0, -h);
    ctx.closePath();
    ctx.fill();

    // A dry highlight along the shaft, so it reads as a brush and not a blob.
    ctx.strokeStyle = `rgba(239 231 215 / 0.42)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-w * 0.12, -h * 0.72);
    ctx.lineTo(-w * 0.05, -h * 0.22);
    ctx.stroke();

    // Ink gathering at the tip while the jetpack burns.
    if (vy > 700) {
      ctx.fillStyle = ink(0.5);
      ctx.beginPath();
      ctx.ellipse(0, 3 + Math.sin(now * 0.02) * 1.5, w * 0.3, 4, 0, 0, 7);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * The stroke the nib is painting. Width follows speed, the tail thins to
   * nothing, and the whole thing is split wherever the player crossed the
   * seam — otherwise a wrap paints a stripe straight across the scroll.
   */
  function drawTrail(cameraY: number): void {
    if (trail.length < 3) return;

    let segment: { x: number; y: number; w: number }[] = [];
    const segments: { x: number; y: number; w: number }[][] = [];
    for (const point of trail) {
      if (point.break && segment.length) {
        segments.push(segment);
        segment = [];
      }
      segment.push({ x: point.x, y: sy(point.worldY, cameraY), w: point.w });
    }
    if (segment.length) segments.push(segment);

    for (const seg of segments) {
      if (seg.length < 3) continue;
      const n = seg.length;

      // 收笔 — the lift-off — is most of what makes a mark read as a brush
      // stroke rather than a line. But the taper has to stay gentle enough to
      // leave a visible belly: at pow 2.1 the whole stroke became a needle,
      // and the one wide part was hidden under the nib drawn on top of it.
      const widthAt = (i: number) => {
        const age = i / (n - 1); // 0 at tail, 1 at head
        return seg[i]!.w * Math.pow(age, 1.25);
      };

      const normalAt = (i: number): [number, number] => {
        const prev = seg[Math.max(0, i - 1)]!;
        const next = seg[Math.min(n - 1, i + 1)]!;
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        return [-dy / len, dx / len];
      };

      const path = (spread: number) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const [nx, ny] = normalAt(i);
          const w = (widthAt(i) * spread) / 2;
          ctx.lineTo(seg[i]!.x + nx * w, seg[i]!.y + ny * w);
        }
        for (let i = n - 1; i >= 0; i--) {
          const [nx, ny] = normalAt(i);
          const w = (widthAt(i) * spread) / 2;
          ctx.lineTo(seg[i]!.x - nx * w, seg[i]!.y - ny * w);
        }
        ctx.closePath();
      };

      // Damp bleed, then the wet body over it.
      ctx.fillStyle = ink(0.09);
      path(1.9);
      ctx.fill();
      ctx.fillStyle = ink(0.36);
      path(1);
      ctx.fill();
    }
  }

  function drawMonster(x: number, y: number, phase: number, now: number): void {
    const cx = x + MONSTER_W / 2;
    const cy = y + MONSTER_H / 2;
    const pulse = 0.85 + 0.15 * Math.sin(now * 0.005 + phase);

    // A splattered blot with flicked hairs — the one mark on the page that
    // was not made carefully. Vermillion so danger reads instantly.
    ctx.fillStyle = "rgba(176 58 42 / 0.14)";
    ctx.beginPath();
    ctx.arc(cx, cy, MONSTER_W * 0.62 * pulse, 0, 7);
    ctx.fill();

    ctx.fillStyle = CINNABAR;
    ctx.beginPath();
    const lobes = 7;
    for (let i = 0; i <= lobes * 2; i++) {
      const a = (i / (lobes * 2)) * Math.PI * 2 + phase;
      const r = (i % 2 === 0 ? MONSTER_W * 0.42 : MONSTER_W * 0.24) * pulse;
      const jitter = 1 + (wobble(Math.round(phase * 100) + i, 3) - 0.5) * 0.35;
      ctx.lineTo(cx + Math.cos(a) * r * jitter, cy + Math.sin(a) * r * jitter);
    }
    ctx.closePath();
    ctx.fill();

    // Flicked droplets.
    ctx.fillStyle = "rgba(176 58 42 / 0.75)";
    for (let i = 0; i < 5; i++) {
      const a = phase + i * 1.7 + now * 0.0008;
      const r = MONSTER_W * (0.6 + wobble(i, 9) * 0.35);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.1 + wobble(i, 11) * 1.4, 0, 7);
      ctx.fill();
    }
  }

  function drawPickup(x: number, y: number, now: number): void {
    // A cloud scroll — 祥云 — the traditional way of drawing "carried upward".
    const cx = x + 13;
    const cy = y + 13 + Math.sin(now * 0.004) * 3;
    ctx.strokeStyle = ink(0.6);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx - 5, cy, 6, Math.PI * 0.6, Math.PI * 1.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + 5, cy - 2, 5, Math.PI * 0.5, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 5);
    ctx.quadraticCurveTo(cx, cy + 9, cx + 10, cy + 3);
    ctx.stroke();
  }

  function drawSummit(screenY: number, now: number): void {
    // A far peak, then the seal that finishes a painting.
    ctx.fillStyle = ink(0.24);
    ctx.beginPath();
    ctx.moveTo(-20, screenY + 40);
    ctx.lineTo(WORLD_WIDTH * 0.3, screenY - 46);
    ctx.lineTo(WORLD_WIDTH * 0.42, screenY - 8);
    ctx.lineTo(WORLD_WIDTH * 0.58, screenY - 62);
    ctx.lineTo(WORLD_WIDTH * 0.78, screenY - 6);
    ctx.lineTo(WORLD_WIDTH + 20, screenY + 40);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = ink(0.5);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, screenY + 40);
    ctx.quadraticCurveTo(WORLD_WIDTH / 2, screenY + 24, WORLD_WIDTH, screenY + 40);
    ctx.stroke();

    const s = 20 + Math.sin(now * 0.003) * 1.5;
    ctx.fillStyle = "rgba(176 58 42 / 0.9)";
    ctx.fillRect(WORLD_WIDTH / 2 - s, screenY - 18 - s, s * 2, s * 2);
    ctx.fillStyle = PAPER;
    ctx.font = `700 ${Math.round(s * 1.1)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("頂", WORLD_WIDTH / 2, screenY - 17);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  /**
   * The scroll behind everything. Ink thins as you climb: near ranges drop
   * away, far ones pale into mist, and the top of the painting is bare paper.
   * 留白 is the progress bar.
   */
  function drawScroll(progress: number, cameraY: number): void {
    ctx.drawImage(paper, 0, 0);

    const ranges = [
      { factor: 0.34, base: 120, height: 190, alpha: 0.46, seed: 1.7, crag: 1 },
      { factor: 0.16, base: 40, height: 250, alpha: 0.26, seed: 5.1, crag: 0.6 },
      { factor: 0.07, base: 0, height: 300, alpha: 0.13, seed: 9.4, crag: 0.35 },
    ];

    for (const [index, range] of ranges.entries()) {
      // Nearer ranges leave the frame sooner, and everything fades as the air
      // thins — by the summit the page is almost empty.
      const fade = Math.max(0, 1 - progress / (0.45 + index * 0.28));
      if (fade <= 0.01) continue;

      const footY = sy(range.base, cameraY * range.factor);
      if (footY < -range.height) continue;

      // Layered sines at unrelated frequencies, so the ridge never repeats
      // and never falls into a rhythm. The first attempt alternated tall and
      // short peaks at even spacing and came out as a row of identical
      // triangles — geometry, not a mountain.
      const ridge = (t: number): number => {
        const s = range.seed;
        const rolling =
          Math.sin(t * 5.3 + s) * 0.44 +
          Math.sin(t * 11.7 + s * 2.1) * 0.24 +
          Math.sin(t * 23.3 + s * 3.7) * 0.12 +
          Math.sin(t * 41.9 + s * 5.3) * 0.06 * range.crag;
        // Bias upward so the range sits mostly high, with dips rather than
        // spikes — distant ink mountains read as mass, not as teeth.
        return 0.58 + rolling * 0.42;
      };

      // Ink is heaviest at the foot and bleeds out toward the ridge.
      const wash = ctx.createLinearGradient(0, footY - range.height, 0, footY + 40);
      wash.addColorStop(0, ink(range.alpha * fade * 0.25));
      wash.addColorStop(0.55, ink(range.alpha * fade * 0.85));
      wash.addColorStop(1, ink(range.alpha * fade));
      ctx.fillStyle = wash;

      ctx.beginPath();
      ctx.moveTo(-10, VIEW_HEIGHT + 10);
      ctx.lineTo(-10, footY);
      const samples = 74;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        ctx.lineTo(-10 + (WORLD_WIDTH + 20) * t, footY - range.height * ridge(t));
      }
      ctx.lineTo(WORLD_WIDTH + 10, footY);
      ctx.lineTo(WORLD_WIDTH + 10, VIEW_HEIGHT + 10);
      ctx.closePath();
      ctx.fill();
    }

    // Mist: bands of bare paper laid back over the ranges.
    for (let i = 0; i < 3; i++) {
      const bandY = ((cameraY * 0.09 + i * 260) % (VIEW_HEIGHT + 300)) - 150;
      const screenBand = VIEW_HEIGHT - bandY;
      const g = ctx.createLinearGradient(0, screenBand - 46, 0, screenBand + 46);
      g.addColorStop(0, "rgba(239 231 215 / 0)");
      g.addColorStop(0.5, `rgba(239 231 215 / ${0.72 - progress * 0.3})`);
      g.addColorStop(1, "rgba(239 231 215 / 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, screenBand - 46, WORLD_WIDTH, 92);
    }
  }

  function drawHud(state: GameState, progress: number): void {
    const metres = Math.round(progressY(state) / 10);
    const label = `${metres}`;

    ctx.textAlign = "left";
    ctx.font = '600 26px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    const width = ctx.measureText(label).width;
    ctx.fillStyle = ink(0.82);
    ctx.fillText(label, 20, 42);
    ctx.font = '400 12px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    ctx.fillStyle = ink(0.45);
    ctx.fillText("丈", 20 + width + 6, 42);

    // The climb as a brush stroke up the right edge: bare paper above, ink
    // below. No label, because a label would be an instruction.
    const trackX = WORLD_WIDTH - 16;
    const top = 64;
    const bottom = VIEW_HEIGHT - 64;
    ctx.strokeStyle = ink(0.14);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(trackX, top);
    ctx.lineTo(trackX, bottom);
    ctx.stroke();

    const head = lerp(bottom, top, Math.min(1, progress));
    ctx.strokeStyle = ink(0.62);
    ctx.lineWidth = 3.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trackX, bottom);
    ctx.lineTo(trackX, head);
    ctx.stroke();
    ctx.fillStyle = ink(0.7);
    ctx.beginPath();
    ctx.arc(trackX, head, 2.6, 0, 7);
    ctx.fill();
  }

  function drawEnding(state: GameState, now: number): void {
    const won = state.status === "won";
    ctx.fillStyle = "rgba(239 231 215 / 0.84)";
    ctx.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);

    const cx = WORLD_WIDTH / 2;
    const cy = VIEW_HEIGHT / 2;

    // A single wet stroke, brushed across, then the seal beneath it.
    ctx.save();
    ctx.translate(cx - 120, cy - 96);
    stroke(0, 0, 240, won ? 20 : 13, won ? 0.88 : 0.5, won ? 0 : 1, won ? 2 : 9);
    ctx.restore();

    ctx.textAlign = "center";
    ctx.fillStyle = ink(0.86);
    ctx.font = '700 44px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    ctx.fillText(won ? "登頂" : "墜", cx, cy - 30);

    ctx.font = '600 58px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    ctx.fillStyle = ink(0.8);
    ctx.fillText(`${Math.round(progressY(state) / 10)}`, cx, cy + 44);
    ctx.font = '400 13px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    ctx.fillStyle = ink(0.45);
    ctx.fillText("丈", cx, cy + 66);

    // The seal: red, square, and the only saturated thing on the page.
    const s = 26;
    ctx.fillStyle = "rgba(176 58 42 / 0.92)";
    ctx.fillRect(cx - s / 2, cy + 92, s, s);
    ctx.fillStyle = PAPER;
    ctx.font = '700 17px "Songti SC", "Noto Serif CJK SC", Georgia, serif';
    ctx.textBaseline = "middle";
    ctx.fillText(won ? "成" : "再", cx, cy + 92 + s / 2 + 1);
    ctx.textBaseline = "alphabetic";

    // Restart affordance: a brushed circle, drawn as if still wet.
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(now * 0.0022));
    ctx.strokeStyle = ink(0.16 + pulse * 0.3);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy + 92 + s / 2, 30, 0.5, Math.PI * 1.82);
    ctx.stroke();
    ctx.textAlign = "left";
  }

  function draw(state: GameState, now: number): void {
    const cameraY = state.cameraY;
    const progress = Math.min(1, progressY(state) / SUMMIT_Y);
    const p = state.player;

    ctx.fillStyle = PAPER_DEEP;
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);
    ctx.clip();

    const bounced = p.vy > 200 && lastVy < 0;
    if (bounced) {
      shake = Math.min(6, 2.5 + p.vy / 300);
      const at = sy(p.y, cameraY);
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 60 + Math.random() * 110;
        particles.push({
          x: p.x,
          y: at,
          vx: Math.cos(a) * sp,
          vy: -Math.abs(Math.sin(a)) * sp * 0.5,
          life: 1,
          maxLife: 0.35 + Math.random() * 0.4,
          size: 0.9 + Math.random() * 2,
        });
      }
    }
    lastVy = p.vy;
    shake *= 0.85;
    if (shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    drawScroll(progress, cameraY);

    if (SUMMIT_Y - cameraY < VIEW_HEIGHT + 140) drawSummit(sy(SUMMIT_Y, cameraY), now);

    // Record the brush trail in screen space. Width follows speed, which is
    // what makes acceleration legible as a thickening stroke.
    const feet = sy(p.y, cameraY);
    const speed = Math.hypot(p.vx, p.vy * 0.55);
    const wrapped = Math.abs(p.x - lastX) > WORLD_WIDTH / 2;
    trail.push({
      x: p.x,
      worldY: p.y + PLAYER_H * 0.35,
      // Speed is the whole point of the request: the faster the nib travels,
      // the more it presses, the wider the mark it leaves.
      w: Math.min(17, 2.4 + (speed / 420) * 10.5),
      break: wrapped,
    });
    lastX = p.x;
    // Shorter than it was: a long tail turned every climb into one continuous
    // ribbon, and a stroke needs an end to read as a stroke.
    if (trail.length > 19) trail.shift();

    drawTrail(cameraY);

    for (const plat of state.platforms) {
      if (!plat.alive) continue;
      const y = sy(plat.y, cameraY);
      if (y < -40 || y > VIEW_HEIGHT + 40) continue;
      drawPlatform(plat, y, now);
    }

    for (const pick of state.pickups) {
      if (!pick.alive) continue;
      const y = sy(pick.y, cameraY);
      if (y < -40 || y > VIEW_HEIGHT + 40) continue;
      drawPickup(pick.x, y - 26, now);
    }

    for (const mon of state.monsters) {
      if (!mon.alive) continue;
      const y = sy(mon.y, cameraY);
      if (y < -60 || y > VIEW_HEIGHT + 60) continue;
      drawMonster(mon.x, y - MONSTER_H, mon.driftPhase, now);
    }

    // Missiles: flicked droplets of ink.
    ctx.fillStyle = ink(0.72);
    for (const m of state.missiles) {
      const y = sy(m.y, cameraY);
      if (y < -20 || y > VIEW_HEIGHT + 20) continue;
      ctx.beginPath();
      ctx.ellipse(m.x, y - 5, 2.6, 6.5, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = ink(0.2);
      ctx.beginPath();
      ctx.arc(m.x, y + 6, 1.6, 0, 7);
      ctx.fill();
      ctx.fillStyle = ink(0.72);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const part = particles[i]!;
      part.life -= 0.016 / part.maxLife;
      if (part.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      part.x += part.vx * 0.016;
      part.y += part.vy * 0.016;
      part.vy += 280 * 0.016;
      ctx.fillStyle = ink(0.4 * part.life);
      ctx.beginPath();
      ctx.arc(part.x, part.y, part.size * part.life, 0, 7);
      ctx.fill();
    }

    drawNib(p.x, feet, p.vy, p.vx, now);
    if (p.x < PLAYER_W) drawNib(p.x + WORLD_WIDTH, feet, p.vy, p.vx, now);
    if (p.x > WORLD_WIDTH - PLAYER_W) drawNib(p.x - WORLD_WIDTH, feet, p.vy, p.vx, now);

    if (state.status === "playing") drawHud(state, progress);
    else drawEnding(state, now);

    ctx.restore();
  }

  resize();
  return { draw, resize };
}
