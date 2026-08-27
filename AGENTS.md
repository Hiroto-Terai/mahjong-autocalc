# Working agreement

## Architecture

```
src/config.js        shared contract: virtual resolution, board geometry,
                     fruit chain, physics tuning. READ-ONLY unless you own it.
src/core/            app bootstrap, fixed-step loop, input, RNG, event bus
src/art/             pixel-art generation + texture baking
src/physics/         Matter.js world, merge resolution
src/game/            rules, scoring, lifecycle, sprite sync
src/fx/              particles, shake, juice
src/ui/              background/jar chrome, HUD, fonts, panels
src/audio/           procedural SFX
tools/               deterministic screenshot harness
```

Subsystems talk over `Events` (`src/core/events.js`). Emitted events:
`reset`, `drop`, `merge`, `impact`, `danger`, `gameover`, `watermelon`.
Add new events rather than reaching across module boundaries.

## Determinism

The game is seeded (`?seed=`) and the physics runs on a fixed timestep, so a
seed plus a drop script always produces the identical frame. Do not introduce
`Math.random()` into simulation code — use `game.rng`. Presentation-only
randomness (particle jitter) is fine.

## Screenshot harness

```
SHOT_PORT=<port> SHOT_DIR=shots-<name> node tools/shoot.mjs [scenario...]
```

Scenarios live in `tools/scenarios.mjs`. Captures land at 1x (texel
inspection) and 2x (player's view). Read the PNGs — do not assume.

## House style

Match the surrounding code. Comments explain *why a value was chosen* or a
non-obvious technique, never what the line does. No dead code, no leftover
scratch, no unused imports.
