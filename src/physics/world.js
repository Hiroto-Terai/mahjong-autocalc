import Matter from 'matter-js';
import { BOARD, PHYSICS, FRUITS } from '../config.js';

const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;

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
      enableSleeping: true,
    });
    this.world = this.engine.world;
    this.onMerge = onMerge || (() => {});
    this.onImpact = onImpact || (() => {});

    /** id -> fruit body record */
    this.fruits = new Map();
    this._pending = [];
    this._nextId = 1;
    this._steps = 0;

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
      density: PHYSICS.density * (def.radius / PHYSICS.densityRefRadius) ** PHYSICS.densityExponent,
      slop: PHYSICS.slop,
      sleepThreshold: PHYSICS.sleepThreshold,
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
    this._clampSpeeds();
    this._auditSleepers();
    this._resolveMerges();
  }

  /**
   * Wake any fruit that fell asleep while still sunk into something.
   *
   * Matter's position correction is velocity-neutral by design, so a body
   * being pushed out of an overlap registers as motionless and qualifies for
   * sleep — and a sleeping body is skipped by the solver, which freezes the
   * penetration permanently. It shows up exactly where it is most visible:
   * a freshly merged fruit buried a couple of pixels into its neighbours for
   * the rest of the run. Waking them lets the solver finish the job, after
   * which they settle again on their own.
   */
  _auditSleepers() {
    if (this._steps++ % PHYSICS.sleepAuditEvery) return;
    const list = [...this.fruits.values()];
    for (const rec of list) {
      if (!rec.body.isSleeping) continue;
      const p = rec.body.position;
      let deepest = Math.max(
        p.y + rec.radius - BOARD.floor,
        BOARD.left - (p.x - rec.radius),
        (p.x + rec.radius) - BOARD.right);
      for (const other of list) {
        if (other === rec) continue;
        const q = other.body.position;
        const over = rec.radius + other.radius - Math.hypot(p.x - q.x, p.y - q.y);
        if (over > deepest) deepest = over;
      }
      if (deepest > PHYSICS.sleepOverlap) {
        Sleeping.set(rec.body, false);
        rec.body.sleepCounter = 0;
      }
    }
  }

  /**
   * Speed ceiling, applied after the solver.
   *
   * Two failure modes share one cure. A fruit released into an already-full
   * jar is born overlapping its neighbours, and the position solver answers
   * that with an impulse large enough to fire it out of the world; and any
   * body moving further than its own radius in a step can step clean through
   * a wall, because Matter's narrowphase is discrete. Capping speed per body
   * — generously, well above a natural fall — removes both without being
   * felt during normal play.
   */
  _clampSpeeds() {
    for (const rec of this.fruits.values()) {
      const body = rec.body;
      if (body.isSleeping) continue;
      const v = body.velocity;
      const speed = Math.hypot(v.x, v.y);
      const cap = Math.min(PHYSICS.maxSpeed, rec.radius * PHYSICS.maxSpeedPerRadius);
      if (speed > cap) {
        const k = cap / speed;
        Body.setVelocity(body, { x: v.x * k, y: v.y * k });
      }
      const spin = Math.abs(body.angularVelocity) > PHYSICS.maxSpin
        ? Math.sign(body.angularVelocity) * PHYSICS.maxSpin
        : body.angularVelocity * (1 - PHYSICS.angularDamping);
      Body.setAngularVelocity(body, spin);
    }
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

      const radius = FRUITS[nextTier].radius;
      // Keep the birthplace inside the jar: a merge against the floor or a
      // wall would otherwise create a body half-buried in a static, and the
      // solver's answer to that is to fire it across the board.
      const cx = Math.min(BOARD.right - radius, Math.max(BOARD.left + radius, mx));
      const cy = Math.min(BOARD.floor - radius, my);

      this.remove(a);
      this.remove(b);

      const confinement = this._makeRoom(cx, cy, radius);

      // A merge deep in a packed pile has nowhere to pop to, and popping
      // anyway is what launches stacks. Fade the kick out as the fruit gets
      // boxed in, and share it out by mass so big fruit stay ponderous.
      const room = Math.max(0, 1 - confinement / PHYSICS.mergeConfineSpan);
      const massScale = FRUITS[4].radius / radius;
      const vx = (a.body.velocity.x + b.body.velocity.x) * 0.5;
      const vy = (a.body.velocity.y + b.body.velocity.y) * 0.5
        - PHYSICS.mergePop * room * massScale;

      const merged = this.spawn(nextTier, cx, cy, { vx, vy });
      merged.landed = true;
      this.wakeAround(cx, cy, radius * 2.5);
      this.onMerge({ tier: nextTier, x: cx, y: cy, rec: merged, from: [a, b] });
    }
  }

  remove(rec) {
    if (!this.fruits.has(rec.uid)) return;
    rec.merging = true;
    this.fruits.delete(rec.uid);
    Composite.remove(this.world, rec.body);
    // Matter only wakes bodies that are *hit*. Deleting one out from under a
    // sleeping stack would leave the stack hanging in mid-air, so the hole has
    // to wake its own neighbours.
    this.wakeAround(rec.body.position.x, rec.body.position.y, rec.radius * 2.5);
  }

  /**
   * Shoulder the neighbours aside so a fruit of `radius` can be born at
   * (x, y), and report how boxed-in that spot was (summed overlap, px).
   *
   * Without this, a merged fruit materialises interpenetrating everything
   * around it and the position solver resolves several pixels of overlap in
   * one step — which reads on screen as the pile detonating. Displacing the
   * neighbours directly costs the same room but injects no energy:
   * `Body.setPosition` moves `positionPrev` with the body, so nothing gains
   * velocity from being pushed.
   */
  _makeRoom(x, y, radius) {
    let confinement = 0;
    for (const rec of this.fruits.values()) {
      const p = rec.body.position;
      let dx = p.x - x;
      let dy = p.y - y;
      let d = Math.hypot(dx, dy);
      const want = radius + rec.radius;
      if (d >= want) continue;
      confinement += want - d;
      if (rec.body.isStatic) continue;
      if (d < 1e-4) { dx = 0; dy = -1; d = 1; } // exactly concentric: push up
      const push = (want - d) * PHYSICS.mergeRoom;
      Body.setPosition(rec.body, {
        x: p.x + (dx / d) * push,
        y: p.y + (dy / d) * push,
      });
      Sleeping.set(rec.body, false);
    }
    return confinement;
  }

  /** Wake every fruit whose centre is within `radius` of (x, y). */
  wakeAround(x, y, radius) {
    const r2 = radius * radius;
    for (const rec of this.fruits.values()) {
      if (!rec.body.isSleeping) continue;
      const dx = rec.body.position.x - x;
      const dy = rec.body.position.y - y;
      if (dx * dx + dy * dy <= r2) Sleeping.set(rec.body, false);
    }
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
