// 画像処理の基本操作。OpenCV の該当関数と同じ結果になるよう作ってある。
//
// opencv.js (10MB 超) を持ち込まずに済ませるため、Python 版で使っている関数
// だけを自前で実装している。色空間の定義域は OpenCV に合わせてあるので、
// Python 側のしきい値をそのまま使える。
//   HSV : H 0-179, S 0-255, V 0-255
//   Lab : L 0-255, a/b 0-255 (128 が中心)

/** 画像は { width, height, channels, data } の平たい配列で扱う。 */
export function createImage(width, height, channels, Type = Uint8ClampedArray) {
  return { width, height, channels, data: new Type(width * height * channels) };
}

export function cloneImage(image) {
  return {
    width: image.width,
    height: image.height,
    channels: image.channels,
    data: image.data.slice(),
  };
}

/** Canvas の RGBA を 3 チャンネル RGB に落とす。 */
export function fromImageData(imageData) {
  const { width, height, data } = imageData;
  const out = createImage(width, height, 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out.data[j] = data[i];
    out.data[j + 1] = data[i + 1];
    out.data[j + 2] = data[i + 2];
  }
  return out;
}

export function toImageData(image) {
  const { width, height, channels, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, o = 0; p < width * height; p += 1, o += 4) {
    if (channels === 1) {
      const v = data[p];
      out[o] = v; out[o + 1] = v; out[o + 2] = v;
    } else {
      out[o] = data[p * channels];
      out[o + 1] = data[p * channels + 1];
      out[o + 2] = data[p * channels + 2];
    }
    out[o + 3] = 255;
  }
  return new ImageData(out, width, height);
}

// ---------------------------------------------------------------------------
// 色空間
// ---------------------------------------------------------------------------

export function rgbToHsv(image) {
  const out = createImage(image.width, image.height, 3);
  const src = image.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 3) {
    const r = src[i], g = src[i + 1], b = src[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) h = 30 * (((g - b) / delta) % 6);
      else if (max === g) h = 30 * ((b - r) / delta + 2);
      else h = 30 * ((r - g) / delta + 4);
      if (h < 0) h += 180;
    }
    dst[i] = Math.round(h);
    dst[i + 1] = max === 0 ? 0 : Math.round((delta / max) * 255);
    dst[i + 2] = max;
  }
  return out;
}

const LAB_D65 = [95.047, 100.0, 108.883];

function srgbToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function labF(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(image) {
  const out = createImage(image.width, image.height, 3, Float32Array);
  const src = image.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 3) {
    const r = srgbToLinear(src[i]);
    const g = srgbToLinear(src[i + 1]);
    const b = srgbToLinear(src[i + 2]);

    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100 / LAB_D65[0];
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100 / LAB_D65[1];
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100 / LAB_D65[2];

    const fx = labF(x), fy = labF(y), fz = labF(z);
    // OpenCV の 8bit Lab と同じスケールに合わせる。
    dst[i] = (116 * fy - 16) * 255 / 100;
    dst[i + 1] = 500 * (fx - fy) + 128;
    dst[i + 2] = 200 * (fy - fz) + 128;
  }
  return out;
}

