import { Container, Graphics, Sprite } from 'pixi.js';
import { VIRTUAL_W, BOARD, FRUITS } from '../config.js';
import { Particles } from './particles.js';
import { makeText, tintText } from './pixfont.js';
import { ScreenFx } from './screen.js';
import { ring, beadRing, spike, quantAlpha, paletteFor, DITHER_LEVELS } from './draw.js';

/** Jar dust: cool neutrals, deliberately *not* fruit-coloured, so the player
 *  can tell a collision from a merge out of the corner of their eye. */
const DUST = [0xd2dcf2, 0x9aa9d0, 0x6d7ba6];

/** Every burst mark is drawn twice: once two texels wider in this ink, then in
 *  its own colour. A white shard on a lit persimmon is invisible without it,
 *  and merges happen *on top of fruit* by definition. */
const INK = 0x160c22;

/** Score-popup colour ladder, indexed by combo depth. */
const COMBO_TINTS = [0xffffff, 0xffe98a, 0xffc247, 0xff8a3c, 0xff5a6e, 0xff8ae0];

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

    // Screen-space effects own the overlay layer; the banner goes in after
    // them so the win text is never dimmed by its own blowout.
    this.screen = new ScreenFx(ctx.layers.overlay);
    this.banner = new Container();
    ctx.layers.overlay.addChild(this.banner);

    this.rings = [];
    this.spikes = [];
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
    delay = 0, bead = false, white = false,
  }) {
    this._budget(this.rings, 5);
    this.rings.push({ x, y, r0, r1, life, thick0, thick1, colour, edge, age: -delay, bead, white });
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
      const t = makeText(l.text, { fill: l.fill, outline: l.outline ?? 0x1b0f26 });
      t.scale.set(l.scale);
      const lw = t.fxWidth * l.scale;
      t.y = h;
      rows.push({ t, w: lw, fill: l.fill });
      box.addChild(t);
      h += t.fxHeight * l.scale + 2;
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
    p.box.y = Math.max(32, Math.round(p.y0 - p.rise * outCubic(p.age / p.life)));
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
    const power = 0.3 + (tier / (FRUITS.length - 1)) * 1.0;
    const heat = clamp(1 + (combo - 1) * 0.14, 1, 1.8);

    this._ageOutBursts();

    // Rim light: a thin band right on the new silhouette, so the fruit itself
    // appears to ignite. A fat annulus here just reads as a vector halo and
    // hides the very sprite the burst exists to announce.
    this.addRing({
      x, y,
      r0: R + 2, r1: R + 7,
      thick0: tier >= 6 ? 4 : 3, thick1: 2,
      life: 90 + 60 * power, colour: npal.hot, edge: npal.light,
      bead: true, white: true,
    });

    // The starburst is the burst. Everything else is support.
    this.addSpikes({
      x, y, count: tier >= 5 ? 10 : 8,
      from: Math.round(R * 0.8), to: Math.round(R * 2.4 + 16 + power * 30),
      w0: tier >= 6 ? 5 : tier >= 2 ? 4 : 3, w1: 1,
      life: 130 + 80 * power, colour: 0xffffff, spin: (tier % 2) * 0.32, alt: 0.5,
    });
    // A second, sparser set of long rays over the short ones. Matching the
    // first set's count just thickens the star into a cog.
    this.addSpikes({
      x, y, count: 4,
      from: Math.round(R * 0.9), to: Math.round(Math.min(R * 2.9 + 18 + power * 34, R + 108)),
      w0: tier >= 6 ? 4 : 3, w1: 1, delay: 30,
      life: 160 + 90 * power, colour: npal.hot, spin: (tier % 2) * 0.32 + 0.39, alt: 1,
    });

    // Exactly one ring, and it is chunky: the circle motif earns its place
    // once, as the shockwave leaving the impact.
    this.addRing({
      x, y, r0: R * 1.25, r1: R * 2.1 + 16 + power * 26, life: 210 + 170 * power,
      thick0: tier >= 5 ? 3 : 2, thick1: 2, colour: pal.light, edge: pal.shadow,
      delay: 30, bead: true,
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
    const n = Math.round((16 + tier * 5.2) * heat);
    const base = 420 + power * 380;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.6;
      const sp = base * (0.5 + Math.random() * 0.8);
      const roll = Math.random();
      this.parts.spawn({
        x: x + Math.cos(a) * R * 1.15,
        y: y + Math.sin(a) * R * 1.15,
        vx: Math.cos(a) * sp,
        // Biased upward, hard. A merge deep in the pile throws half its debris
        // into fruit that swallows it; the visible half is the half that flies.
        vy: Math.sin(a) * sp * 0.8 - 120 * power,
        size: roll < 0.3 ? (tier >= 6 ? 4 : 3) : roll < 0.75 ? 2 : 1,
        // Skip the darkest stop: shadow-coloured chunks vanish into the jar.
        // Every fourth chunk comes from a marking ramp where the fruit has one
        // — a watermelon burst that throws only rind-green is half the fruit.
        colour: pal.marks.length && i % 4 === 3
          ? pal.marks[Math.floor(i / 4) % pal.marks.length]
          : pal.stops[2 + ((i * 5 + tier) % 3)],
        life: 340 + Math.random() * 360 * (0.6 + power),
        gravity: 500,
        drag: 11,
        floorY: BOARD.floor - 1,
      });
    }
    // A handful of blinking hot texels sell the flash without a glow sprite.
    for (let i = 0; i < 3 + tier; i++) {
      const a = Math.random() * TAU;
      const d = R * (1.0 + Math.random() * 0.7);
      this.parts.spawn({
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        vx: Math.cos(a) * 90, vy: Math.sin(a) * 90 - 14,
        size: 1, colour: npal.hot, life: 260 + Math.random() * 260,
        gravity: 40, drag: 4, shrink: false, blink: 70,
      });
    }

    // The top two merges get a single-step lift across the whole board — four
    // frames, one dither level. Anything longer or denser turns a late game
    // full of big merges into a strobe.
    if (tier >= 8) this.screen.blast(npal.hot, 80, 1);

    // The new fruit pops out vertically as the parents pinch in horizontally.
    this.kickSquash(rec, -0.13 - 0.12 * power, 0, 1);

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
    // The score is the primary feedback for the merge the player just made,
    // and most merges happen buried in the pile — it has to be big enough to
    // find at a glance against a board full of fruit.
    const scale = tier >= 3 || combo >= 3 ? 3 : tier >= 1 ? 2 : 1;

    // The final tier owns the banner line, so its score hangs below the fruit
    // instead of climbing into it.
    const top = tier === FRUITS.length - 1;
    const lines = [];
    // The top tier gets a full-screen banner instead; both at once collide.
    const badge = isNew && tier > 0 && tier < FRUITS.length - 1;
    if (badge) lines.push({ text: 'NEW', scale: 2, fill: 0xffe27a, outline: 0x3a2000 });
    if (combo >= 2) lines.push({ text: `X${combo}`, scale: scale + 1, fill: tint, outline: 0x2a0c18 });
    lines.push({ text: `+${gained}`, scale, fill: tint });

    this.popup(lines, x, top ? y + R + 30 : y - R - 9, {
      rise: top ? 12 : 20 + scale * 6,
      life: 640 + scale * 90 + (combo >= 2 ? 140 : 0),
      punch: 60 + depth * 20,
    });

    if (combo >= 2) {
      // Chains earn their own ring so the escalation is visible, not just read.
      this.addRing({
        x, y, r0: R * 1.15, r1: R * (2.1 + depth * 0.45), life: 230 + depth * 40,
        thick0: 2, thick1: 2, colour: tint, edge: 0x3a1020, delay: 40, bead: true,
      });
    }

    if (badge) {
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + (i / 11 - 0.5) * 2.8;
        this.parts.spawn({
          x, y: y - R * 0.4, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130,
          size: i % 3 === 0 ? 2 : 1, colour: i % 2 ? 0xffe27a : npal.hot,
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

    this.screen.blast(0xffffff, 220, DITHER_LEVELS);
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
      const text = makeText('WATERMELON', { fill: 0xfff6d0, outline: 0x2a0a12 });
      text.scale.set(3);
      text.x = Math.round((VIRTUAL_W - text.fxWidth * 3) / 2);
      text.y = BANNER_Y;
      this.banner.addChild(text);
      this.bannerLife = { box: text, age: 0, life: 2000 };
    });
  }

  onGameOver() {
    this.screen.gameOver();
    this.screen.blast(0xff6a6a, 200, 5);
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
          size: k < 4 && strength > 0.3 ? 2 : 1,
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
      p.box.alpha = t < 0.6 ? 1 : quantAlpha(1 - (t - 0.6) / 0.4);
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

  _rings(dt, g) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age < 0) continue;
      const t = r.age / r.life;
      if (t >= 1) { this.rings.splice(i, 1); continue; }
      const e = burstOut(t);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const a = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      const thick = Math.max(1, Math.round(r.thick0 + (r.thick1 - r.thick0) * e));
      // White for the first instant, then the fruit's own hot stop: the eye
      // reads the colour change as the flash cooling.
      const colour = r.white && t < 0.12 ? 0xffffff : r.colour;
      if (r.bead) {
        beadRing(g, r.x, r.y, rad, INK, a, thick + 2);
        beadRing(g, r.x, r.y, rad, colour, a, thick);
        continue;
      }
      ring(g, r.x, r.y, rad + 1, rad - thick - 1, INK, a);
      ring(g, r.x, r.y, rad, rad - thick, colour, a);
      // Rimming the band only pays once it is wide enough to survive it; on a
      // thin ring the darker edge simply eats the lit core.
      if (thick >= 4) {
        ring(g, r.x, r.y, rad, rad - 1, r.edge, a);
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
