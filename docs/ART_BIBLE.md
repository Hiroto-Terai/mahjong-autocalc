# Art bible — Fruit Cascade

Everything in this game is authored at **320×480 virtual pixels** and
integer-scaled to the viewport. 1 unit == 1 texel. This is the constitution;
every visual decision answers to it.

## Non-negotiables

1. **No fractional scaling, ever.** Sprites sit at whole-pixel positions. If a
   sprite lands on x=104.5 it will shimmer, and the whole illusion dies.
2. **No GPU rotation of pixel art.** Rotations are pre-baked into frames
   (`ROT_FRAMES`) and selected, never interpolated.
3. **No bilinear filtering.** Every texture is `scaleMode: 'nearest'`.
4. **Dithering is a tool, not a texture.** Ordered dithering belongs *at the
   boundary between two ramp stops*, in a band a few texels wide. Dithering
   the entire surface is what makes art read as "downsampled 3D render"
   instead of pixel art. This is currently the single worst flaw in the
   baseline — the fruits look like sandpaper.
5. **Detail must scale with sprite size.** An 8px-radius cherry has room for
   roughly three shades and one highlight texel. A 50px watermelon can carry a
   full 5-stop ramp, stripes and a rind. Using the same shader parameters for
   both is why the small fruit currently look like mud. Author detail per size
   bracket.
6. **Every sprite needs a readable silhouette and a 1px outline** in a colour
   darker and more saturated than the fruit's shadow stop — never pure black,
   which flattens everything.

## Palette discipline

- 5 stops per fruit, shadow → light, with a hue shift through the midtones
  (shadows cool, highlights warm) so the ramp is alive rather than grey.
- The whole game shares one master palette mood: deep indigo background,
  saturated fruit, warm UI. Fruits must be distinguishable **by hue alone at
  8px**, because that is how the player reads the board at a glance.
- Adjacent tiers must never be confusable. Cherry/strawberry and
  melon/watermelon are the two danger pairs — they need clearly different hue
  and clearly different decoration.

## Fruit identity

A sphere with a gradient is not a fruit. Each tier needs at least one
unmistakable identifying feature, readable at its own size:

| tier | fruit | must-have identity |
|---|---|---|
| 0 | cherry | stem, deep crimson, tiny |
| 1 | strawberry | seed speckles, lighter red, green calyx |
| 2 | grape | cluster lobes, purple |
| 3 | dekopon | citrus pores, bump on top |
| 4 | persimmon | green calyx star on top, deep orange |
| 5 | apple | stem + leaf, vertical streaking |
| 6 | pear | yellow-green, speckles, tapered top |
| 7 | peach | cleft, pink→yellow gradient |
| 8 | pineapple | diamond crosshatch, green crown |
| 9 | melon | pale green, raised netting |
| 10 | watermelon | dark curved stripes over green, big |

## Judging your own work

Run the harness and *look at the PNGs*:

```
SHOT_PORT=<your port> SHOT_DIR=shots-<yourname> node tools/shoot.mjs
```

Grade against: does it read at 1x? Is the silhouette clean? Can you name the
fruit without the label? Does the palette sit in one world? Would a player
mistake tier N for tier N+1?
