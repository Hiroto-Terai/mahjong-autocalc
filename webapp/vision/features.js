// 正規化した牌の面から特徴量を取り出す。Python 版 vision/features.py の移植。

import {
  boxBlur, connectedComponents, createImage, morphClose, percentile,
  resize, rgbToHsv, rgbToLab, structuringElement,
} from "./cv.js";
import { TILE_H, TILE_W } from "./detect.js";

// 面の縁 (段差や影が出る) を除いた内側だけを見る。
const INNER_MARGIN_X = 0.10;
const INNER_MARGIN_Y = 0.07;

const DESCRIPTOR_GRID = [14, 18];
const HALF_GRID = [16, 12];
const GLYPH_GRID = [16, 16];

export function innerRegion(image) {
  const dx = Math.floor(image.width * INNER_MARGIN_X);
  const dy = Math.floor(image.height * INNER_MARGIN_Y);
  const width = image.width - dx * 2;
  const height = image.height - dy * 2;
  const out = createImage(width, height, image.channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < image.channels; c += 1) {
        out.data[(y * width + x) * image.channels + c] =
          image.data[((y + dy) * image.width + (x + dx)) * image.channels + c];
      }
    }
  }
  return out;
}

/** 面積の小さい連結成分をノイズとして取り除く。 */
function dropSpecks(mask) {
  const { count, labels, stats } = connectedComponents(mask);
  if (count <= 1) return mask;
  const floor = Math.max(6, Math.floor(mask.data.length * 0.0015));
  const out = createImage(mask.width, mask.height, 1);
  for (let i = 0; i < out.data.length; i += 1) {
    const label = labels[i];
    out.data[i] = label > 0 && stats[label].area >= floor ? 255 : 0;
  }
  return out;
}

/** 下地の色から離れた画素を刻印として取り出す。 */
function inkMask(face) {
  const lab = rgbToLab(face);
  const pixels = face.width * face.height;

  // 下地は面積の大半を占めるので中央値で代表させる。
  const ls = new Float64Array(pixels), as = new Float64Array(pixels), bs = new Float64Array(pixels);
  for (let p = 0; p < pixels; p += 1) {
    ls[p] = lab.data[p * 3];
    as[p] = lab.data[p * 3 + 1];
    bs[p] = lab.data[p * 3 + 2];
  }
  const base = [percentile(ls, 50), percentile(as, 50), percentile(bs, 50)];

  const raw = createImage(face.width, face.height, 1, Float32Array);
  for (let p = 0; p < pixels; p += 1) {
    raw.data[p] = Math.hypot(
      lab.data[p * 3] - base[0],
      lab.data[p * 3 + 1] - base[1],
      lab.data[p * 3 + 2] - base[2]
    );
  }
  const distance = boxBlur(raw, 1);

  // 刻印が無い牌 (白) では大津法がノイズを拾うため、絶対量でも足切りする。
  if (percentile(distance.data, 97) < 18) {
    return createImage(face.width, face.height, 1);
  }

  let maxDistance = 0;
  for (const v of distance.data) if (v > maxDistance) maxDistance = v;
  const normalized = createImage(face.width, face.height, 1);
  for (let p = 0; p < pixels; p += 1) {
    normalized.data[p] = Math.min(255, Math.round((distance.data[p] / Math.max(maxDistance, 1e-6)) * 255));
  }

  // 大津法
  const histogram = new Array(256).fill(0);
  for (const v of normalized.data) histogram[v] += 1;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumB = 0, weightB = 0, best = 0, threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    weightB += histogram[t];
    if (!weightB) continue;
    const weightF = pixels - weightB;
    if (!weightF) break;
    sumB += t * histogram[t];
    const variance = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
    if (variance > best) { best = variance; threshold = t; }
  }

  const mask = createImage(face.width, face.height, 1);
  for (let p = 0; p < pixels; p += 1) mask.data[p] = normalized.data[p] > threshold ? 255 : 0;

  // オープニングは「三」のような細い横棒を消してしまうので使わない。
  // 途切れを埋めるクローズだけかけ、ノイズは連結成分の面積で落とす。
  return dropSpecks(morphClose(mask, structuringElement(3, 3, "ellipse"), 1));
}

