import { PhysicsWorld } from '../physics/world.js';
import { makeRng } from '../core/rng.js';
import {
  FRUITS, SPAWNABLE_TIERS, BOARD, BOARD_W, DROP, DANGER_GRACE, COMBO,
  DEFAULT_SEED, PHYSICS,
} from '../config.js';

export const STATE = { TITLE: 'title', PLAYING: 'playing', OVER: 'over' };

/** Ignore input this long after a run ends, so the fatal press does not
 *  also skip the score screen. */
const RESTART_LOCKOUT = 700;

/**
 * Rules, scoring and the run lifecycle. Owns physics; knows nothing about
 * rendering — it emits events that art/fx/ui/audio subscribe to, so the
 * simulation stays testable headlessly.
 */
export class Game {
  constructor({ seed = DEFAULT_SEED, events } = {}) {
    this.events = events;
    this.seed = seed;
    this.physics = new PhysicsWorld({
      onMerge: (m) => this._onMerge(m),
      onImpact: (i) => this.events.emit('impact', i),
    });
    this.reset(seed);
  }

  /** Full teardown to the attract screen. */
  reset(seed = this.seed, { toTitle = false } = {}) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.physics.clear();
    this.score = 0;
    this.best = Number(localStorage.getItem('fc.best') || 0);
    this.time = 0;
    this.dropCooldown = 0;
    this.comboCount = 0;
    this.comboUntil = 0;
    this.discovered = new Set();
    this.dangerHeld = 0;
    this.state = toTitle ? STATE.TITLE : STATE.PLAYING;
    this.current = this._rollTier();
    this.next = this._rollTier();
    this.aimX = (BOARD.left + BOARD.right) / 2;
    if (toTitle) this._seedAttractPile();
    this.events.emit('reset', this);
  }

  _rollTier() {
    // Weighted toward small fruit, exactly like the original's feel: you get a
    // cherry far more often than a dekopon, which is what makes the board
    // solvable rather than an avalanche of mid-tier junk.
    const weights = [30, 26, 20, 14, 10].slice(0, SPAWNABLE_TIERS);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return 0;
  }

  /** Clamp the claw so the fruit can never overlap a wall on release. */
  clampAim(x, tier) {
    const r = FRUITS[tier].radius;
    return Math.max(BOARD.left + r + 1, Math.min(BOARD.right - r - 1, x));
  }

  update(dt, input) {
    this.time += dt;

    if (this.state === STATE.TITLE) {
      // Any press begins the run. Physics still ticks so the attract screen
      // can show fruit settling behind the title.
      input.update(dt);
      this.physics.step(dt);
      if (input.takeDrop() || input.takeRestart()) this.start();
      return;
    }

    if (this.state === STATE.OVER) {
      // Keep simulating so the pile visibly settles under the panel, but hold
      // the restart for a beat — an instant restart on the same press that
      // ended the run is the classic way to lose a player's score screen.
      this.physics.step(dt);
      this.overAge = (this.overAge || 0) + dt;
      if (this.overAge > RESTART_LOCKOUT && (input.takeDrop() || input.takeRestart())) {
        this.reset(this.seed + 1);
      }
      return;
    }

    if (this.state !== STATE.PLAYING) return;

    input.update(dt);
    this.aimX = this.clampAim(input.aimX, this.current);
    this.dropCooldown = Math.max(0, this.dropCooldown - dt);

    if (input.takeDrop() && this.dropCooldown === 0) this.drop();
    if (input.takeRestart()) this.reset(this.seed + 1);


    this.physics.step(dt);

    if (this.time > this.comboUntil) this.comboCount = 0;

    this._checkOverflow(dt);
  }

  /**
   * Decorative fruit behind the title panel. An empty jar on the attract
   * screen sells nothing; a settled pile shows the player what the game is
   * before they have pressed anything.
   */
  _seedAttractPile() {
    const tiers = [8, 5, 6, 3, 4, 2, 5, 1, 3, 0, 2, 4];
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      const x = BOARD.left + FRUITS[t].radius + 6
        + this.rng() * (BOARD_W - FRUITS[t].radius * 2 - 12);
      this.physics.spawn(t, x, BOARD.floor - 40 - i * 26);
    }
    // Settle them before the first frame so the title never opens on fruit
    // visibly raining into place.
    for (let i = 0; i < 900; i++) this.physics.step(PHYSICS.timeStep);
    for (const rec of this.physics.fruits.values()) rec.bornAt = -1e6;
  }

  /** Leave the attract screen and begin a run. */
  start() {
    this.physics.clear();
    this.state = STATE.PLAYING;
    this.time = 0;
    this.dropCooldown = DROP.cooldown;
    this.events.emit('start', this);
  }

  drop() {
    const tier = this.current;
    const x = this.clampAim(this.aimX, tier);
    const rec = this.physics.spawn(tier, x, DROP.y);
    // Tiers that come out of the claw count as seen; otherwise the evolution
    // chart hides fruit the player has been handling all game.
    this.discovered.add(tier);
    this.dropCooldown = DROP.cooldown;
    this.current = this.next;
    this.next = this._rollTier();
    this.events.emit('drop', { tier, x, y: DROP.y, rec });
    return rec;
  }

  _onMerge({ tier, x, y, rec, from }) {
    const inCombo = this.time <= this.comboUntil;
    this.comboCount = inCombo ? this.comboCount + 1 : 1;
    this.comboUntil = this.time + COMBO.windowMs;

    const mult = COMBO.multipliers[Math.min(this.comboCount - 1, COMBO.multipliers.length - 1)];
    const gained = Math.round(FRUITS[tier].score * mult);
    this.score += gained;
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem('fc.best', String(this.best));
    }

    const isNew = !this.discovered.has(tier);
    this.discovered.add(tier);

    this.events.emit('merge', {
      tier, x, y, rec, from, gained, combo: this.comboCount, mult, isNew,
    });
    if (tier === FRUITS.length - 1) this.events.emit('watermelon', { x, y });
  }

  _checkOverflow(dt) {
    const worst = this.physics.overflowingSince(this.time);
    if (worst) {
      this.dangerHeld = worst.held;
      this.events.emit('danger', { held: worst.held, ratio: Math.min(1, worst.held / DANGER_GRACE) });
      if (worst.held >= DANGER_GRACE) this.gameOver();
    } else if (this.dangerHeld !== 0) {
      this.dangerHeld = 0;
      this.events.emit('danger', { held: 0, ratio: 0 });
    }
  }

  gameOver() {
    if (this.state === STATE.OVER) return;
    this.state = STATE.OVER;
    this.overAge = 0;
    this.events.emit('gameover', { score: this.score, best: this.best });
  }
}
