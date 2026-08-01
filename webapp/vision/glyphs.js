// 同梱の漢字テンプレートとの照合。Python 版 vision/glyphs.py の移植。

import { createImage, resize, structuringElement, dilate } from "./cv.js";
import { GLYPH_SIZE, templates } from "./glyph-data.js";

export { GLYPH_SIZE, templates };

/** 刻印マスクを外接矩形で切り出し、縦横比を保って 32x32 に収める。 */
export function normalizeGlyph(mask) {
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
  if (count < 8) return null;

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const side = Math.max(cw, ch);
  const canvas = createImage(side, side, 1);
  const offsetX = Math.floor((side - cw) / 2);
  const offsetY = Math.floor((side - ch) / 2);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      canvas.data[(y + offsetY) * side + (x + offsetX)] =
        mask.data[(y + minY) * mask.width + (x + minX)];
    }
  }

  const small = resize(canvas, GLYPH_SIZE, GLYPH_SIZE);
  const out = createImage(GLYPH_SIZE, GLYPH_SIZE, 1);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = small.data[i] > 96 ? 1 : 0;
  return out;
}

function iou(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    if (x | y) union += 1;
    if (x & y) intersection += 1;
  }
  return union === 0 ? 0 : intersection / union;
}

const KERNEL = structuringElement(3, 3, "rect");

function fatten(bits) {
  const image = createImage(GLYPH_SIZE, GLYPH_SIZE, 1);
  for (let i = 0; i < bits.length; i += 1) image.data[i] = bits[i] ? 255 : 0;
  const grown = dilate(image, KERNEL, 1);
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < out.length; i += 1) out[i] = grown.data[i] ? 1 : 0;
  return out;
}

const fatCache = new Map();

/** keys のテンプレートと照合し、[キー, 類似度] を降順で返す。 */
export function match(mask, keys) {
  const glyph = normalizeGlyph(mask);
  if (!glyph) return [];

  const library = templates();
  // 刻印の太さの違いを吸収するため、少し膨張させたものとも比べて良い方を採る。
  const fatGlyph = fatten(glyph.data);

  const scored = [];
  for (const key of keys) {
    const template = library[key];
    if (!template) continue;
    if (!fatCache.has(key)) fatCache.set(key, fatten(template));
    scored.push([key, Math.max(iou(glyph.data, template), iou(fatGlyph, fatCache.get(key)))]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored;
}
