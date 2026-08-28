import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, BOARD, FRUITS } from '../config.js';
import { Particles } from './particles.js';
import { makeText, tintText } from './pixfont.js';
import { THEME } from '../ui/hud-theme.js';
import { ScreenFx } from './screen.js';
import { disc, ring, beadRing, spike, quantAlpha, paletteFor } from './draw.js';

/** Jar dust: cool neutrals, deliberately *not* fruit-coloured, so the player
 *  can tell a collision from a merge out of the corner of their eye. */
const DUST = [0xd2dcf2, 0x9aa9d0, 0x6d7ba6];

/** Every burst mark is drawn twice: once two texels wider in this ink, then in
 *  its own colour. A white shard on a lit persimmon is invisible without it,
 *  and merges happen *on top of fruit* by definition. */
const INK = 0x160c22;

/**
 * Score-popup colour ladder, indexed by combo depth.
 *
 * It starts on the HUD's own cream rather than pure white so a single merge
 * reads as part of the same interface as the score it is adding to, and climbs
 * through the HUD's golds before leaving them for a chain. Nothing on this
 * ladder is dim: a reward rendered in grey is not a reward.
 */
const COMBO_TINTS = [THEME.cream, THEME.goldLite, THEME.gold, 0xff9d4a, 0xff6a6a, 0xff8ae0];

/** One outline for every floating string, matching the HUD's silhouette ink.
 *  A coloured halo at display weight stops reading as an outline and starts
 *  reading as a plate the text was exported on. */
const TEXT_INK = THEME.ink;

/** Where the watermelon banner lands: high in the jar, clear of the pile and
 *  clear of the score popups rising off the merge itself. */
const BANNER_Y = 138;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Ease-out: fast start, slow finish — the shape of nearly every impact. */
const outCubic = (t) => 1 - (1 - t) ** 3;
/** Violently front-loaded. A burst has to be most of the way out inside two
 *  frames or the player never sees it happen — they only see the aftermath. */
const burstOut = (t) => t ** 0.32;

/**
 * Game feel that happens at a point on the board: merge bursts, debris, score
 * popups, impact dust, sprite deformation and screen shake. Whole-screen
 * effects — the danger alarm, the game-over curtain, blowouts — belong to
 * `ScreenFx`, which this owns and drives.
 *
 * Everything drawn here obeys the same three rules as the sprites: whole texel
 * positions, integer scales, and alpha quantised to a handful of steps. A
 * burst rendered with smooth falloff on top of hand-quantised fruit is exactly
 * what makes a pixel game look like an engine demo.
 */
export class Fx {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;

    const layer = new Container();
    ctx.layers.fx.addChild(layer);

    // Back to front: the imploding parents, then the burst marks, then debris,
    // then text. The parents must go *under* the burst — on top they simply
    // hide the whole thing behind two opaque fruit.
    this.ghostLayer = new Container();
    /** Rings and stars: one geometry rebuild per frame covers all of them. */
    this.gfx = new Graphics();
    layer.addChild(this.ghostLayer, this.gfx);
    this.parts = new Particles(layer);
    this.textLayer = new Container();
    layer.addChild(this.textLayer);

    // Screen-space washes go on boardDim, under the HUD; the win banner goes
    // on overlay after them so it is never dimmed by its own blowout.
    this.screen = new ScreenFx(ctx);
    this.banner = new Container();
    ctx.layers.overlay.addChild(this.banner);

    this.rings = [];
    this.spikes = [];
    this.flashes = [];
    this.ghosts = [];
    this.popups = [];
    this.shakes = [];
    this.timers = [];
    /** uid -> squash spring; written back to `rec.fxSquash` every frame. */
    this.squash = new Map();
    this.impactQueue = [];

