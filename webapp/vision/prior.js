// 同梱の初期ライブラリ。
//
// 合成した多数の牌デザインから作った参照データ。これがあるおかげで、何も登録
// しなくても最初からある程度読める。利用者が自分の牌を登録した場合は、そちらが
// 優先される (手元のセットに特化したデータのほうが当然強い)。
//
// 中身は uint8 に量子化した特徴ベクトル。記述子は非負なので、尺度を掛けて
// 正規化し直すだけで元に戻る。

import { TileLibrary } from "./library.js";

let cached = null;
let pending = null;

/**
 * メタ情報と生バイトから参照ライブラリを組み立てる。
 * fetch を通さずに呼べるようにしてあるのは、テストからも使うため。
 */
export function buildPriorLibrary(meta, buffer) {
  const codes = new Uint8Array(buffer);
  const dims = meta.dims;
  const scale = meta.scale / 255;

  const library = new TileLibrary();
  library.samples = new Map();

  let offset = 0;
  for (const [tile, count] of Object.entries(meta.counts)) {
    const vectors = [];
    for (let i = 0; i < count; i += 1) {
      const vector = new Float32Array(dims);
      let norm = 0;
      for (let d = 0; d < dims; d += 1) {
        const value = codes[offset + d] * scale;
        vector[d] = value;
        norm += value * value;
      }
      norm = Math.sqrt(norm);
      if (norm > 1e-6) for (let d = 0; d < dims; d += 1) vector[d] /= norm;
      vectors.push(vector);
      offset += dims;
    }
    library.samples.set(Number(tile), vectors);
  }
  return library;
}

async function fetchPrior() {
  const [meta, buffer] = await Promise.all([
    fetch(new URL("./prior-library.json", import.meta.url))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("meta")))),
    fetch(new URL("./prior-library.bin", import.meta.url))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("bin")))),
  ]);
  return buildPriorLibrary(meta, buffer);
}

/**
 * 初期ライブラリを読み込む。読めなければ null を返す (規則ベースに落ちるだけ)。
 * 一度読んだら使い回す。
 */
export function loadPriorLibrary() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetchPrior()
      .then((library) => { cached = library; return library; })
      .catch(() => null);
  }
  return pending;
}
