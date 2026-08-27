# Visual critique rubric

The critic's job is to find reasons to reject, not reasons to approve. A build
that "looks fine" has not been examined. Every pass must produce specific,
located, actionable faults — "the melon's netting reads as polka dots at 44px"
is a finding; "the art could be better" is not.

## Ground rules

- **Look at the actual PNGs.** Both `@1x` (texel truth — this is where filtering
  bugs, fractional positions and mushy detail are visible) and `@2x` (what a
  player sees).
- **Never grade from the code.** Reading the source tells you what was intended,
  not what shipped.
- **A fault you cannot locate is not a fault.** Name the scenario, the element,
  and what is wrong with it.

## Axes

### 1. Pixel-art authenticity
The single most common failure is art that is *technically* low-resolution but
*reads* as a downsampled 3D render. Tells:
- dithering spread evenly across a whole surface (sandpaper texture) instead of
  confined to narrow bands at ramp boundaries
- more than ~6 shades on a single object with no deliberate ramp
- soft, feathered edges where there should be a hard 1px transition
- smooth alpha gradients and glows
- detail density identical across sprite sizes

### 2. Silhouette and readability
- Can each fruit be identified with the colour removed?
- Is there a consistent 1px outline, and is it a colour that sits in the
  palette rather than pure black?
- At 8px radius, does the smallest fruit still read as a distinct object?

### 3. Palette
- Do all elements sit in one coherent world, or does each look authored
  separately?
- Are adjacent tiers distinguishable by hue alone at a glance? Cherry vs
  strawberry and melon vs watermelon are the danger pairs.
- Are shadows cool and highlights warm, or is the ramp a grey wash?

### 4. Composition and UI
- Is there a clear visual hierarchy, or are elements floating without framing?
- Any system font anywhere is an automatic fail.
- Is the jar a designed vessel with volume, or a rectangle?
- Does the background support the fruit or compete with it?

### 5. Juice and motion
- Does the merge frame read as an event, or as a few white squares?
- Is screen shake on integer offsets? Fractional shake breaks pixel alignment
  and is visible as a shimmer.

### 6. Technical correctness
- Any blurring at 1x means a filtering or fractional-position bug.
- Any sprite whose art centre does not match its physics centre.
- Console errors in the capture run.

## Verdict

End every pass with one of:
- **REJECT** — with a numbered list of located faults, ordered by how much each
  costs the overall impression.
- **ACCEPT** — only when a further pass would find nothing but taste
  differences. State explicitly what convinced you.

Grade inflation is the failure mode to guard against. If the previous pass
found ten faults and this one finds none, you have probably stopped looking.
