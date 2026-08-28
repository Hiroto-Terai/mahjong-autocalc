/**
 * The one key the whole game is in.
 *
 * Everything pitched — merges, the danger bed, the fanfare, the game-over
 * cadence, the ambient pad — is quantised to A natural minor, and most of it
 * to the pentatonic subset (A C D E G). Pentatonic has no semitone pairs, so
 * two merges landing in the same 200ms can never beat against each other,
 * which is the single cheapest way to stop a pile of SFX sounding accidental.
 */

/** A2. Chosen as the floor because the watermelon sits on it and 110Hz still
 *  reproduces on a laptop speaker; an octave lower would just be rumble. */
export const ROOT_HZ = 110;

/** Semitone offsets of A-minor-pentatonic from the root. */
const PENTA = [0, 3, 5, 7, 10];
/** Full A natural minor, for the pad voicings and the cadence. */
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];

const hz = (semis) => ROOT_HZ * Math.pow(2, semis / 12);

/** Pentatonic degree index -> Hz. Degree 0 is A2; degree 5 is A3. */
export function degreeHz(degree) {
  const oct = Math.floor(degree / 5);
  return hz(PENTA[((degree % 5) + 5) % 5] + oct * 12);
}

/** Diatonic step index -> Hz, for lines that need the 2nd and 6th. */
export function stepHz(step) {
  const oct = Math.floor(step / 7);
  return hz(AEOLIAN[((step % 7) + 7) % 7] + oct * 12);
}

/** Absolute semitone offset from A2 -> Hz, for chord tables. */
export const semiHz = hz;

/**
 * Fruit tier -> pentatonic degree. Tier 10 lands on degree 0 (A2, deep and
 * resonant) and tier 0 on degree 20 (A6, light), two pentatonic degrees per
 * tier. Four octaves of travel is what makes the chain audibly a *ladder*
 * rather than eleven variations on a beep.
 */
export function tierDegree(tier) {
  return (10 - tier) * 2;
}

/**
 * How far a combo lifts the chime. Three degrees per link out-runs the two
 * degrees a rising tier costs, so a real chain always steps *up* the scale
 * even though its fruit are getting bigger.
 */
export const COMBO_LIFT = 3;
/** Degree 22 is E7. Above that a chime stops reading as musical and starts
 *  reading as a smoke alarm. */
export const MAX_DEGREE = 22;

/**
 * Where a merge lands, and how many octaves the run has already folded.
 *
 * A chain that keeps raising the tier climbs on its own (+3 lift beats the -2
 * a bigger fruit costs). A chain of *same*-tier pairs would run off the top of
 * the keyboard, so past E7 the run folds down an octave and keeps climbing —
 * octave displacement, which the ear hears as the line continuing. Each fold
 * is also returned so the voice can get wider rather than just repeating.
 */
export function mergeVoicing(tier, combo = 1) {
  let degree = tierDegree(tier) + Math.max(0, (combo | 0) - 1) * COMBO_LIFT;
  let folds = 0;
  while (degree > MAX_DEGREE) { degree -= 5; folds++; }
  return { degree, folds };
}

/**
 * i - VI - III - VII in A minor: the progression that loops forever without
 * ever demanding a resolution, which is exactly what a bed under gameplay
 * needs. Semitones are relative to A2; `bass` is the root an octave down.
 */
export const PROGRESSION = [
  { name: 'Am', bass: -12, triad: [0, 3, 7], colour: 10 },
  { name: 'F',  bass: -16, triad: [-4, 0, 3], colour: 7 },
  { name: 'C',  bass: -9,  triad: [3, 7, 10], colour: 14 },
  { name: 'G',  bass: -14, triad: [-2, 2, 5], colour: 12 },
];

/** Descending i cadence for game over: E4 D4 C4 A3, settling on a low Am. */
export const CADENCE = [19, 17, 15, 12];
export const CADENCE_CHORD = [0, 12, 15, 19];

/** Ascending Am arpeggio (pentatonic degrees) then a wide Am voicing in
 *  semitones, for the watermelon fanfare. */
export const FANFARE_RUN = [5, 6, 8, 10, 11, 13];
export const FANFARE_CHORD = [0, 12, 15, 19, 24];