export function toGray(image) {
  const out = createImage(image.width, image.height, 1);
  const src = image.data;
  for (let p = 0, i = 0; i < src.length; i += image.channels, p += 1) {
    out.data[p] = Math.round(0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// フィルタ
// ---------------------------------------------------------------------------

/** 分離型の箱ぼかし。bilateralFilter の代わりに使う (ノイズ落としが目的)。 */
export function boxBlur(image, radius) {
  const { width, height, channels } = image;
  const tmp = new Float32Array(image.data.length);
  const out = createImage(width, height, channels, image.data.constructor);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    for (let c = 0; c < channels; c += 1) {
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) {
        const cx = Math.min(width - 1, Math.max(0, x));
        sum += image.data[(y * width + cx) * channels + c];
      }
      for (let x = 0; x < width; x += 1) {
        tmp[(y * width + x) * channels + c] = sum / window;
        const add = Math.min(width - 1, x + radius + 1);
        const drop = Math.max(0, x - radius);
        sum += image.data[(y * width + add) * channels + c];
        sum -= image.data[(y * width + drop) * channels + c];
      }
    }
  }

  for (let x = 0; x < width; x += 1) {
    for (let c = 0; c < channels; c += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1) {
        const cy = Math.min(height - 1, Math.max(0, y));
        sum += tmp[(cy * width + x) * channels + c];
      }
      for (let y = 0; y < height; y += 1) {
        out.data[(y * width + x) * channels + c] = sum / window;
        const add = Math.min(height - 1, y + radius + 1);
        const drop = Math.max(0, y - radius);
        sum += tmp[(add * width + x) * channels + c];
        sum -= tmp[(drop * width + x) * channels + c];
      }
    }
  }
  return out;
}

/** 面積平均で縮小する (OpenCV の INTER_AREA 相当)。 */
export function resize(image, newWidth, newHeight) {
  const { width, height, channels } = image;
  const out = createImage(newWidth, newHeight, channels, image.data.constructor);
  const scaleX = width / newWidth;
  const scaleY = height / newHeight;

  for (let y = 0; y < newHeight; y += 1) {
    const y0 = y * scaleY;
    const y1 = Math.min(height, (y + 1) * scaleY);
    const iy0 = Math.floor(y0);
    const iy1 = Math.max(iy0 + 1, Math.ceil(y1));
    for (let x = 0; x < newWidth; x += 1) {
      const x0 = x * scaleX;
      const x1 = Math.min(width, (x + 1) * scaleX);
      const ix0 = Math.floor(x0);
      const ix1 = Math.max(ix0 + 1, Math.ceil(x1));
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        let count = 0;
        for (let sy = iy0; sy < iy1 && sy < height; sy += 1) {
          for (let sx = ix0; sx < ix1 && sx < width; sx += 1) {
            sum += image.data[(sy * width + sx) * channels + c];
            count += 1;
          }
        }
        out.data[(y * newWidth + x) * channels + c] = count ? sum / count : 0;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 二値化とモルフォロジー
// ---------------------------------------------------------------------------

/** 大津の二値化。しきい値と二値画像を返す。 */
export function otsu(gray) {
  const histogram = new Array(256).fill(0);
  for (const v of gray.data) histogram[v] += 1;
  const total = gray.data.length;

  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumB = 0, weightB = 0, best = 0, threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) ** 2;
    if (variance > best) { best = variance; threshold = t; }
  }

  const out = createImage(gray.width, gray.height, 1);
  for (let i = 0; i < gray.data.length; i += 1) {
    out.data[i] = gray.data[i] > threshold ? 255 : 0;
  }
  return { threshold, mask: out };
}

/** 楕円/矩形カーネルのオフセット一覧を作る。 */
export function structuringElement(w, h, shape = "ellipse") {
  const offsets = [];
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (shape === "rect") {
        offsets.push([x - cx, y - cy]);
      } else {
        const nx = cx === 0 ? 0 : (x - cx) / cx;
        const ny = cy === 0 ? 0 : (y - cy) / cy;
        if (nx * nx + ny * ny <= 1.0001) offsets.push([x - cx, y - cy]);
      }
    }
  }
  return offsets.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

function morph(mask, offsets, isDilate) {
  const { width, height } = mask;
  const out = createImage(width, height, 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = isDilate ? 0 : 255;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        // 画像外は「対象なし」として扱う (OpenCV の BORDER_CONSTANT 相当)。
        const v = nx < 0 || ny < 0 || nx >= width || ny >= height
          ? (isDilate ? 0 : 255)
          : mask.data[ny * width + nx];
        if (isDilate) { if (v > value) value = v; }
        else if (v < value) value = v;
      }
      out.data[y * width + x] = value;
    }
  }
  return out;
}

