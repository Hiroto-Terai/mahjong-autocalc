// 写真から牌の面を切り出す。Python 版 vision/detect.py の移植。

import {
  boxBlur, connectedComponents, createImage, fillHoles, getPerspectiveTransform,
  minAreaRect, morphClose, morphOpen, percentile, resize, rgbToHsv, structuringElement,
  toGray, warpPerspective,
} from "./cv.js";

export const TILE_W = 64;
export const TILE_H = 88;
export const TILE_ASPECT = TILE_W / TILE_H; // 牌の面の 幅/高さ。おおよそ 0.72

export const MAX_DIMENSION = 1400;
// 面の検出はモルフォロジーが重いので、さらに縮めた画像で行う。切り出し自体は
// MAX_DIMENSION 側から行うので、牌の解像度は落ちない。
const DETECT_DIMENSION = 720;
const MIN_TILE_SIDE_RATIO = 0.017;
const MIN_AREA_RATIO = 0.0008;
// 牌の列が画面いっぱいに写ることは普通にあるので、面積の上限は緩くとる。
// 「背景そのもの」を拾わないためには、四辺すべてに接しているかどうかで弾く。
const MAX_AREA_RATIO = 0.75;

export class DetectionError extends Error {}

/** 牌の面 (明るく彩度の低い領域) のマスクを作る。 */
export function faceMask(image) {
  const blurred = boxBlur(image, 3);
  const hsv = rgbToHsv(blurred);

  const saturation = new Uint8Array(image.width * image.height);
  const value = new Uint8Array(image.width * image.height);
  for (let p = 0; p < saturation.length; p += 1) {
    saturation[p] = hsv.data[p * 3 + 1];
    value[p] = hsv.data[p * 3 + 2];
  }

  // 明るさは画像全体の分布から動的に決める (露出のばらつきに対応)。
  const vThresh = Math.max(110, Math.round(percentile(value, 70)) - 30);
  const sThresh = Math.max(60, Math.round(percentile(saturation, 40)) + 40);

  const mask = createImage(image.width, image.height, 1);
  for (let p = 0; p < mask.data.length; p += 1) {
    mask.data[p] = value[p] >= vThresh && saturation[p] <= sThresh ? 255 : 0;
  }

  const kernel = structuringElement(5, 5, "ellipse");
  let result = morphClose(mask, kernel, 2);
  result = morphOpen(result, kernel, 1);
  // 牌の文字は暗いのでマスクに穴が開く。埋めて面を一枚板にする。
  return fillHoles(result);
}

/** 四隅を 左上, 右上, 右下, 左下 の順に並べ替える。 */
export function orderQuad(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)
  );
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    const sum = p[0] + p[1];
    if (sum < best) { best = sum; start = i; }
  });
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

function warpQuad(image, quad, width, height) {
  const dst = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
  const matrix = getPerspectiveTransform(orderQuad(quad), dst);
  return warpPerspective(image, matrix, width, height);
}

/** 横長の帯から、牌と牌の継ぎ目 (ほぼ全高が暗い列) の x 座標を返す。 */
function seamPositions(strip) {
  const gray = toGray(strip);
  const blurred = boxBlur(gray, 1);
  const threshold = Math.max(60, Math.round(percentile(blurred.data, 45)) - 15);

  const darkRatio = new Float64Array(strip.width);
  for (let x = 0; x < strip.width; x += 1) {
    let dark = 0;
    for (let y = 0; y < strip.height; y += 1) {
      if (blurred.data[y * strip.width + x] < threshold) dark += 1;
    }
    darkRatio[x] = dark / strip.height;
  }

  const seams = [];
  let runStart = null;
  for (let x = 0; x < darkRatio.length; x += 1) {
    if (darkRatio[x] >= 0.65) {
      if (runStart === null) runStart = x;
    } else if (runStart !== null) {
      seams.push(Math.floor((runStart + x - 1) / 2));
      runStart = null;
    }
  }
  if (runStart !== null) seams.push(Math.floor((runStart + darkRatio.length - 1) / 2));

  const margin = strip.height * TILE_ASPECT * 0.4;
  return seams.filter((s) => s > margin && s < strip.width - margin);
}

/** 帯に含まれる牌の枚数を決める。継ぎ目を優先し、無ければ縦横比から推定。 */
function splitCount(stripW, stripH, seams) {
  const fromAspect = Math.max(1, Math.round((stripW / stripH) / TILE_ASPECT));
  if (!seams.length) return fromAspect;

  const fromSeams = seams.length + 1;
  const expected = stripW / fromSeams;
  const positions = [0, ...seams, stripW];
  const widths = positions.slice(1).map((p, i) => p - positions[i]);
  if (widths.every((w) => Math.abs(w - expected) <= expected * 0.35)) return fromSeams;
  return fromAspect;
}