/** 刻印画素を 赤/緑/青/黒 に分類して割合を返す。 */
function colorRatios(face, mask) {
  const hsv = rgbToHsv(face);
  let total = 0, red = 0, green = 0, blue = 0, dark = 0;
  for (let p = 0; p < mask.data.length; p += 1) {
    if (!mask.data[p]) continue;
    total += 1;
    const h = hsv.data[p * 3], s = hsv.data[p * 3 + 1], v = hsv.data[p * 3 + 2];
    const colored = s >= 70;
    if (colored && (h <= 12 || h >= 165)) red += 1;
    else if (colored && h >= 35 && h <= 95) green += 1;
    else if (colored && h > 95 && h < 140) blue += 1;
    else if (v < 200) dark += 1;
  }
  if (!total) return [0, 0, 0, 0];
  return [red / total, green / total, blue / total, dark / total];
}

function blobsOf(mask) {
  const { count, stats } = connectedComponents(mask);
  const floor = Math.max(12, Math.floor(mask.data.length * 0.004));
  const found = [];
  for (let i = 1; i < count; i += 1) {
    if (stats[i].area < floor) continue;
    found.push(stats[i]);
  }
  found.sort((a, b) => b.area - a.area);
  return found;
}

/** 刻印の行方向の帯を求める。萬子の「数字 + 萬」のような上下分割を捉える。 */
function bandsOf(mask) {
  const active = [];
  for (let y = 0; y < mask.height; y += 1) {
    let on = 0;
    for (let x = 0; x < mask.width; x += 1) if (mask.data[y * mask.width + x]) on += 1;
    active.push(on / mask.width > 0.04);
  }

  const bands = [];
  let start = null;
  active.forEach((on, y) => {
    if (on && start === null) start = y;
    else if (!on && start !== null) { bands.push([start, y]); start = null; }
  });
  if (start !== null) bands.push([start, active.length]);

  // 細い隙間は同じ帯とみなす (画数の切れ目で割れないように)。
  const minGap = Math.max(3, Math.floor(mask.height * 0.07));
  const merged = [];
  for (const band of bands) {
    if (merged.length && band[0] - merged[merged.length - 1][1] < minGap) {
      merged[merged.length - 1][1] = band[1];
    } else {
      merged.push([...band]);
    }
  }
  const minHeight = Math.max(2, Math.floor(mask.height * 0.05));
  return merged.filter(([a, b]) => b - a >= minHeight);
}

/** 最大ブロブの円形度 (4πA/P²)。筒子の丸は 1 に近く、漢字は低い。 */
function circularityOf(mask, blob) {
  let area = 0;
  let perimeter = 0;
  for (let y = blob.y; y < blob.y + blob.h; y += 1) {
    for (let x = blob.x; x < blob.x + blob.w; x += 1) {
      if (!mask.data[y * mask.width + x]) continue;
      area += 1;
      let edge = 0;
      if (x === 0 || !mask.data[y * mask.width + x - 1]) edge += 1;
      if (x === mask.width - 1 || !mask.data[y * mask.width + x + 1]) edge += 1;
      if (y === 0 || !mask.data[(y - 1) * mask.width + x]) edge += 1;
      if (y === mask.height - 1 || !mask.data[(y + 1) * mask.width + x]) edge += 1;
      perimeter += edge;
    }
  }
  if (perimeter <= 0) return 0;
  // 画素を数えた周長は連続曲線より長く出るので、経験的に補正する。
  const corrected = perimeter * 0.95;
  return (4 * Math.PI * area) / (corrected * corrected);
}

// --- 照合ベクトル -----------------------------------------------------------

function unit(vector) {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm <= 1e-6) return vector;
  return vector.map((v) => v / norm);
}

function subMask(mask, y0, y1) {
  const height = Math.max(0, y1 - y0);
  const out = createImage(mask.width, height, 1);
  out.data.set(mask.data.subarray(y0 * mask.width, y1 * mask.width));
  return out;
}

function regionGrid(mask, [w, h]) {
  if (!mask.height) return new Array(w * h).fill(0);
  const grid = resize(mask, w, h);
  return unit(Array.from(grid.data, (v) => v / 255));
}

/**
 * 刻印を外接矩形で切り出してから正規化する。
 * 位置と大きさの違いを吸収するので、萬子の漢数字のように「小さくて似ている」
 * 刻印の差がはっきり出る。
 */
