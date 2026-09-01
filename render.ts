// Everything you see, and nothing you can lose by. The renderer reads game
// state and never writes it: particles, screen shake and squash live here
// because none of them are rules.
//
// The sky is the reason this file has opinions. Altitude drives a gradient
// from night ground through an atmosphere burn into open space, so "how far
// up am I" is answered by the colour of the screen rather than by a label.
// That is the only progress instruction the game is allowed.

import {
  progressY,
  SUMMIT_Y,
  TUNING,
  VIEW_HEIGHT,
  WORLD_WIDTH,
  type GameState,
} from "./game.ts";

const { PLATFORM_W, PLATFORM_H, PLAYER_W, PLAYER_H, MONSTER_W, MONSTER_H } = TUNING;

type Rgb = [number, number, number];

interface SkyStop {
  at: number;
  top: Rgb;
  bottom: Rgb;
}

// Night ground -> atmosphere glow -> sunset band -> thin air -> space.
const SKY: SkyStop[] = [
  { at: 0.0, top: [22, 34, 78], bottom: [10, 15, 38] },
  { at: 0.3, top: [91, 47, 110], bottom: [36, 26, 68] },
  { at: 0.55, top: [122, 58, 94], bottom: [42, 28, 74] },
  { at: 0.78, top: [16, 26, 58], bottom: [6, 10, 28] },
  { at: 1.0, top: [2, 3, 12], bottom: [0, 0, 6] },
];

const CYAN = "#5ff2ff";
const AMBER = "#ffa14d";
const VIOLET = "#c77dff";
const HOT = "#ff5d8f";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: string;
  size: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  twinkle: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(a: Rgb, b: Rgb, t: number): string {
  return `rgb(${Math.round(lerp(a[0], b[0], t))} ${Math.round(lerp(a[1], b[1], t))} ${Math.round(
    lerp(a[2], b[2], t),
  )})`;
}

function skyAt(progress: number): { top: string; bottom: string } {
  const p = Math.max(0, Math.min(1, progress));
  let lo = SKY[0]!;
  let hi = SKY[SKY.length - 1]!;
  for (let i = 0; i < SKY.length - 1; i++) {
    if (p >= SKY[i]!.at && p <= SKY[i + 1]!.at) {
      lo = SKY[i]!;
      hi = SKY[i + 1]!;
      break;
    }
  }
  const span = hi.at - lo.at || 1;
  const t = (p - lo.at) / span;
  return { top: mix(lo.top, hi.top, t), bottom: mix(lo.bottom, hi.bottom, t) };
}

function starLayer(count: number, seed: number): Star[] {
  let s = seed;
  const rand = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
  return Array.from({ length: count }, () => ({
    x: rand() * WORLD_WIDTH,
    y: rand() * VIEW_HEIGHT,
    r: 0.5 + rand() * 1.4,
    twinkle: rand() * Math.PI * 2,
  }));
}

export interface Renderer {
  draw(state: GameState, now: number): void;
  resize(): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d")!;
  const particles: Particle[] = [];
  // Three layers at different parallax rates; tiled vertically so the field
  // never runs out on a 12,000px climb.
  const layers = [
    { stars: starLayer(46, 7), factor: 0.12, alpha: 0.45 },
    { stars: starLayer(34, 99), factor: 0.28, alpha: 0.7 },
    { stars: starLayer(18, 1234), factor: 0.5, alpha: 1 },
  ];

