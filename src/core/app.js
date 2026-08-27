import { Application, Container, Rectangle } from 'pixi.js';
import { VIRTUAL_W, VIRTUAL_H, LAYERS } from '../config.js';

/**
 * Boots Pixi at the virtual resolution and integer-scales it to the viewport.
 *
 * Integer scaling is non-negotiable for pixel art: at 2.37x every texel is a
 * different size and the whole image crawls. We pick the largest whole number
 * that fits, letterbox the remainder, and centre it.
 */
export async function createApp(mount) {
  const app = new Application();
  await app.init({
    width: VIRTUAL_W,
    height: VIRTUAL_H,
    antialias: false,
    roundPixels: true,
    autoDensity: false,
    resolution: 1,
    backgroundColor: 0x0b0e16,
    powerPreference: 'high-performance',
  });

  const canvas = app.canvas;
  mount.appendChild(canvas);

  const root = new Container();
  root.eventMode = 'static';
  root.hitArea = new Rectangle(0, 0, VIRTUAL_W, VIRTUAL_H);
  app.stage.addChild(root);

  /** Named layers, back to front. Modules attach to `layers.fx` etc. */
  const layers = {};
  for (const name of LAYERS) {
    const c = new Container();
    c.label = name;
    layers[name] = c;
    root.addChild(c);
  }

  let scale = 1;
  const resize = () => {
    const vw = mount.clientWidth || window.innerWidth;
    const vh = mount.clientHeight || window.innerHeight;
    // Largest integer scale that still fits, but never below 1.
    scale = Math.max(1, Math.floor(Math.min(vw / VIRTUAL_W, vh / VIRTUAL_H)));
    const w = VIRTUAL_W * scale;
    const h = VIRTUAL_H * scale;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.marginTop = `${Math.max(0, (vh - h) / 2)}px`;
  };
  resize();
  window.addEventListener('resize', resize);

  return {
    app,
    root,
    layers,
    /** Viewport px -> virtual px. Input modules must route through this. */
    toVirtual(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left) / (r.width / VIRTUAL_W),
        y: (clientY - r.top) / (r.height / VIRTUAL_H),
      };
    },
    get scale() { return scale; },
  };
}
