// 特徴量から牌を推定する規則ベースの分類器。Python 版 vision/heuristic.py の移植。
//
//   白      : 刻印がほとんど無い / 色の付いていない薄い枠
//   萬子    : 刻印が上下に割れ、下が赤い「萬」→ 上の漢数字をテンプレート照合
//   字牌    : 大きな一文字。緑=發 / 赤=中 / 黒=東南西北 (テンプレート照合)
//   筒子    : 丸い刻印が並ぶ (円形度が高い) → 個数が数字
//   索子    : 縦長で緑の刻印が並ぶ → 個数が数字 (一索は鳥)
//
// 書体も配色も牌のセットごとに違うので、これはあくまで初期推定。実運用の精度は
// library (ユーザー自身の牌を登録した参照データ) が担保する。

import {
  connectedComponents, createImage, dilate, distanceTransform,
  fillHoles, morphClose, structuringElement,
} from "./cv.js";
import { CHUN, HAKU, HATSU, HONOR, MAN, PIN, SOU } from "../engine/tiles.js";
import { match } from "./glyphs.js";

const WIND_KEYS = { z1: HONOR, z2: HONOR + 1, z3: HONOR + 2, z4: HONOR + 3 };
const MAN_KEYS = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`m${i + 1}`, MAN + i])
);

const BLANK_INK = 0.020;

/** テンプレート照合の結果を確信度に変換する。2 位との差を確信度に効かせる。 */
function glyphCandidates(mask, keys, floor, span) {
  const matches = match(mask, Object.keys(keys));
  if (!matches.length) return [];
  const [bestKey, best] = matches[0];
  const runnerUp = matches.length > 1 ? matches[1][1] : 0;
  const margin = Math.max(0, best - runnerUp);

  return matches.map(([key, score]) => {
    let confidence = floor + score * span;
    if (key === bestKey) confidence += Math.min(margin * 2, 0.25);
    return [keys[key], Math.min(confidence, 0.94)];
  });
}

/**
 * 刻印を「中身の詰まった塊」にする。
 * 筒子の丸は中央が下地色に抜けたドーナツ、索子の竹は中央に明るい帯が入る。
 * そのままだと 1 個の刻印が 2 つに割れて数を数えられないので、囲まれた穴を
 * 埋め、縦方向のクローズで竹の上下を繋いでおく。
 */
function solidify(mask) {
  return morphClose(fillHoles(mask), structuringElement(3, 9, "rect"), 1);
}

/**
 * 並んだ刻印の個数 (筒子・索子の数字) を数える。
 * 隣り合う丸や竹はくっついて 1 つの連結成分に見えることが多い。距離変換の
 * 極大点を数えれば、くっついていても元の個数を復元できる。
 */
function countMarks(features) {
  if (!features.blobs.length) return 0;

  const mask = solidify(features.ink);
  const distance = distanceTransform(mask);
  let peak = 0;
  for (const v of distance.data) if (v > peak) peak = v;
  if (peak <= 0) return features.blobs.length;

  // 局所最大 (膨張しても値が変わらない点) のうち、十分に太いものだけ残す。
  const scale = 255 / peak;
  const scaled = createImage(mask.width, mask.height, 1);
  for (let i = 0; i < scaled.data.length; i += 1) scaled.data[i] = distance.data[i] * scale;
  const grown = dilate(scaled, structuringElement(7, 7, "ellipse"), 1);

  const peaks = createImage(mask.width, mask.height, 1);
  for (let i = 0; i < peaks.data.length; i += 1) {
    peaks.data[i] = scaled.data[i] >= grown.data[i] - 1 && distance.data[i] > peak * 0.45 ? 255 : 0;
  }
  const fromPeaks = connectedComponents(peaks).count - 1;

  if (fromPeaks >= 1 && fromPeaks <= 9) return fromPeaks;
  return Math.min(Math.max(features.blobs.length, 1), 9);
}

function aspectStats(features) {
  if (!features.blobs.length) return [1, 0];
  const ratios = features.blobs.map((b) => b.h / Math.max(b.w, 1)).sort((a, b) => a - b);
  const fills = features.blobs.map((b) => b.area / Math.max(b.w * b.h, 1)).sort((a, b) => a - b);
  const mid = (arr) => arr[Math.floor(arr.length / 2)];
  return [mid(ratios), mid(fills)];
}

function subMask(mask, y0, y1) {
  const height = Math.max(0, y1 - y0);
  const out = createImage(mask.width, height, 1);
  out.data.set(mask.data.subarray(y0 * mask.width, y1 * mask.width));
  return out;
}

/**
 * 萬子の「漢数字 / 萬」の境目 (y 座標) を返す。萬子でなければ null。
 * 二萬・三萬のように漢数字自体が複数の帯に割れることがあるので、帯の数では
 * なく「中央付近にある一番大きな隙間」で上下を分ける。
 */