export const dilate = (mask, offsets, iterations = 1) => {
  let result = mask;
  for (let i = 0; i < iterations; i += 1) result = morph(result, offsets, true);
  return result;
};

export const erode = (mask, offsets, iterations = 1) => {
  let result = mask;
  for (let i = 0; i < iterations; i += 1) result = morph(result, offsets, false);
  return result;
};

export const morphClose = (mask, offsets, iterations = 1) =>
  erode(dilate(mask, offsets, iterations), offsets, iterations);

export const morphOpen = (mask, offsets, iterations = 1) =>
  dilate(erode(mask, offsets, iterations), offsets, iterations);

// ---------------------------------------------------------------------------
// 連結成分
// ---------------------------------------------------------------------------

/**
 * 8 近傍の連結成分。ラベル画像と成分ごとの統計を返す。
 * ラベル 0 は背景。
 */
export function connectedComponents(mask) {
  const { width, height } = mask;
  const labels = new Int32Array(width * height).fill(-1);
  const stats = [{ x: 0, y: 0, w: 0, h: 0, area: 0 }];
  const queue = new Int32Array(width * height);

  let next = 1;
  for (let start = 0; start < labels.length; start += 1) {
    if (mask.data[start] === 0 || labels[start] !== -1) continue;

    let head = 0, tail = 0;
    queue[tail += 1] = start;
    labels[start] = next;

    let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;
    while (head < tail) {
      const p = queue[head += 1];
      const px = p % width;
      const py = (p - px) / width;
      area += 1;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask.data[q] === 0 || labels[q] !== -1) continue;
          labels[q] = next;
          queue[tail += 1] = q;
        }
      }
    }
    stats.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
    next += 1;
  }

  for (let i = 0; i < labels.length; i += 1) if (labels[i] === -1) labels[i] = 0;
  return { count: next, labels, stats };
}

/** 縁から届かない穴を埋める (findContours + FILLED 相当)。 */
export function fillHoles(mask) {
  const { width, height } = mask;
  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;

  const push = (p) => {
    if (mask.data[p] !== 0 || outside[p]) return;
    outside[p] = 1;
    queue[tail += 1] = p;
  };
  for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }

  while (head < tail) {
    const p = queue[head += 1];
    const px = p % width;
    const py = (p - px) / width;
    if (px > 0) push(p - 1);
    if (px < width - 1) push(p + 1);
    if (py > 0) push(p - width);
    if (py < height - 1) push(p + width);
  }

  const out = createImage(width, height, 1);
  for (let i = 0; i < out.data.length; i += 1) {
    out.data[i] = mask.data[i] !== 0 || !outside[i] ? 255 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 成分の輪郭画素 (4 近傍に非成分がある画素) を集める。 */
export function componentBoundary(labels, width, height, label) {
  const points = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (labels[p] !== label) continue;
      const edge =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        labels[p - 1] !== label || labels[p + 1] !== label ||
        labels[p - width] !== label || labels[p + width] !== label;
      if (edge) points.push([x, y]);
    }
  }
  return points;
}

/** Andrew の monotone chain による凸包。 */
export function convexHull(points) {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 回転キャリパー法による最小外接矩形 (cv2.minAreaRect 相当)。
 * @returns {{center:[number,number], size:[number,number], angle:number, points:number[][]}}
 */
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return {
      center: [(x0 + x1) / 2, (y0 + y1) / 2],
      size: [x1 - x0 + 1, y1 - y0 + 1],
      angle: 0,
      points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    };
  }

  let best = null;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const ux = dx / length, uy = dy / length;   // 辺方向
    const vx = -uy, vy = ux;                    // 法線方向

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = p[0] * vx + p[1] * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
    }
  }

  const { ux, uy, vx, vy, minU, maxU, minV, maxV } = best;
  const corner = (u, v) => [u * ux + v * vx, u * uy + v * vy];
  const pts = [
    corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV),
  ];
  const cx = (pts[0][0] + pts[2][0]) / 2;
  const cy = (pts[0][1] + pts[2][1]) / 2;
  return {
    center: [cx, cy],
    size: [maxU - minU, maxV - minV],
    angle: (Math.atan2(uy, ux) * 180) / Math.PI,
    points: pts,
  };
}

