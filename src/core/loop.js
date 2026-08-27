/**
 * Fixed-timestep accumulator loop.
 *
 * Physics advances in exact PHYSICS.timeStep increments so the simulation is
 * frame-rate independent and deterministic; rendering is handed the leftover
 * fraction (`alpha`) so it can interpolate and stay smooth on any display.
 */
export class Loop {
  constructor({ step, maxSubSteps = 4, update, render }) {
    this.step = step;
    this.maxSubSteps = maxSubSteps;
    this.update = update;
    this.render = render;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.elapsed = 0;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    // Clamp: a backgrounded tab must not fire a thousand catch-up steps.
    const frame = Math.min(now - this.last, this.step * this.maxSubSteps);
    this.last = now;
    this.acc += frame;

    let steps = 0;
    while (this.acc >= this.step && steps < this.maxSubSteps) {
      this.update(this.step);
      this.elapsed += this.step;
      this.acc -= this.step;
      steps++;
    }
    this.render(this.acc / this.step, frame);
  }
}