function manzuSplit(features) {
  const bands = features.bands;
  if (bands.length < 2) return null;
  const height = features.ink.height;

  let bestGap = 0;
  let split = null;
  for (let i = 0; i < bands.length - 1; i += 1) {
    const end = bands[i][1];
    const start = bands[i + 1][0];
    const center = (start + end) / 2;
    if (center < height * 0.35 || center > height * 0.68) continue;
    const gap = start - end;
    if (gap > bestGap) { bestGap = gap; split = Math.floor((start + end) / 2); }
  }
  if (split === null || bestGap < height * 0.06) return null;
  // 下側 (萬の字) が赤いことが萬子の決め手。
  if (features.bottomRedRatio < 0.45) return null;
  return split;
}

function manzu(features) {
  const split = manzuSplit(features);
  if (split === null) return [];
  return glyphCandidates(subMask(features.ink, 0, split), MAN_KEYS, 0.42, 0.50);
}

/** 字牌: 大きな一文字。 */
function honor(features) {
  if (!features.blobs.length) return [];

  // 白は無地か、色の付いていない薄い枠。刻印はあるのに赤も緑も黒も無い。
  const colorfulness =
    features.redRatio + features.greenRatio + features.blueRatio + features.darkRatio;
  if (colorfulness < 0.25) return [[HAKU, 0.80]];

  // 一文字なので刻印は中央に大きく広がり、丸ではない。
  if (features.coverage < 0.22 || features.circularity > 0.55) return [];

  const largest = features.blobs[0].area;
  const total = features.blobs.reduce((s, b) => s + b.area, 0) || 1;
  const dominant = largest / total;

  const out = [];
  if (features.greenRatio >= 0.40 && dominant > 0.45) {
    out.push([HATSU, 0.50 + Math.min(features.greenRatio, 0.7) * 0.55]);
  }
  if (features.redRatio >= 0.40 && dominant > 0.45) {
    out.push([CHUN, 0.50 + Math.min(features.redRatio, 0.7) * 0.55]);
  }
  if (features.darkRatio >= 0.55) {
    // 北は 2 つの部品に分かれるので、ブロブが 1 つでなくても許す。
    out.push(...glyphCandidates(features.ink, WIND_KEYS, 0.34, 0.55));
  }
  return out;
}

/** 筒子・索子: 同じ刻印が数のぶんだけ並ぶ。 */
function numbered(features) {
  if (!features.blobs.length) return [];
  const [aspect, fill] = aspectStats(features);
  const count = countMarks(features);
  if (count < 1 || count > 9) return [];

  const out = [];

  // 一索だけは鳥の絵で、数を数える対象にならない。
  if (
    features.blobs.length <= 3 && features.greenRatio >= 0.25 &&
    features.coverage >= 0.28 && features.circularity < 0.55 && count <= 2
  ) {
    out.push([SOU, 0.52]);
  }

  let souzu = 0;
  let pinzu = 0;
  if (features.greenRatio >= 0.45) souzu += 0.34;
  else if (features.greenRatio >= 0.25) souzu += 0.16;
  if (aspect >= 1.5) souzu += 0.26;
  else if (aspect >= 1.25) souzu += 0.12;

  if (features.circularity >= 0.62) pinzu += 0.34;
  else if (features.circularity >= 0.45) pinzu += 0.16;
  if (aspect >= 0.75 && aspect <= 1.25) pinzu += 0.22;
  if (features.blueRatio >= 0.10) pinzu += 0.18;
  // 筒子の刻印は輪郭が丸いので外接矩形を埋めきらない。
  if (fill >= 0.55 && fill <= 0.85) pinzu += 0.08;

  // 刻印の大きさが揃っているほど「数を並べた牌」らしい。
  const regular = features.areaCv < 0.45 ? 0.12 : 0;
  souzu += regular;
  pinzu += regular;

  // 刻印の「個数」は牌のセットによって崩れ方が大きく、規則だけでは当てにならない。
  // 種類の判断より数の判断のほうが外れやすいので確信度は意図的に低く抑え、
  // UI 側で必ず確認を促す。ライブラリに登録済みならそちらが優先される。
  const ceiling = 0.54;
  if (souzu > 0) out.push([SOU + count - 1, Math.min(0.28 + souzu, ceiling)]);
  if (pinzu > 0) out.push([PIN + count - 1, Math.min(0.28 + pinzu, ceiling)]);
  if (souzu === 0 && pinzu === 0) {
    out.push([PIN + count - 1, 0.22]);
    out.push([SOU + count - 1, 0.22]);
  }
  return out;
}

/** 候補を [牌 ID, 確信度] の降順配列で返す。 */
export function classify(features) {
  if (features.inkRatio < BLANK_INK) return [[HAKU, 0.90]];

  let candidates = manzu(features);
  if (!candidates.length) {
    // 萬子の構造がはっきり出ていれば字牌・数牌の判定は不要。
    candidates = [...honor(features), ...numbered(features)];
  }

  const merged = new Map();
  for (const [tile, score] of candidates) {
    merged.set(tile, Math.max(merged.get(tile) ?? 0, score));
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]);
}