function croppedGrid(mask, [w, h]) {
  const empty = new Array(w * h).fill(0);
  if (!mask.height) return empty;
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.data[y * mask.width + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count < 6) return empty;

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cropped = createImage(cw, ch, 1);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      cropped.data[y * cw + x] = mask.data[(y + minY) * mask.width + (x + minX)];
    }
  }
  return unit(Array.from(resize(cropped, w, h).data, (v) => v / 255));
}

/**
 * 萬子の漢数字にあたる部分を取り出す。
 * 上下を機械的に半分で割ると、切り出しが数ピクセルずれただけで漢数字の一部が
 * はみ出して別の字に見えてしまう。刻印の帯構造を使って「一番下の帯より上」を
 * 取れば、位置ずれに左右されずに数字だけを見られる。
 */
export function upperGlyphRegion(mask, bands) {
  if (bands.length >= 2) return subMask(mask, 0, bands[bands.length - 1][0]);
  return mask;
}

function buildDescriptor(mask, ratios, inkRatio, bands) {
  const half = Math.floor(mask.height / 2);
  const full = regionGrid(mask, DESCRIPTOR_GRID);
  const top = regionGrid(subMask(mask, 0, half), HALF_GRID);
  const bottom = regionGrid(subMask(mask, half, mask.height), HALF_GRID);
  const topGlyph = croppedGrid(upperGlyphRegion(mask, bands), GLYPH_GRID);
  const color = unit([...ratios, Math.min(inkRatio * 3, 1)]);

  return Float32Array.from(unit([
    ...full,
    ...top.map((v) => v * 1.1),
    ...bottom.map((v) => v * 0.5),
    ...topGlyph.map((v) => v * 0.9),
    ...color.map((v) => v * 0.65),
  ]));
}

/** 正規化済みの牌の面 (TILE_H x TILE_W, RGB) から特徴量を計算する。 */
export function extract(face) {
  let source = face;
  if (source.width !== TILE_W || source.height !== TILE_H) {
    source = resize(source, TILE_W, TILE_H);
  }

  const region = innerRegion(source);
  const mask = inkMask(region);
  const ratios = colorRatios(region, mask);

  let inkPixels = 0;
  for (const v of mask.data) if (v) inkPixels += 1;
  const inkRatio = inkPixels / mask.data.length;

  const half = Math.floor(mask.height / 2);
  const topMask = subMask(mask, 0, half);
  const bottomMask = subMask(mask, half, mask.height);

  const bottomRegion = createImage(region.width, mask.height - half, 3);
  bottomRegion.data.set(region.data.subarray(half * region.width * 3));
  const bottomRed = colorRatios(bottomRegion, bottomMask)[0];

  const blobs = blobsOf(mask);
  let areaCv = 0, circularity = 0, coverage = 0;
  if (blobs.length) {
    const areas = blobs.map((b) => b.area);
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    const variance = areas.reduce((s, a) => s + (a - mean) ** 2, 0) / areas.length;
    areaCv = Math.sqrt(variance) / Math.max(mean, 1e-6);
    circularity = circularityOf(mask, blobs[0]);
    const minX = Math.min(...blobs.map((b) => b.x));
    const maxX = Math.max(...blobs.map((b) => b.x + b.w));
    const minY = Math.min(...blobs.map((b) => b.y));
    const maxY = Math.max(...blobs.map((b) => b.y + b.h));
    coverage = ((maxX - minX) * (maxY - minY)) / mask.data.length;
  }

  const bands = bandsOf(mask);
  const countOn = (m) => {
    let n = 0;
    for (const v of m.data) if (v) n += 1;
    return m.data.length ? n / m.data.length : 0;
  };

  return {
    ink: mask,
    inkRatio,
    redRatio: ratios[0],
    greenRatio: ratios[1],
    blueRatio: ratios[2],
    darkRatio: ratios[3],
    descriptor: buildDescriptor(mask, ratios, inkRatio, bands),
    blobs,
    topInkRatio: countOn(topMask),
    bottomInkRatio: countOn(bottomMask),
    bottomRedRatio: bottomRed,
    bands,
    circularity,
    areaCv,
    coverage,
  };
}

/** L2 正規化済みベクトル同士のコサイン類似度。 */
export function similarity(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}
