import Matter from 'matter-js';
import { BOARD, PHYSICS, FRUITS } from '../config.js';

const { Engine, World, Bodies, Body, Composite, Events } = Matter;

/**
 * The Matter.js world plus merge resolution.
 *
 * Merging is the whole game, and the naive version ("on collision, if same
 * tier, merge") is subtly wrong: one fruit can touch two identical partners in
 * the same tick, and a body can be scheduled for two merges at once. We
 * therefore collect candidate pairs during the step, then resolve them after
 * the step against a `consumed` set so every body is spent exactly once.
 */
export class PhysicsWorld {
  constructor({ onMerge, onImpact } = {}) {
    this.engine = Engine.create({
      gravity: { x: 0, y: PHYSICS.gravity },
      positionIterations: PHYSICS.positionIterations,
      velocityIterations: PHYSICS.velocityIterations,
      constraintIterations: PHYSICS.constraintIterations,
      enableSleeping: false,
    });
    this.world = this.engine.world;
    this.onMerge = onMerge || (() => {});
    this.onImpact = onImpact || (() => {});

    /** id -> fruit body record */
    this.fruits = new Map();
    this._pending = [];
    this._nextId = 1;

    this._buildJar();

    Events.on(this.engine, 'collisionStart', (evt) => this._onCollisionStart(evt));
  }

  _buildJar() {
    const t = BOARD.wallThickness;
    const h = BOARD.floor + t;
    const opts = {
      isStatic: true,
      friction: PHYSICS.frictionStatic,
      restitution: PHYSICS.restitution,
      slop: PHYSICS.slop,
      label: 'wall',
    };
    this.walls = [
      // Floor
      Bodies.rectangle((BOARD.left + BOARD.right) / 2, BOARD.floor + t / 2, BOARD.right - BOARD.left + t * 2, t, opts),
      // Left wall — tall enough that overflowing fruit still hits it.
      Bodies.rectangle(BOARD.left - t / 2, h / 2 - 200, t, h + 400, opts),
      // Right wall
      Bodies.rectangle(BOARD.right + t / 2, h / 2 - 200, t, h + 400, opts),
    ];
    Composite.add(this.world, this.walls);
  }

  /** Spawn a fruit of `tier` at (x, y). Returns the record. */
  spawn(tier, x, y, { vx = 0, vy = 0 } = {}) {
    const def = FRUITS[tier];
    const body = Bodies.circle(x, y, def.radius, {
      restitution: PHYSICS.restitution,
      friction: PHYSICS.friction,
      frictionStatic: PHYSICS.frictionStatic,
      frictionAir: PHYSICS.frictionAir,
      density: PHYSICS.density,
      slop: PHYSICS.slop,
      label: 'fruit',
    }, Math.max(12, Math.round(def.radius * 1.6)));
    Body.setVelocity(body, { x: vx, y: vy });

    const rec = {
      uid: this._nextId++,
      tier,
      body,
      radius: def.radius,
      /** Set on the frame it was created; art uses it for the pop-in scale. */
      bornAt: this.engine.timing.timestamp,
      /** Previous transform, for render interpolation. */
      px: x, py: y, pa: 0,
      /** True once it has touched anything — used for the danger-line rule. */
      landed: false,
      merging: false,
    };
    body.plugin.rec = rec;
    this.fruits.set(rec.uid, rec);
    Composite.add(this.world, body);
    return rec;
  }

  _onCollisionStart(evt) {
    for (const pair of evt.pairs) {
      const a = pair.bodyA.plugin?.rec;
      const b = pair.bodyB.plugin?.rec;

      if (a) a.landed = true;
      if (b) b.landed = true;

      // Impact audio/FX cue, scaled by how hard the hit was.
      const speed = pair.collision
        ? Math.hypot(
            (pair.bodyA.velocity.x - pair.bodyB.velocity.x),
            (pair.bodyA.velocity.y - pair.bodyB.velocity.y))
        : 0;
      if (speed > 1.2) {
        const p = pair.collision?.supports?.[0] ?? pair.bodyA.position;
        this.onImpact({ x: p.x, y: p.y, speed, tier: (a ?? b)?.tier ?? 0 });
      }

      if (!a || !b) continue;
      if (a.tier !== b.tier) continue;
      if (a.tier >= FRUITS.length - 1) continue; // watermelons are terminal
      if (a.merging || b.merging) continue;
      this._pending.push([a, b]);
    }
  }

  /** Advance the simulation one fixed step and resolve merges. */
  step(dt) {
    for (const rec of this.fruits.values()) {
      rec.px = rec.body.position.x;
      rec.py = rec.body.position.y;
      rec.pa = rec.body.angle;
    }
    Engine.update(this.engine, dt);
    this._resolveMerges();
  }

  _resolveMerges() {
    if (this._pending.length === 0) return;
    const consumed = new Set();
    const pending = this._pending;
    this._pending = [];

    for (const [a, b] of pending) {
      if (consumed.has(a.uid) || consumed.has(b.uid)) continue;
      if (!this.fruits.has(a.uid) || !this.fruits.has(b.uid)) continue;
      consumed.add(a.uid);
      consumed.add(b.uid);

      const nextTier = a.tier + 1;
      const ax = a.body.position.x, ay = a.body.position.y;
      const bx = b.body.position.x, by = b.body.position.y;
      // Merge at the midpoint, biased toward the slower fruit so towers do not
      // visibly lurch sideways when a dropped fruit lands on a resting one.
      const wa = 1 / (1 + Math.hypot(a.body.velocity.x, a.body.velocity.y));
      const wb = 1 / (1 + Math.hypot(b.body.velocity.x, b.body.velocity.y));
      const mx = (ax * wa + bx * wb) / (wa + wb);
      const my = (ay * wa + by * wb) / (wa + wb);

      const vx = (a.body.velocity.x + b.body.velocity.x) * 0.5;
      const vy = (a.body.velocity.y + b.body.velocity.y) * 0.5 - PHYSICS.mergePop;

      this.remove(a);
      this.remove(b);

      const merged = this.spawn(nextTier, mx, my, { vx, vy });
      merged.landed = true;
      this.onMerge({ tier: nextTier, x: mx, y: my, rec: merged, from: [a, b] });
    }
  }

  remove(rec) {
    if (!this.fruits.has(rec.uid)) return;
    rec.merging = true;
    this.fruits.delete(rec.uid);
    Composite.remove(this.world, rec.body);
  }

  /** Highest fruit that has settled — drives the danger line. */
  overflowingSince(nowMs) {
    let worst = null;
    for (const rec of this.fruits.values()) {
      if (!rec.landed) continue;
      const speed = Math.hypot(rec.body.velocity.x, rec.body.velocity.y) * 60;
      if (speed > PHYSICS.sleepSpeed) continue;
      const top = rec.body.position.y - rec.radius;
      if (top < BOARD.dangerY) {
        if (rec._dangerSince == null) rec._dangerSince = nowMs;
        const held = nowMs - rec._dangerSince;
        if (!worst || held > worst.held) worst = { rec, held };
      } else {
        rec._dangerSince = null;
      }
    }
    return worst;
  }

  clear() {
    for (const rec of [...this.fruits.values()]) this.remove(rec);
    this._pending.length = 0;
  }

  get count() { return this.fruits.size; }
}