    const e = ctx.events;
    e.on('merge', (m) => this.onMerge(m));
    e.on('drop', (d) => this.onDrop(d));
    e.on('impact', (i) => this.impactQueue.push(i));
    e.on('danger', ({ ratio }) => this.screen.danger(ratio));
    e.on('watermelon', (w) => this.onWatermelon(w));
    e.on('gameover', () => this.onGameOver());
    e.on('reset', () => this.reset());
    e.on('start', () => this.reset());
  }

  reset() {
    this.parts.clear();
    this.rings.length = 0;
    this.spikes.length = 0;
    this.flashes.length = 0;
    this.shakes.length = 0;
    this.timers.length = 0;
    this.impactQueue.length = 0;
    for (const g of this.ghosts) g.sprite.destroy();
    this.ghosts.length = 0;
    for (const p of this.popups) p.box.destroy({ children: true });
    this.popups.length = 0;
    for (const c of this.banner.removeChildren()) c.destroy({ children: true });
    this.bannerLife = null;
    // Hand every deformed fruit back to the renderer undeformed; a run can be
    // reset mid-squash and the records outlive this module's state.
    for (const sq of this.squash.values()) sq.rec.fxSquash = null;
    this.squash.clear();
    this.screen.reset();
  }

  /* ---------------------------------------------------------------- *
   * Primitives
   * ---------------------------------------------------------------- */

  /**
   * Effects are budgeted, oldest first.
   *
   * A packed jar can cascade half a dozen merges inside one combo window, and
   * six overlapping bursts is not six times as exciting — it is unreadable.
   * Capping each kind keeps the newest, which is always the one the player is
   * actually looking at.
   */
  _budget(list, max) {
    while (list.length >= max) list.shift();
  }

  addRing({
    x, y, r0, r1, life, thick0 = 3, thick1 = 1, colour, edge,
    delay = 0, bead = false, lead = null,
  }) {
    this._budget(this.rings, 5);
    this.rings.push({ x, y, r0, r1, life, thick0, thick1, colour, edge, age: -delay, bead, lead });
  }

  addSpikes({ x, y, count, from, to, w0, w1 = 1, life, colour, spin = 0, delay = 0, alt = 1 }) {
    this._budget(this.spikes, 3);
    this.spikes.push({ x, y, count, from, to, w0, w1, life, colour, spin, age: -delay, alt });
  }

  /** Directional, decaying shake. `dx,dy` is the direction of the blow. */
  addShake(amp, dx = 0, dy = 1, life = 320, freq = 24) {
    const len = Math.hypot(dx, dy) || 1;
    this.shakes.push({ amp, dx: dx / len, dy: dy / len, life, age: 0, freq, phase: Math.random() * TAU });
  }

  after(ms, fn) { this.timers.push({ t: ms, fn }); }

  /**
   * Push every burst already in flight into its dying phase.
   *
   * Two merge stars overlapping at full brightness read as one shapeless
   * flare, and a cascade can fire four inside a quarter second. Handing the
   * frame to the newest burst is what keeps a chain legible as a *sequence*.
   */
  _ageOutBursts() {
    // Anything still waiting on its delay is dropped outright. Fast-forwarding
    // it instead would pop a ring into existence at half its final radius,
    // which reads as a rendering fault rather than an effect.
    this.rings = this.rings.filter((r) => r.age >= 0);
    this.spikes = this.spikes.filter((s) => s.age >= 0);
    for (const r of this.rings) r.age = Math.max(r.age, r.life * 0.62);
    for (const s of this.spikes) s.age = Math.max(s.age, s.life * 0.62);
  }

  /**
   * Feed the deformation channel the renderer multiplies into sprite scale.
   * `k > 0` squashes along (nx,ny); `k < 0` stretches along it.
   */
  kickSquash(rec, k, nx, ny) {
    if (!rec) return;
    const len = Math.hypot(nx, ny) || 1;
    let s = this.squash.get(rec.uid);
    if (!s) {
      s = { rec, k: 0, v: 0, ax: 0, ay: 1 };
      this.squash.set(rec.uid, s);
    }
    s.ax = Math.abs(nx / len);
    s.ay = Math.abs(ny / len);
    s.k = clamp(s.k + k, -0.28, 0.28);
  }

  /**
   * A floating stack of centred lines that rises and fades as one object.
   *
   * Score, multiplier and discovery banner all belong to a single merge, so
   * they must travel together — as independent popups with independent rise
   * speeds they slide through each other and turn into unreadable overlap.
   *
   * `lines` runs top to bottom; `bottomY` is where the stack's foot starts.
   */
  popup(lines, x, bottomY, { rise = 20, life = 720, punch = 70 } = {}) {
    while (this.popups.length >= 2) {
      this.popups.shift().box.destroy({ children: true });
    }
    const box = new Container();
    const rows = [];
    let h = 0;
    let w = 0;
    for (const l of lines) {
      const t = makeText(l.text, { fill: l.fill, outline: TEXT_INK, face: l.face });
      t.scale.set(l.scale);
      const lw = t.fxWidth * l.scale;
      t.y = h;
      rows.push({ t, w: lw, fill: l.fill });
      box.addChild(t);
      h += t.fxHeight * l.scale + 3;
      w = Math.max(w, lw);
    }
    for (const r of rows) r.t.x = Math.round((w - r.w) / 2);
    this.textLayer.addChild(box);

    const p = { box, rows, cx: x, y0: bottomY - h, w, rise, life, age: 0, punch, lit: false };
    this.popups.push(p);
    this._placePopup(p);
    return p;
  }

  _placePopup(p) {
    p.box.x = clamp(Math.round(p.cx - p.w / 2), 3, VIRTUAL_W - p.w - 3);
    // Never let a popup climb into the HUD deck; a merge near the danger line
    // would otherwise fling its score behind the score plate.
    p.box.y = Math.max(46, Math.round(p.y0 - p.rise * outCubic(p.age / p.life)));
    // The "punch" is a colour hit, not a scale hit: growing a bitmap glyph by
    // a non-integer factor is the one thing this whole module exists to avoid.
    const lit = p.age < p.punch;
    if (lit !== p.lit) {
      p.lit = lit;
      for (const r of p.rows) tintText(r.t, lit ? 0xffffff : r.fill);
    }
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  onDrop({ tier, x, y }) {
    const pal = paletteFor(tier);
    const r = FRUITS[tier].radius;
    // Release puff only. A drop happens every half second, so anything with a
    // ring or a flash turns the top of the board into a strobe.
    for (let i = 0; i < 5; i++) {
      const a = Math.PI + (i / 4 - 0.5) * 2.4;
      this.parts.spawn({
        x: x + Math.cos(a) * r * 0.5, y: y + r * 0.35,
        vx: Math.cos(a) * 34, vy: Math.sin(a) * 20 - 6,
        size: 1, colour: i === 2 ? pal.light : DUST[i % DUST.length],
        life: 200, gravity: 60, drag: 4,
      });
    }
  }

  onMerge({ tier, x, y, rec, from, gained, combo, isNew }) {
    const R = FRUITS[tier].radius;
    const parentTier = Math.max(0, tier - 1);
    const pal = paletteFor(parentTier);
    const npal = paletteFor(tier);
    // A cherry pair should register as a tick, a melon pair as an event.
    // Superlinear on purpose: linear scaling makes every merge feel the same
    // size because the fruit it sits on grew linearly too.
    const power = 0.22 + 1.25 * (tier / (FRUITS.length - 1)) ** 1.3;
    const heat = clamp(1 + (combo - 1) * 0.14, 1, 1.8);

    this._ageOutBursts();

    // The new fruit itself blows out. Nothing else in the burst says "this
    // object was just created" as directly as the object going white, and it
    // is the one mark that cannot be mistaken for the fruit already there.
    this.flashes.push({
      rec, x, y, r: R, age: 0,
      life: 90 + 90 * power, colour: npal.hot,
    });

    // Shockwave: a solid wall with a near-white leading edge. Beads and 1px
    // outlines read as a debug gizmo at this size; the ring has to have body.
    this.addRing({
      x, y,
      r0: R * 1.05, r1: Math.min(R * 1.05 + 24 + power * 78, R + 76),
      life: 230 + 220 * power,
      thick0: 5 + Math.round(power * 9), thick1: 3,
      // Saturated body under a white edge. A pale body under a white edge is
      // two whites, and the ring collapses to the 2px edge at any distance.
      colour: pal.light, edge: pal.shadow, lead: 0xffffff,
    });
    // A second wave for anything past a grape, delayed so the two read as a
    // sequence rather than a thick band.
    if (tier >= 3) {
      this.addRing({
        x, y,
        r0: R * 1.3, r1: Math.min(R * 1.3 + 40 + power * 96, R + 100),
        life: 280 + 260 * power,
        thick0: 4 + Math.round(power * 5), thick1: 2, delay: 70,
        colour: npal.light, edge: pal.shadow, lead: 0xffffff,
      });
    }

    // The starburst reaches well past both rings, so the burst has a spiky
    // silhouette instead of a set of concentric circles.
    this.addSpikes({
      x, y, count: tier >= 5 ? 12 : 8,
      from: Math.round(R * 0.8), to: Math.round(R * 1.6 + 34 + power * 74),
      w0: 3 + Math.round(power * 5), w1: 1,
      life: 170 + 130 * power, colour: 0xffffff, spin: (tier % 2) * 0.32, alt: 0.5,
    });
    this.addSpikes({
      x, y, count: 4,
      from: Math.round(R * 0.9), to: Math.round(R * 1.6 + 60 + power * 104),
      w0: 3 + Math.round(power * 4), w1: 1, delay: 40,
      life: 210 + 150 * power, colour: pal.light, spin: (tier % 2) * 0.32 + 0.39, alt: 1,
    });

    // The two parents visibly implode. They are already gone from physics, so
    // these are throwaway sprites driven purely off their last known transform,
    // trailed by chunks that fly *inward* — the ghost alone is too brief to
    // register, and inward motion is the only thing that reads as a collapse.
    for (const p of from || []) {
      if (!p) continue;
      this.addGhost(p, x, y);
      const px = p.body?.position?.x ?? x;
      const py = p.body?.position?.y ?? y;
      const pr = p.radius || FRUITS[parentTier].radius;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.4;
        const sx = px + Math.cos(a) * pr * 0.8;
        const sy = py + Math.sin(a) * pr * 0.8;
        const d = Math.hypot(x - sx, y - sy) || 1;
        this.parts.spawn({
          x: sx, y: sy,
          vx: ((x - sx) / d) * 340, vy: ((y - sy) / d) * 340,
          size: 2, colour: pal.stops[3], life: 90, gravity: 0, drag: 2, shrink: false,
        });
      }
    }

    // Debris in the parents' own ramp — this is the burst's identity. It
    // launches from the rim at high speed and is braked hard: the eye needs the
    // chunks a long way out within two frames, then wants them to hang.
    const n = Math.round((22 + tier * 8) * heat);
    const base = 440 + power * 460;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.6;
      const sp = base * (0.5 + Math.random() * 0.8);
      const roll = Math.random();
      this.parts.spawn({
        // Launched from outside the new silhouette. A chunk that starts on the
        // fruit spends its first frames as a stray texel on a saturated
        // sprite, where it reads as a dead pixel rather than as debris.
        x: x + Math.cos(a) * (R + 6),
        y: y + Math.sin(a) * (R + 6),
        vx: Math.cos(a) * sp,
        // Biased upward, hard. A merge deep in the pile throws half its debris
        // into fruit that swallows it; the visible half is the half that flies.
        vy: Math.sin(a) * sp * 0.8 - 120 * power,
        // No single-texel debris above a cherry merge: at 1x a lone texel at
        // partial contrast is indistinguishable from a stuck pixel.
        size: roll < 0.34 ? (tier >= 6 ? 5 : tier >= 3 ? 4 : 3)
          : roll < 0.8 ? (tier >= 6 ? 3 : 2) : (tier >= 2 ? 2 : 1),
        // The two lightest stops of the fruit that was destroyed, so the burst
        // is recognisably *that* fruit coming apart, plus every fourth chunk in
        // the new fruit's hot stop to tie the debris to what replaced it. The
        // dark stops are excluded outright — they vanish into the jar.
        colour: i % 4 === 3 ? npal.hot : pal.stops[3 + ((i * 5 + tier) % 2)],
        life: 340 + Math.random() * 360 * (0.6 + power),
        gravity: 500,
        drag: 11,
        floorY: BOARD.floor - 1,
      });
    }
    // Blinking white sparks hanging in the ring's wake. They are white and
    // 2px because their whole job is to be unambiguously brighter than
    // anything already on the board.
    for (let i = 0; i < 4 + tier * 2; i++) {
      const a = Math.random() * TAU;
      const d = R + 10 + Math.random() * R * 0.6;
      this.parts.spawn({
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        vx: Math.cos(a) * 90, vy: Math.sin(a) * 90 - 14,
        size: 2, colour: 0xffffff, life: 260 + Math.random() * 260,
        gravity: 40, drag: 4, shrink: false, blink: 70,
      });
    }

    // The top two merges get a single-step lift across the whole board — four
    // frames, one dither level. Anything longer or denser turns a late game
    // full of big merges into a strobe.
    if (tier >= 8) this.screen.blast(npal.hot, 90, 0.22);

    // The new fruit pops out vertically as the parents pinch in horizontally.
    this.kickSquash(rec, -0.16 - 0.14 * power, 0, 1);

    this.addShake(1 + power * heat * 4.2, (Math.random() - 0.5) * 0.7, 1,
      220 + 260 * power, 26 - power * 8);

    this.scorePopup({ tier, x, y, R, gained, combo, isNew, npal });
  }

  addGhost(p, tx, ty) {
    const tex = this.ctx.renderer?.texture(p.tier);
    if (!tex) return;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    this.ghostLayer.addChild(sprite);
    const x0 = p.body?.position?.x ?? p.px ?? tx;
    const y0 = p.body?.position?.y ?? p.py ?? ty;
    sprite.x = Math.round(x0);
    sprite.y = Math.round(y0);
    // Short and faint: at full opacity two parent sprites simply cover the
    // burst. This is an afterimage of the implosion, not a third fruit.
    this.ghosts.push({ sprite, x0, y0, tx, ty, life: 55, age: 0 });
  }

  scorePopup({ tier, x, y, R, gained, combo, isNew, npal }) {
    const depth = clamp(combo - 1, 0, COMBO_TINTS.length - 1);
    const tint = COMBO_TINTS[depth];
    // One face, one outline, one colour ladder for every score in the game;
    // the only thing that varies is the integer scale. Two `+N` popups that
    // differ in typeface or plate read as two different mechanics.
    // Scale 2 is the floor from a grape upward: the smallest reward must not
    // be the least legible thing on screen.
    const scale = tier >= 8 || combo >= 4 ? 3 : tier >= 2 || combo >= 2 ? 2 : 1;

    // The final tier owns the banner line, so its score hangs below the fruit
    // instead of climbing into it.
    const under = tier === FRUITS.length - 1;
    // Discovery gets a badge, except on the top tier where the banner already
    // says it and the two would collide.
    const badge = isNew && tier > 0 && !under;
    // Two lines, never three. A three-line stack over a merge is taller than
    // the fruit it belongs to, and the eye stops being able to tell which
    // line is the headline.
    const lines = [];
    // Lower-case x, not X: the capital is a symmetric cross that reads as a
    // letter, and the multiplier is the last thing in the game that can afford
    // to be misparsed.
    const banner = combo >= 2 ? `${badge ? 'NEW ' : ''}x${combo}` : (badge ? 'NEW' : null);
    if (banner) {
      lines.push({
        text: banner, face: 'display', fill: combo >= 2 ? tint : THEME.goldLite,
        scale: combo >= 2 ? Math.min(3, scale + 1) : scale,
      });
    }
    lines.push({ text: `+${gained}`, face: 'display', scale, fill: tint });

    this.popup(lines, x, under ? y + R + 36 : y - R - 20, {
      rise: under ? 12 : 22 + scale * 8,
      life: 680 + scale * 120 + (combo >= 2 ? 160 : 0),
      punch: 60 + depth * 20,
    });

    if (combo >= 2) {
      // Chains earn their own ring so the escalation is visible, not just read.
      this.addRing({
        x, y, r0: R * 1.15, r1: R * 1.15 + 34 + depth * 18, life: 250 + depth * 40,
        thick0: 3, thick1: 2, colour: tint, edge: THEME.ink, lead: 0xffffff, delay: 50,
      });
    }

    if (badge) {
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + (i / 11 - 0.5) * 2.8;
        this.parts.spawn({
          x, y: y - R * 0.4, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130,
          size: 2, colour: i % 2 ? THEME.goldLite : npal.hot,
          life: 640, gravity: 200, drag: 5, shrink: false, blink: 90,
        });
      }
    }
  }

  onWatermelon({ x, y }) {
    const pal = paletteFor(FRUITS.length - 1);
    const FLESH = 0xe8465c;
    const SEED = 0x1d1024;
    const RIND = 0x8fd36a;

    this.screen.blast(0xffffff, 200, 1);
    this.addShake(7, 0, 1, 1100, 20);
    this.addShake(5, 1, 0, 900, 13);

    // A white core that collapses into the fruit, then two staggered waves.
    this.addRing({
      x, y, r0: 78, r1: 58, thick0: 26, thick1: 6, life: 190,
      colour: 0xffffff, edge: RIND,
    });
    // Two waves, both stopping at the glass. A ring that sails off the board
    // stops being a shockwave and becomes a background pattern.
    for (let i = 0; i < 2; i++) {
      this.addRing({
        x, y, r0: 56 + i * 24, r1: 124 + i * 26, life: 480 + i * 170,
        thick0: i === 0 ? 4 : 3, thick1: 2, delay: i * 130,
        colour: [0xffffff, RIND][i], edge: [RIND, pal.shadow][i],
        bead: i > 0,
      });
    }
    this.addSpikes({ x, y, count: 14, from: 40, to: 140, w0: 7, w1: 1, life: 420, colour: 0xffffff, alt: 0.55 });
    this.addSpikes({
      x, y, count: 14, from: 50, to: 186, w0: 5, w1: 1, life: 520,
      colour: RIND, spin: 0.22, delay: 90, alt: 0.6,
    });

    // Three waves so the spectacle keeps unfolding instead of firing once.
    for (let wave = 0; wave < 3; wave++) {
      this.after(wave * 130, () => {
        for (let i = 0; i < 46; i++) {
          const a = Math.random() * TAU;
          const sp = 90 + Math.random() * 210;
          const roll = Math.random();
          this.parts.spawn({
            x: x + Math.cos(a) * 20, y: y + Math.sin(a) * 20,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 150,
            size: roll < 0.3 ? 4 : roll < 0.7 ? 2 : 1,
            colour: roll < 0.18 ? SEED : roll < 0.5 ? FLESH : pal.stops[1 + ((i + wave) % 4)],
            life: 700 + Math.random() * 900,
            gravity: 380, drag: 0.7, floorY: BOARD.floor - 1,
          });
        }
      });
    }

    this.after(160, () => {
      const text = makeText('WATERMELON', { fill: THEME.cream, outline: TEXT_INK, face: 'display' });
      text.scale.set(2);
      text.x = Math.round((VIRTUAL_W - text.fxWidth * 2) / 2);
      text.y = BANNER_Y;
      this.banner.addChild(text);
      this.bannerLife = { box: text, age: 0, life: 2000 };
    });
  }

  onGameOver() {
    this.screen.gameOver();
    this.screen.blast(0xff6a6a, 220, 0.6);
    this.addShake(6, 0, 1, 700, 15);
    for (let i = 0; i < 24; i++) {
      this.parts.spawn({
        x: BOARD.left + Math.random() * (BOARD.right - BOARD.left),
        y: BOARD.top + Math.random() * 40,
        vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 60,
        size: Math.random() < 0.4 ? 2 : 1, colour: DUST[i % DUST.length],
        life: 900, gravity: 260, drag: 0.9,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(frameMs, game) {
    // A backgrounded tab hands back a single enormous frame; letting that
    // through would teleport every particle off-screen in one step.
    const dt = clamp(frameMs, 0, 50);

    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); }
    }

    this._impacts(game);
    this._squash(dt);
    this.parts.update(dt);
    this._ghosts(dt);
    this._popups(dt);

    const g = this.gfx;
    g.clear();
    this._flashes(dt, g);
    this._rings(dt, g);
    this._spikes(dt, g);

    this.screen.update(dt);
    this._shake(dt);
  }

  _impacts(game) {
    const q = this.impactQueue;
    if (q.length === 0) return;
    // Stacks generate a lot of grazing contacts in one step; only the hardest
    // few are worth spending particles (or the player's attention) on.
    q.sort((a, b) => b.speed - a.speed);
    const take = Math.min(q.length, 5);
    for (let i = 0; i < take; i++) {
      const { x, y, speed, tier } = q[i];
      // Mass matters: a watermelon settling should be felt, a cherry ticking
      // off a wall should not.
      const heft = 0.55 + (tier / (FRUITS.length - 1)) * 0.8;
      const strength = clamp((speed - 1.0) / 4.5, 0, 1) * heft;
      if (strength <= 0.04) continue;

      const rec = this._fruitNear(game, x, y, tier);
      // Contact normal, pointing out of the fruit toward whatever it hit.
      let nx = 0;
      let ny = 1;
      if (rec) {
        const len = Math.hypot(x - rec.body.position.x, y - rec.body.position.y) || 1;
        nx = (x - rec.body.position.x) / len;
        ny = (y - rec.body.position.y) / len;
        this.kickSquash(rec, 0.07 + strength * 0.15, nx, ny);
      }
      // Tangent: dust skids across the surface it struck rather than bouncing
      // straight back up the normal, which is what a landing actually does.
      const tx = -ny;
      const ty = nx;

      // Two or three motes is not a landing, it is a typo. The puff has to be
      // wide and low, hugging whatever surface was struck.
      // Two or three motes is not a landing, it is a typo. The puff has to be
      // wide, low and long-lived, and it fades rather than shrinking — dust
      // that shrinks reads as debris being sucked back in.
      const count = 4 + Math.round(strength * 10);
      for (let k = 0; k < count; k++) {
        const dir = k % 2 ? 1 : -1;
        const lift = 0.35 + Math.random() * 0.7;
        const sp = (50 + strength * 150) * (0.5 + Math.random() * 0.8);
        this.parts.spawn({
          x: x + tx * dir * (2 + Math.random() * 5), y: y + ty * dir * 2,
          vx: (tx * dir - nx * lift) * sp,
          vy: (ty * dir - ny * lift) * sp,
          // Two texels minimum unless the hit was feeble: a lone pale texel
          // sitting on a saturated fruit reads as a dead pixel, not as dust.
          size: strength > 0.25 ? 2 : 1,
          colour: DUST[k % DUST.length],
          life: 260 + strength * 320, gravity: 160, drag: 3, shrink: false,
        });
      }
      if (strength > 0.4) this.addShake(0.5 + strength * 2.4, nx, ny, 170, 30);
    }
    q.length = 0;
  }

  /** Nearest live fruit whose surface the contact point sits on. */
  _fruitNear(game, x, y, tier) {
    const fruits = game?.physics?.fruits;
    if (!fruits) return null;
    let best = null;
    let bestErr = Infinity;
    for (const rec of fruits.values()) {
      const d = Math.hypot(rec.body.position.x - x, rec.body.position.y - y);
      const err = Math.abs(d - rec.radius) + (rec.tier === tier ? 0 : 3);
      if (err < bestErr && d < rec.radius + 8) { bestErr = err; best = rec; }
    }
    return best;
  }

  _squash(dt) {
    const s = dt / 1000;
    for (const [uid, sq] of this.squash) {
      // Critically-ish damped spring: one visible rebound, then still. A pure
      // exponential decay reads as deflating; the overshoot reads as rubber.
      sq.v += (-360 * sq.k - 26 * sq.v) * s;
      sq.k += sq.v * s;
      if (Math.abs(sq.k) < 0.004 && Math.abs(sq.v) < 0.05) {
        sq.rec.fxSquash = null;
        this.squash.delete(uid);
        continue;
      }
      const k = clamp(sq.k, -0.28, 0.28);
      sq.rec.fxSquash = {
        x: 1 + k * (sq.ay - sq.ax),
        y: 1 + k * (sq.ax - sq.ay),
      };
    }
  }

  _ghosts(dt) {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      gh.age += dt;
      const t = gh.age / gh.life;
      if (t >= 1) { gh.sprite.destroy(); this.ghosts.splice(i, 1); continue; }
      // Front-loaded travel: by the second frame the pair must already read as
      // one mass, or the burst looks like three fruit sitting on each other.
      const e = burstOut(t);
      gh.sprite.x = Math.round(gh.x0 + (gh.tx - gh.x0) * e);
      gh.sprite.y = Math.round(gh.y0 + (gh.ty - gh.y0) * e);
      gh.sprite.alpha = quantAlpha(0.28 * (1 - t));
    }
  }

  _popups(dt) {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.age += dt;
      if (p.age >= p.life) { p.box.destroy({ children: true }); this.popups.splice(i, 1); continue; }
      this._placePopup(p);
      const t = p.age / p.life;
      // Held opaque for most of its life, then dropped in three hard steps. A
      // long linear fade parks the number at low contrast for half a second,
      // which is exactly when it is still the thing the player is reading.
      p.box.alpha = t < 0.72 ? 1 : quantAlpha(1 - (t - 0.72) / 0.28);
    }
    const b = this.bannerLife;
    if (b) {
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) {
        b.box.destroy({ children: true });
        this.bannerLife = null;
      } else {
        // Hold, then strobe out — a banner that simply fades looks like a
        // dialog closing rather than a firework burning down.
        b.box.alpha = t < 0.62 ? 1 : (Math.floor(b.age / 80) % 2 ? 0.4 : 1);
        b.box.y = BANNER_Y - Math.round(outCubic(clamp(t * 4, 0, 1)) * 6);
      }
    }
  }

  /**
   * The white-out on a freshly merged fruit.
   *
   * It tracks the record rather than the merge point, because the new fruit is
   * launched upward on the same frame and a flash left behind at the old
   * position reads as a separate object. Stepping the radius down as it fades
   * uncovers the sprite from the outside in, so the fruit appears to cool.
   */
  _flashes(dt, g) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) { this.flashes.splice(i, 1); continue; }
      const pos = f.rec?.body?.position;
      if (pos) { f.x = pos.x; f.y = pos.y; }
      const r = f.r * (1 + 0.12 * (1 - t)) - Math.round(t * f.r * 0.55);
      // Solid white for the first two frames, then the fruit's hot stop, then
      // only a rim. Holding white any longer starts to hide the new fruit.
      if (t < 0.12) disc(g, f.x, f.y, r + 1, 0xffffff, 1);
      else if (t < 0.32) disc(g, f.x, f.y, r, f.colour, 1 - (t - 0.12) * 3);
      ring(g, f.x, f.y, r + 2, r, 0xffffff, 1 - t);
    }
  }

  _rings(dt, g) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age < 0) continue;
      const t = r.age / r.life;
      if (t >= 1) { this.rings.splice(i, 1); continue; }
      const e = burstOut(t);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const a = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      const thick = Math.max(1, Math.round(r.thick0 + (r.thick1 - r.thick0) * e));
      if (r.bead) {
        beadRing(g, r.x, r.y, rad, INK, a, thick + 2);
        beadRing(g, r.x, r.y, rad, r.colour, a, thick);
        continue;
      }
      // The ink border is a legibility device, not part of the shape: once the
      // ring is half faded it is the only thing still visible, and a dark arc
      // drifting across the jar reads as a stray line.
      if (a > 0.5) ring(g, r.x, r.y, rad + 1, rad - thick - 1, INK, a);
      ring(g, r.x, r.y, rad, rad - thick, r.colour, a);
      // A hot leading edge is what separates an expanding wall of energy from
      // an outlined circle: the front two texels stay near-white while the
      // body behind them cools to the fruit's own hue.
      if (r.lead !== null && thick >= 3) {
        ring(g, r.x, r.y, rad, rad - Math.min(2, thick - 1), r.lead, a);
        ring(g, r.x, r.y, rad - thick + 1, rad - thick, r.edge, a);
      }
    }
  }

  _spikes(dt, g) {
    for (let i = this.spikes.length - 1; i >= 0; i--) {
      const s = this.spikes[i];
      s.age += dt;
      if (s.age < 0) continue;
      const t = s.age / s.life;
      if (t >= 1) { this.spikes.splice(i, 1); continue; }
      const e = burstOut(t);
      const a = 1 - t;
      const w0 = Math.max(1, Math.round(s.w0 * (1 - t * 0.55)));
      for (let k = 0; k < s.count; k++) {
        // Alternating long and short points: an even star is a cog, an uneven
        // one is a flash.
        const reach = k % 2 ? s.alt : 1;
        const to = Math.round(s.from + (s.to - s.from) * e * reach);
        const from = Math.round(s.from + (to - s.from) * 0.42);
        const angle = (k / s.count) * TAU + s.spin;
        spike(g, s.x, s.y, angle, from, to, w0 + 2, s.w1 + 2, INK, a);
        spike(g, s.x, s.y, angle, from, to, w0, s.w1, s.colour, a);
      }
    }
  }

  _shake(dt) {
    let ox = 0;
    let oy = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) { this.shakes.splice(i, 1); continue; }
      const env = (1 - t) ** 2;
      const osc = Math.sin(s.phase + (s.age / 1000) * s.freq * TAU);
      // The oscillation gives the rattle; the leading push gives the direction.
      const lead = Math.max(0, 1 - t * 5);
      const k = s.amp * (env * osc + lead * 0.55);
      ox += k * s.dx;
      oy += k * s.dy;
    }
    // Fractional offsets would resample every sprite in the scene, so the whole
    // shake budget is spent in whole texels. The ceiling is low on purpose:
    // the backdrop is exactly viewport-sized, so anything larger walks the
    // letterbox in from the edge.
    this.root.x = clamp(Math.round(ox), -5, 5);
    this.root.y = clamp(Math.round(oy), -5, 5);
  }
}
