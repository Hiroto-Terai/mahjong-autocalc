// 画像 → 牌の並び、までを通す。Python 版 vision/pipeline.py の移植。

import { tileName, tileToStr } from "../engine/tiles.js";
import { detectTiles } from "./detect.js";
import { extract } from "./features.js";
import { classify } from "./heuristic.js";

// ライブラリの照合スコアがこの値を超えたら、規則ベースの推定より優先する。
export const LIBRARY_TRUST_THRESHOLD = 0.86;
export const LOW_CONFIDENCE = 0.55;

/** 1 枚ぶんの判定。ライブラリを優先し、駄目なら規則ベースに落とす。 */
export function classifyOne(features, library) {
  const libraryMatch = library ? library.match(features) : null;
  const rules = classify(features);

  if (libraryMatch && libraryMatch.score >= LIBRARY_TRUST_THRESHOLD) {
    // 一致度が高くても 2 位と僅差なら確信度を下げる。
    const confidence = Math.min(
      0.99,
      libraryMatch.score * (0.75 + Math.min(libraryMatch.margin, 0.2))
    );
    return {
      tile: libraryMatch.tile,
      confidence,
      source: "library",
      alternatives: [[libraryMatch.tile, libraryMatch.score], ...rules.slice(0, 3)],
    };
  }

  if (rules.length) {
    return { tile: rules[0][0], confidence: rules[0][1], source: "heuristic", alternatives: rules.slice(0, 4) };
  }

  if (libraryMatch) {
    return {
      tile: libraryMatch.tile,
      confidence: libraryMatch.score * 0.5,
      source: "library",
      alternatives: [[libraryMatch.tile, libraryMatch.score]],
    };
  }

  return { tile: null, confidence: 0, source: "unknown", alternatives: [] };
}

/**
 * 写真から牌を認識する。
 * @param {object} image RGB 画像
 * @param {TileLibrary|null} library
 */
export function recognize(image, library = null) {
  const detected = detectTiles(image);

  const guesses = detected.map((tile) => {
    const features = extract(tile.image);
    const { tile: id, confidence, source, alternatives } = classifyOne(features, library);
    return {
      index: tile.order,
      tile: id,
      name: id === null ? null : tileName(id),
      code: id === null ? null : tileToStr(id),
      confidence,
      source,
      group: tile.group,
      uncertain: id === null || confidence < LOW_CONFIDENCE,
      alternatives: alternatives.map(([t, s]) => ({ tile: t, name: tileName(t), score: s })),
      face: tile.image,
      quad: tile.quad,
      features,
    };
  });

  return {
    guesses,
    count: guesses.length,
    uncertainCount: guesses.filter((g) => g.uncertain).length,
    librarySize: library ? library.size : 0,
  };
}

/**
 * 認識結果の手直しをライブラリに反映する。
 * @param {object[]} guesses recognize() の結果 (features を持っているもの)
 * @param {Map<number,number>|object} assignments 検出インデックス → 正しい牌 ID
 * @returns {number} 実際に登録した枚数
 */
export function learnFromCorrections(guesses, assignments, library) {
  const lookup = assignments instanceof Map ? assignments : new Map(
    Object.entries(assignments).map(([k, v]) => [Number(k), v])
  );

  let learned = 0;
  for (const guess of guesses) {
    const tile = lookup.get(guess.index);
    if (tile === undefined || tile === null) continue;
    if (library.add(tile, guess.features)) learned += 1;
  }
  return learned;
}
