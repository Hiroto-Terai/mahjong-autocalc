# Fruit Cascade

A pixel-art physics merge puzzle in the Suika lineage: drop fruit into a jar,
two of a kind merge into the next tier up, and the run ends when the pile
overflows the rim. Built with PixiJS and Matter.js.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

Controls: move the pointer (or ←/→) to aim, click or press Space to drop,
R to restart.

## How it is put together

Everything is authored at a **320×480 virtual resolution**, one unit per texel,
and integer-scaled to the viewport. That constraint drives most of the technical
decisions:

- **Rotation is pre-baked.** A rotating pixel sprite resampled by the GPU
  shimmers, so every fruit is baked at `ROT_FRAMES` discrete angles and the
  renderer picks the nearest frame instead of rotating anything.
- **Sprites sit on whole pixels.** Positions are rounded at draw time; screen
  shake uses integer offsets only.
- **All art is generated in code.** There are no binary assets — fruit sprites,
  the pixel font and the scene are rasterised at 1:1 into canvases at boot and
  uploaded with nearest filtering. Sound is synthesised in WebAudio.

The simulation runs on a **fixed 120 Hz timestep** with the renderer
interpolating between steps, and the RNG is seeded, so a seed plus a script of
drops always reproduces the identical frame. That is what makes the screenshot
harness a meaningful regression check rather than a novelty.

Merging is subtler than it looks: one fruit can contact two identical partners
in a single tick, so candidate pairs are collected during the step and resolved
afterwards against a spent-set, guaranteeing each body merges exactly once.

## Layout

```
src/config.js   shared contract — resolution, board geometry, fruit chain, tuning
src/core/       app bootstrap, fixed-step loop, input, seeded RNG, event bus
src/art/        pixel-art generation and texture baking
src/physics/    Matter.js world and merge resolution
src/game/       rules, scoring, lifecycle, sprite sync
src/fx/         particles, shake, juice
src/ui/         background and jar, HUD, bitmap font, panels
src/audio/      procedural synthesis
tools/          deterministic screenshot and measurement harnesses
```

Subsystems communicate over an event bus (`reset`, `start`, `drop`, `merge`,
`impact`, `danger`, `gameover`, `watermelon`) and self-wire from a shared
context, so `main.js` stays pure wiring.

## Harnesses

```bash
node tools/shoot.mjs [scenario...]   # deterministic screenshots -> shots/
node tools/physics-probe.mjs         # residual motion, penetration, determinism
node tools/audio-probe.mjs           # offline render: peak, RMS, decay, clipping
```

Scenarios live in `tools/scenarios.mjs`. Captures are written at 1× (texel-level
inspection) and 2× (a player's view). See `docs/ART_BIBLE.md` for the visual
constitution and `docs/CRITIQUE_RUBRIC.md` for how work is reviewed.
