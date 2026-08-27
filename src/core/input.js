import { DROP, BOARD } from '../config.js';

/**
 * Unified pointer + keyboard input.
 *
 * Exposes an aim position clamped to the jar and a `pressed` edge signal;
 * the game layer decides what a press means. Keyboard aim integrates at a
 * fixed speed so it feels the same at any frame rate.
 */
export class Input {
  constructor(view, mount) {
    this.view = view;
    this.aimX = (BOARD.left + BOARD.right) / 2;
    this.dropQueued = false;
    this.restartQueued = false;
    this.pointerActive = false;
    this._keys = new Set();
    this._bind(mount);
  }

  _bind(mount) {
    const el = mount;
    const move = (e) => {
      const p = this.view.toVirtual(e.clientX, e.clientY);
      this.aimX = p.x;
      this.pointerActive = true;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', (e) => { move(e); this._down = true; });
    el.addEventListener('pointerup', () => {
      if (this._down) this.dropQueued = true;
      this._down = false;
    });
    el.addEventListener('pointercancel', () => { this._down = false; });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      if (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'Enter') {
        this.dropQueued = true;
        e.preventDefault();
      }
      if (e.code === 'KeyR') this.restartQueued = true;
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
  }

  /** Advance keyboard aim. Called once per fixed step with dt in ms. */
  update(dt) {
    let dir = 0;
    if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) dir -= 1;
    if (this._keys.has('ArrowRight') || this._keys.has('KeyD')) dir += 1;
    if (dir !== 0) {
      this.aimX += dir * DROP.keyboardSpeed * (dt / 1000);
      this.pointerActive = false;
    }
  }

  /** Consume the queued drop, if any. */
  takeDrop() {
    const d = this.dropQueued;
    this.dropQueued = false;
    return d;
  }

  takeRestart() {
    const r = this.restartQueued;
    this.restartQueued = false;
    return r;
  }
}