  let lastVy = 0;
  let shake = 0;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    scale = Math.min(vw / WORLD_WIDTH, vh / VIEW_HEIGHT);
    const w = WORLD_WIDTH * scale;
    const h = VIEW_HEIGHT * scale;
    offsetX = (vw - w) / 2;
    offsetY = (vh - h) / 2;

    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burst(x: number, y: number, hue: string, count: number, spread: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.3 + Math.random() * 0.7);
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.abs(Math.sin(a)) * sp * 0.6,
        life: 1,
        maxLife: 0.4 + Math.random() * 0.4,
        hue,
        size: 1.5 + Math.random() * 2.5,
      });
    }
  }

  /** World y (up) to screen y (down), within the 480x720 logical stage. */
  function sy(worldY: number, cameraY: number): number {
    return VIEW_HEIGHT - (worldY - cameraY);
  }

  function glow(color: string, blur: number): void {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  }

  function noGlow(): void {
    ctx.shadowBlur = 0;
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPlatform(
    x: number,
    y: number,
    kind: GameState["platforms"][number]["kind"],
    now: number,
  ): void {
    if (kind === "trampoline") {
      // A treat, and it should look like one: brighter, breathing.
      const pulse = 0.6 + 0.4 * Math.sin(now * 0.006);
      glow(VIOLET, 18 + pulse * 14);
      ctx.fillStyle = VIOLET;
      roundRect(x, y, PLATFORM_W, PLATFORM_H, 7);
      ctx.fill();
      noGlow();
      ctx.strokeStyle = "rgba(255 255 255 / 0.75)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const px = x + 8 + (i * (PLATFORM_W - 16)) / 4;
        ctx.moveTo(px, y + 3);
        ctx.lineTo(px, y + PLATFORM_H - 3);
      }
      ctx.stroke();
      return;
    }

    if (kind === "broken") {
      // Dim, warm, and visibly split. It must not read as "solid but tinted":
      // the gap down the middle is the tell, and it survives a colourblind
      // player because the shape differs, not only the hue.
      glow(AMBER, 10);
      ctx.fillStyle = "rgba(255 161 77 / 0.55)";
      roundRect(x, y, PLATFORM_W * 0.42, PLATFORM_H, 5);
      ctx.fill();
      roundRect(x + PLATFORM_W * 0.58, y, PLATFORM_W * 0.42, PLATFORM_H, 5);
      ctx.fill();
      noGlow();
      ctx.strokeStyle = "rgba(255 200 150 / 0.5)";
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + PLATFORM_W * 0.44, y + PLATFORM_H / 2);
      ctx.lineTo(x + PLATFORM_W * 0.56, y + PLATFORM_H / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    glow(CYAN, 16);
    ctx.fillStyle = CYAN;
    roundRect(x, y, PLATFORM_W, PLATFORM_H, 7);
    ctx.fill();
    noGlow();
    ctx.fillStyle = "rgba(255 255 255 / 0.55)";
    roundRect(x + 6, y + 2, PLATFORM_W - 12, 2.5, 1.5);
    ctx.fill();
  }

  function drawCraft(cx: number, feetY: number, vy: number, now: number): void {
    // Squash on the way down, stretch on the way up: the whole feel of the
    // bounce lives in these two numbers.
    const t = Math.max(-1, Math.min(1, vy / 900));
    const sxs = 1 - t * 0.16;
    const sys = 1 + t * 0.2;
    const w = PLAYER_W * sxs;
    const h = PLAYER_H * sys;
    const x = cx - w / 2;
    const y = feetY - h;

    // Thruster, only while climbing.
    if (vy > 60) {
      const flame = 8 + Math.min(18, vy / 40) + Math.sin(now * 0.03) * 3;
      const g = ctx.createLinearGradient(cx, feetY, cx, feetY + flame);
      g.addColorStop(0, "rgba(95 242 255 / 0.9)");
      g.addColorStop(1, "rgba(95 242 255 / 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - 6, feetY - 2);
      ctx.lineTo(cx + 6, feetY - 2);
      ctx.lineTo(cx, feetY + flame);
      ctx.closePath();
      ctx.fill();
    }

    glow(CYAN, 22);
    ctx.fillStyle = "#eaffff";
    // Hexagonal hull, nose up.
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, y + h * 0.32);
    ctx.lineTo(x + w * 0.82, y + h);
    ctx.lineTo(x + w * 0.18, y + h);
    ctx.lineTo(x, y + h * 0.32);
    ctx.closePath();
    ctx.fill();
    noGlow();

    // The cannon. Nothing on screen says "press space", so the craft has to
    // look armed: a muzzle on the nose, lit, pointing the way missiles go.
    ctx.fillStyle = HOT;
    glow(HOT, 12);
    roundRect(cx - 2.5, y - 6, 5, 8, 2);
    ctx.fill();
    noGlow();

    // Cockpit.
    ctx.fillStyle = "rgba(20 40 70 / 0.85)";
    ctx.beginPath();
    ctx.ellipse(cx, y + h * 0.5, w * 0.22, h * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMonster(x: number, y: number, phase: number, now: number): void {
    const cx = x + MONSTER_W / 2;
    const cy = y + MONSTER_H / 2;
    const pulse = 0.75 + 0.25 * Math.sin(now * 0.005 + phase);
    glow(HOT, 20 * pulse);
    ctx.fillStyle = HOT;
    // A spiked rotor: unmistakably hostile, and readable at a glance while
    // you are falling toward it.
    ctx.beginPath();
    const spikes = 7;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 + now * 0.0012 + phase;
      const r = i % 2 === 0 ? (MONSTER_W / 2) * pulse : MONSTER_W / 4;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    noGlow();
    ctx.fillStyle = "#1a0410";
    ctx.beginPath();
    ctx.arc(cx, cy, MONSTER_W * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPickup(x: number, y: number, now: number): void {
    const cx = x + 13;
    const cy = y + 13;
    const bob = Math.sin(now * 0.004) * 3;
    glow(VIOLET, 20);
    ctx.fillStyle = VIOLET;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + now * 0.001;
      ctx.lineTo(cx + Math.cos(a) * 11, cy + bob + Math.sin(a) * 11);
    }
    ctx.closePath();
    ctx.fill();
    noGlow();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + bob + 5);
    ctx.lineTo(cx, cy + bob - 5);
    ctx.moveTo(cx - 3.5, cy + bob - 1.5);
    ctx.lineTo(cx, cy + bob - 5);
    ctx.lineTo(cx + 3.5, cy + bob - 1.5);
    ctx.stroke();
  }

  function drawSummit(screenY: number, now: number): void {
    // The destination, drawn as a lit gate rather than a finish line: it
    // should pull you upward from the moment it edges into view.
    const g = ctx.createLinearGradient(0, screenY - 60, 0, screenY + 40);
    g.addColorStop(0, "rgba(95 242 255 / 0)");
    g.addColorStop(0.55, "rgba(95 242 255 / 0.35)");
    g.addColorStop(1, "rgba(95 242 255 / 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, screenY - 60, WORLD_WIDTH, 100);

    glow(CYAN, 26);
    ctx.strokeStyle = "#eaffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, screenY);
    ctx.lineTo(WORLD_WIDTH, screenY);
    ctx.stroke();
    const r = 46 + Math.sin(now * 0.003) * 5;
    ctx.beginPath();
    ctx.arc(WORLD_WIDTH / 2, screenY, r, Math.PI, Math.PI * 2);
    ctx.stroke();
    noGlow();
  }

  function drawSky(progress: number, cameraY: number, now: number): void {
    const { top, bottom } = skyAt(progress);
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);

    // Stars fade in with altitude and are tiled per layer.
    const starAlpha = Math.max(0, Math.min(1, (progress - 0.18) / 0.45));
    if (starAlpha > 0) {
      for (const layer of layers) {
        ctx.fillStyle = `rgba(255 255 255 / ${starAlpha * layer.alpha})`;
        const shift = (cameraY * layer.factor) % VIEW_HEIGHT;
        for (const s of layer.stars) {
          let y = (s.y + shift) % VIEW_HEIGHT;
          if (y < 0) y += VIEW_HEIGHT;
          const tw = 0.6 + 0.4 * Math.sin(now * 0.002 + s.twinkle);
          ctx.beginPath();
          ctx.arc(s.x, y, s.r * tw, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // A nebula smear once you are properly out of the air.
    if (progress > 0.7) {
      const a = Math.min(0.5, (progress - 0.7) / 0.3) * 0.5;
      const neb = ctx.createRadialGradient(
        WORLD_WIDTH * 0.7,
        VIEW_HEIGHT * 0.3,
        10,
        WORLD_WIDTH * 0.7,
        VIEW_HEIGHT * 0.3,
        320,
      );
      neb.addColorStop(0, `rgba(199 125 255 / ${a})`);
      neb.addColorStop(1, "rgba(199 125 255 / 0)");
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);
    }

    // City silhouette, only while the ground is still close.
    const cityAlpha = Math.max(0, 1 - cameraY / 900);
    if (cityAlpha > 0.01) {
      ctx.fillStyle = `rgba(4 6 20 / ${cityAlpha})`;
      let x = 0;
      let seed = 5;
      const rand = () => {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
        return seed / 0x1_0000_0000;
      };
      while (x < WORLD_WIDTH) {
        const w = 24 + rand() * 44;
        const h = 40 + rand() * 120;
        const baseY = VIEW_HEIGHT + cameraY;
        ctx.fillRect(x, baseY - h, w, h + 10);
        x += w + 6;
      }
    }
  }

  function drawHud(state: GameState, progress: number): void {
    // The only text during play is a number. A label would be an
    // instruction, and the sky already says which way is forward.
    const metres = Math.round(progressY(state) / 10);
    ctx.font = "600 26px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255 255 255 / 0.92)";
    glow("rgba(95 242 255 / 0.8)", 14);
    ctx.fillText(`${metres}`, 18, 40);
    noGlow();
    ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(255 255 255 / 0.45)";
    ctx.fillText("M", 20 + ctx.measureText(`${metres}`).width * 1.9, 40);

    // A track up the right edge: wordless proof there is a top to reach.
    const trackX = WORLD_WIDTH - 12;
    const top = 60;
    const bottom = VIEW_HEIGHT - 60;
    ctx.strokeStyle = "rgba(255 255 255 / 0.14)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(trackX, top);
    ctx.lineTo(trackX, bottom);
    ctx.stroke();

    ctx.strokeStyle = CYAN;
    glow(CYAN, 10);
    ctx.beginPath();
    ctx.moveTo(trackX, bottom);
    ctx.lineTo(trackX, lerp(bottom, top, Math.min(1, progress)));
    ctx.stroke();
    noGlow();
  }

  function drawEnding(state: GameState, now: number): void {
    const won = state.status === "won";
    ctx.fillStyle = won ? "rgba(4 20 30 / 0.72)" : "rgba(20 4 12 / 0.72)";
    ctx.fillRect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);

    const cx = WORLD_WIDTH / 2;
    const cy = VIEW_HEIGHT / 2;
    const accent = won ? CYAN : HOT;

    glow(accent, 30);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 54, 34 + Math.sin(now * 0.004) * 3, 0, Math.PI * 2);
    ctx.stroke();
    noGlow();

    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(won ? "SUMMIT" : "FELL", cx, cy - 48);

    ctx.font = "700 54px ui-monospace, SFMono-Regular, Menlo, monospace";
    glow(accent, 18);
    ctx.fillText(`${Math.round(progressY(state) / 10)}`, cx, cy + 30);
    noGlow();
    ctx.font = "500 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(255 255 255 / 0.5)";
    ctx.fillText("METRES", cx, cy + 52);

    // Restart affordance: a glyph, not a sentence.
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);
    ctx.strokeStyle = `rgba(255 255 255 / ${0.35 + pulse * 0.45})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy + 108, 15, 0.6, Math.PI * 1.75);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 12, cy + 96);
    ctx.lineTo(cx + 16, cy + 105);
    ctx.lineTo(cx + 6, cy + 104);
    ctx.closePath();
    ctx.fillStyle = `rgba(255 255 255 / ${0.35 + pulse * 0.45})`;
    ctx.fill();
    ctx.textAlign = "left";
  }

  function draw(state: GameState, now: number): void {
    const cameraY = state.cameraY;
    const progress = Math.min(1, progressY(state) / SUMMIT_Y);

    // The stage is letterboxed on anything wider than 2:3, and drawing is
    // clipped to it — so the surround has to be painted every frame or it
    // keeps whatever was there last.
    ctx.fillStyle = "#04050c";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Clip to the stage so glow never bleeds into the letterbox.
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_WIDTH, VIEW_HEIGHT);
    ctx.clip();

    // Landing shake, decayed here rather than stored in the game.
    const bounced = state.player.vy > 200 && lastVy < 0;
    if (bounced) {
      shake = Math.min(7, 3 + state.player.vy / 260);
      burst(state.player.x, sy(state.player.y, cameraY), CYAN, 12, 170);
    }
    lastVy = state.player.vy;
    shake *= 0.86;
    if (shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    drawSky(progress, cameraY, now);

    if (SUMMIT_Y - cameraY < VIEW_HEIGHT + 120) {
      drawSummit(sy(SUMMIT_Y, cameraY), now);
    }

    for (const p of state.platforms) {
      if (!p.alive) continue;
      const y = sy(p.y, cameraY);
      if (y < -40 || y > VIEW_HEIGHT + 40) continue;
      drawPlatform(p.x, y, p.kind, now);
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

    glow(HOT, 14);
    ctx.fillStyle = "#ffd9e4";
    for (const m of state.missiles) {
      const y = sy(m.y, cameraY);
      if (y < -20 || y > VIEW_HEIGHT + 20) continue;
      roundRect(m.x - 2.5, y - 12, 5, 14, 2.5);
      ctx.fill();
    }
    noGlow();

    // Particles.
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= 0.016 / p.maxLife;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * 0.016;
      p.y += p.vy * 0.016;
      p.vy += 320 * 0.016;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.hue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The craft, drawn twice near the edges so wrapping reads as continuous.
    const feet = sy(state.player.y, cameraY);
    drawCraft(state.player.x, feet, state.player.vy, now);
    if (state.player.x < PLAYER_W) drawCraft(state.player.x + WORLD_WIDTH, feet, state.player.vy, now);
    if (state.player.x > WORLD_WIDTH - PLAYER_W) {
      drawCraft(state.player.x - WORLD_WIDTH, feet, state.player.vy, now);
    }

    if (state.status === "playing") drawHud(state, progress);
    else drawEnding(state, now);

    ctx.restore();
  }

  resize();
  return { draw, resize };
}