/** 帯の四隅を「長辺が横」になるよう並べ替える。 */
function normalizeRowQuad(quad) {
  const ordered = orderQuad(quad);
  const topLen = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
  const leftLen = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
  if (topLen >= leftLen) return ordered;
  return [...ordered.slice(1), ordered[0]];
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * 四隅で囲まれた帯を count 枚に等分して切り出す。
 *
 * 自動検出の結果にも、利用者が手で指定した範囲にも同じものを使う。
 * quad は 左上, 右上, 右下, 左下 の順。
 */
export function cropRow(image, quad, count, group = 0, startOrder = 0) {
  const ordered = normalizeRowQuad(quad);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    const tileQuad = [
      lerp(ordered[0], ordered[1], t0),
      lerp(ordered[0], ordered[1], t1),
      lerp(ordered[3], ordered[2], t1),
      lerp(ordered[3], ordered[2], t0),
    ];
    out.push({
      image: warpQuad(image, tileQuad, TILE_W, TILE_H),
      quad: tileQuad,
      group,
      order: startOrder + i,
    });
  }
  return out;
}

/** 帯の縦横比から、入っていそうな牌の枚数を見積もる。 */
export function estimateTileCount(quad) {
  const ordered = normalizeRowQuad(quad);
  const width = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
  const height = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
  if (height <= 0) return 1;
  return Math.max(1, Math.min(18, Math.round((width / height) / TILE_ASPECT)));
}

/**
 * 写真から牌を検出し、正規化した面の画像を並び順に返す。
 * @returns {{image:object, quad:number[][], group:number, order:number}[]}
 */
export function detectTiles(image) {
  if (!image || !image.width || !image.height) {
    throw new DetectionError("画像を読み込めませんでした");
  }

  // 大きすぎる写真は縮めてから処理する。
  let work = image;
  let scale = 1;
  const longest = Math.max(image.width, image.height);
  if (longest > MAX_DIMENSION) {
    scale = MAX_DIMENSION / longest;
    work = resize(image, Math.round(image.width * scale), Math.round(image.height * scale));
  }
  const invScale = 1 / scale;

  // 検出用の縮小画像。求めた四隅は work 座標に戻して使う。
  let small = work;
  let detectScale = 1;
  const smallLongest = Math.max(work.width, work.height);
  if (smallLongest > DETECT_DIMENSION) {
    detectScale = DETECT_DIMENSION / smallLongest;
    small = resize(work, Math.round(work.width * detectScale), Math.round(work.height * detectScale));
  }
  const toWork = 1 / detectScale;

  const mask = faceMask(small);
  const totalArea = small.width * small.height;
  const minSide = Math.max(6, Math.min(small.width, small.height) * MIN_TILE_SIDE_RATIO);
  const { count, labels, stats } = connectedComponents(mask);

  const blobs = [];
  for (let label = 1; label < count; label += 1) {
    const stat = stats[label];
    if (stat.area < MIN_AREA_RATIO * totalArea || stat.area > MAX_AREA_RATIO * totalArea) continue;
    // 四辺すべてに接する塊は背景。
    if (stat.x === 0 && stat.y === 0 &&
        stat.x + stat.w >= small.width && stat.y + stat.h >= small.height) continue;

    const boundary = [];
    for (let y = stat.y; y < stat.y + stat.h; y += 1) {
      for (let x = stat.x; x < stat.x + stat.w; x += 1) {
        if (labels[y * small.width + x] === label) boundary.push([x, y]);
      }
    }
    if (boundary.length < 8) continue;

    const rect = minAreaRect(boundary);
    const [rw, rh] = rect.size;
    if (Math.min(rw, rh) < minSide) continue;
    // 長方形からかけ離れた形は牌ではない。
    if (stat.area / Math.max(rw * rh, 1e-6) < 0.72) continue;
    if (Math.max(rw, rh) / Math.min(rw, rh) > 24) continue;

    blobs.push(rect.points.map(([x, y]) => [x * toWork, y * toWork]));
  }

  if (!blobs.length) {
    throw new DetectionError(
      "牌を検出できませんでした。明るい場所で、牌を正面から大きく写してください"
    );
  }

  // 塊を「上から下、左から右」に並べる。
  blobs.sort((a, b) => {
    const ca = a.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
    const cb = b.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
    return (Math.round(ca[1] / 40) - Math.round(cb[1] / 40)) || (ca[0] - cb[0]);
  });

  const results = [];
  let order = 0;
  blobs.forEach((quad, groupIndex) => {
    const ordered = normalizeRowQuad(quad);
    const width = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
    const height = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
    if (height < 8) return;

    const stripW = Math.max(TILE_W, Math.round((width / height) * TILE_H));
    const strip = warpQuad(work, ordered, stripW, TILE_H);

    let n = splitCount(stripW, TILE_H, seamPositions(strip));
    n = Math.max(1, Math.min(n, 18));

    for (const tile of cropRow(work, ordered, n, groupIndex, order)) {
      results.push({
        ...tile,
        quad: tile.quad.map(([x, y]) => [x * invScale, y * invScale]),
      });
      order += 1;
    }
  });

  if (!results.length) throw new DetectionError("牌の切り出しに失敗しました");
  return results;
}