// ---------------------------------------------------------------------------
// 射影変換
// ---------------------------------------------------------------------------

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let c = col; c <= n; c += 1) a[col][c] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r][col];
      if (!factor) continue;
      for (let c = col; c <= n; c += 1) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row[n]);
}

/** 4 点対応から射影変換行列 (3x3, 行優先) を作る。 */
export function getPerspectiveTransform(src, dst) {
  const rows = [];
  const rhs = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }
  const h = solveLinearSystem(rows, rhs);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/** 射影変換で切り出す (双線形補間)。 */
export function warpPerspective(image, matrix, outWidth, outHeight) {
  const inverse = invert3x3(matrix);
  const { width, height, channels, data } = image;
  const out = createImage(outWidth, outHeight, channels);
  if (!inverse) return out;

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const w = inverse[6] * x + inverse[7] * y + inverse[8];
      if (Math.abs(w) < 1e-12) continue;
      const sx = (inverse[0] * x + inverse[1] * y + inverse[2]) / w;
      const sy = (inverse[3] * x + inverse[4] * y + inverse[5]) / w;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue;

      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;

      for (let c = 0; c < channels; c += 1) {
        const p00 = data[(y0 * width + x0) * channels + c];
        const p10 = data[(y0 * width + x1) * channels + c];
        const p01 = data[(y1 * width + x0) * channels + c];
        const p11 = data[(y1 * width + x1) * channels + c];
        out.data[(y * outWidth + x) * channels + c] =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
          p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 距離変換
// ---------------------------------------------------------------------------

/** 5x5 チャンファーによる距離変換 (cv2.distanceTransform DIST_L2 相当)。 */
export function distanceTransform(mask) {
  const { width, height } = mask;
  const dist = new Float32Array(width * height);
  const A = 1.0, B = 1.4, C = 2.1969;

  for (let i = 0; i < dist.length; i += 1) dist[i] = mask.data[i] ? Infinity : 0;

  const relax = (p, q, cost) => {
    const value = dist[q] + cost;
    if (value < dist[p]) dist[p] = value;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (dist[p] === 0) continue;
      if (x > 0) relax(p, p - 1, A);
      if (y > 0) relax(p, p - width, A);
      if (x > 0 && y > 0) relax(p, p - width - 1, B);
      if (x < width - 1 && y > 0) relax(p, p - width + 1, B);
      if (x > 1 && y > 0) relax(p, p - width - 2, C);
      if (x < width - 2 && y > 0) relax(p, p - width + 2, C);
      if (x > 0 && y > 1) relax(p, p - 2 * width - 1, C);
      if (x < width - 1 && y > 1) relax(p, p - 2 * width + 1, C);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const p = y * width + x;
      if (dist[p] === 0) continue;
      if (x < width - 1) relax(p, p + 1, A);
      if (y < height - 1) relax(p, p + width, A);
      if (x < width - 1 && y < height - 1) relax(p, p + width + 1, B);
      if (x > 0 && y < height - 1) relax(p, p + width - 1, B);
      if (x < width - 2 && y < height - 1) relax(p, p + width + 2, C);
      if (x > 1 && y < height - 1) relax(p, p + width - 2, C);
      if (x < width - 1 && y < height - 2) relax(p, p + 2 * width + 1, C);
      if (x > 0 && y < height - 2) relax(p, p + 2 * width - 1, C);
    }
  }
  return { width, height, channels: 1, data: dist };
}

export function percentile(values, q) {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return 0;
  const position = (q / 100) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function median(values) {
  return percentile(values, 50);
}
