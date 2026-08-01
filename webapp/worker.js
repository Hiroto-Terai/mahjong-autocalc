// 認識は重いので Web Worker で走らせ、画面が固まらないようにする。

import { TileLibrary } from "./vision/library.js";
import { recognize } from "./vision/pipeline.js";

/** メインスレッドから渡された素のオブジェクトをライブラリに戻す。 */
function buildLibrary(samples) {
  if (!samples || !Object.keys(samples).length) return null;
  const library = new TileLibrary();
  library.samples = new Map(
    Object.entries(samples).map(([tile, vectors]) => [
      Number(tile),
      vectors.map((v) => Float32Array.from(v)),
    ])
  );
  return library;
}

self.onmessage = (event) => {
  const { id, image, library } = event.data;
  try {
    const result = recognize(image, buildLibrary(library));

    // 刻印マスクなど大きいものは返さず、必要なものだけ詰め直す。
    const guesses = result.guesses.map((g) => ({
      index: g.index,
      tile: g.tile,
      name: g.name,
      confidence: g.confidence,
      source: g.source,
      group: g.group,
      uncertain: g.uncertain,
      alternatives: g.alternatives,
      face: { width: g.face.width, height: g.face.height, data: g.face.data },
      quad: g.quad,
      descriptor: g.features.descriptor,
    }));

    const transfers = guesses.flatMap((g) => [g.face.data.buffer, g.descriptor.buffer]);
    self.postMessage(
      {
        id,
        ok: true,
        result: {
          guesses,
          count: result.count,
          uncertainCount: result.uncertainCount,
          librarySize: result.librarySize,
        },
      },
      transfers
    );
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
