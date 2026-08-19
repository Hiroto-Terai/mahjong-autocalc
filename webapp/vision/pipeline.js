// 画像 → 牌の並び、までを通す。Python 版 vision/pipeline.py の移植。

import { tileName, tileToStr } from "../engine/tiles.js";
import { MAX_DIMENSION, cropRow, detectTiles } from "./detect.js";
import { extract } from "./features.js";
import { classify } from "./heuristic.js";
import { resize } from "./cv.js";

// 照合スコアがこの値を超えたら採用する。順に「自分で登録した牌 → 同梱の初期
// ライブラリ → 規則ベース」と落とす。
//
// しきい値を下げて弱い一致まで拾うと、規則ベースなら当たっていた牌を潰して
// しまい、かえって正解率が下がる (実測で 100% → 93%)。低い一致度は採用せず、
// 次の段に譲る。
export const LIBRARY_TRUST_THRESHOLD = 0.86;
export const PRIOR_TRUST_THRESHOLD = 0.80;
export const LOW_CONFIDENCE = 0.55;

/**
 * 1 枚ぶんの判定。
 *
 * 優先順位は「自分で登録した牌 → 同梱の初期ライブラリ → 規則ベース」。
 * 手元のセットを登録してあれば一番強いが、無くても初期ライブラリで大半は読める。
 */
export function classifyOne(features, library, prior = null) {
  const own = library ? library.match(features) : null;
  const base = prior ? prior.match(features) : null;
  const rules = classify(features);

  const accept = (match, source) => ({
    tile: match.tile,
    // 一致度が高くても 2 位と僅差なら確信度を下げる。
    confidence: Math.min(0.99, match.score * (0.75 + Math.min(match.margin, 0.2))),
    source,
    alternatives: [[match.tile, match.score], ...rules.slice(0, 3)],
  });

  if (own && own.score >= LIBRARY_TRUST_THRESHOLD) return accept(own, "library");
  if (base && base.score >= PRIOR_TRUST_THRESHOLD) return accept(base, "prior");

  if (rules.length) {
    return { tile: rules[0][0], confidence: rules[0][1], source: "heuristic", alternatives: rules.slice(0, 4) };
  }

  const fallback = own || base;
  if (fallback) {
    return {
      tile: fallback.tile,
      confidence: fallback.score * 0.5,
      source: own ? "library" : "prior",
      alternatives: [[fallback.tile, fallback.score]],
    };
  }

  return { tile: null, confidence: 0, source: "unknown", alternatives: [] };
}

function describe(detected, library, prior) {
  return detected.map((tile) => {
    const features = extract(tile.image);
    const { tile: id, confidence, source, alternatives } = classifyOne(features, library, prior);
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
}

function summarize(guesses, library) {
  return {
    guesses,
    count: guesses.length,
    uncertainCount: guesses.filter((g) => g.uncertain).length,
    librarySize: library ? library.size : 0,
  };
}

/**
 * 写真から牌を認識する。
 * @param {object} image RGB 画像
 * @param {TileLibrary|null} library
 */
export function recognize(image, library = null, prior = null) {
  return summarize(describe(detectTiles(image), library, prior), library);
}

/**
 * 利用者が指定した範囲だけを読む。
 *
 * 自動検出は背景や照明の影響を受けるが、こちらは範囲と枚数が与えられるので
 * そこは外さない。切り出しと判別は自動検出と同じものを通す。
 *
 * @param {object} image RGB 画像 (recognize に渡すのと同じもの)
 * @param {{quad:number[][], count:number}[]} regions 画像座標での範囲と枚数
 */
export function recognizeRegions(image, regions, library = null, prior = null) {
  // 自動検出と同じ土俵に乗せるため、同じ縮小をかけてから切り出す。
  let work = image;
  let scale = 1;
  const longest = Math.max(image.width, image.height);
  if (longest > MAX_DIMENSION) {
    scale = MAX_DIMENSION / longest;
    work = resize(image, Math.round(image.width * scale), Math.round(image.height * scale));
  }
  const invScale = 1 / scale;

  const detected = [];
  regions.forEach((region, group) => {
    const quad = region.quad.map(([x, y]) => [x * scale, y * scale]);
    const count = Math.max(1, Math.min(18, Math.round(region.count)));
    for (const tile of cropRow(work, quad, count, group, detected.length)) {
      detected.push({ ...tile, quad: tile.quad.map(([x, y]) => [x * invScale, y * invScale]) });
    }
  });

  return summarize(describe(detected, library, prior), library);
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
