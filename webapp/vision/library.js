// ユーザー自身の牌を覚える参照ライブラリ。Python 版 vision/library.py の移植。
//
// 牌のデザインはセットごとに違うため、汎用の規則だけでは限界がある。実際に
// 使っている牌の写真を登録しておけば、以降は最近傍照合でほぼ確実に判別できる。
// 保存先はブラウザの IndexedDB (端末内にのみ残る)。

import { NUM_TILE_KINDS, tileName } from "../engine/tiles.js";
import { similarity } from "./features.js";

export const MAX_SAMPLES_PER_TILE = 12;

const DB_NAME = "mahjong-autocalc";
const DB_VERSION = 1;
const STORE = "tile-library";
const RECORD_KEY = "samples";

/** テスト用・IndexedDB が使えない環境用のメモリ保存。 */
export class MemoryStorage {
  constructor() { this.value = null; }
  async load() { return this.value; }
  async save(data) { this.value = data; }
}

export class IndexedDbStorage {
  #open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async load() {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async save(data) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export class TileLibrary {
  constructor(storage) {
    this.storage = storage ?? new MemoryStorage();
    this.samples = new Map(); // tile -> Float32Array[]
  }

  static async open(storage) {
    const library = new TileLibrary(storage);
    await library.load();
    return library;
  }

  async load() {
    let raw;
    try {
      raw = await this.storage.load();
    } catch {
      return;
    }
    if (!raw) return;
    this.samples = new Map(
      Object.entries(raw).map(([tile, vectors]) => [
        Number(tile),
        vectors.map((v) => Float32Array.from(v)),
      ])
    );
  }

  async save() {
    const payload = {};
    for (const [tile, vectors] of this.samples) {
      if (vectors.length) payload[tile] = vectors.map((v) => Array.from(v));
    }
    await this.storage.save(payload);
  }

  /** 特徴を登録する。既存とほぼ同じで登録しなかった場合は false。 */
  add(tile, features) {
    if (!(tile >= 0 && tile < NUM_TILE_KINDS)) throw new Error(`牌 ID が範囲外です: ${tile}`);
    const vector = features.descriptor;
    const samples = this.samples.get(tile) ?? [];
    // ほぼ同じベクトルは足さない (同じ写真を何度も登録しても太らせない)。
    if (samples.some((existing) => similarity(vector, existing) > 0.995)) return false;
    samples.push(vector);
    if (samples.length > MAX_SAMPLES_PER_TILE) samples.shift();
    this.samples.set(tile, samples);
    return true;
  }

  clear() {
    this.samples = new Map();
  }

  /** @returns {{tile:number, score:number, margin:number}|null} */
  match(features) {
    if (!this.samples.size) return null;
    const vector = features.descriptor;

    const best = [];
    for (const [tile, samples] of this.samples) {
      if (!samples.length) continue;
      let score = -Infinity;
      for (const sample of samples) {
        const s = similarity(vector, sample);
        if (s > score) score = s;
      }
      best.push([tile, score]);
    }
    if (!best.length) return null;

    best.sort((a, b) => b[1] - a[1]);
    const runnerUp = best.length > 1 ? best[1][1] : 0;
    return { tile: best[0][0], score: best[0][1], margin: best[0][1] - runnerUp };
  }

  get size() {
    let total = 0;
    for (const vectors of this.samples.values()) total += vectors.length;
    return total;
  }

  coverage() {
    const out = {};
    for (const [tile, vectors] of [...this.samples].sort((a, b) => a[0] - b[0])) {
      if (vectors.length) out[tileName(tile)] = vectors.length;
    }
    return out;
  }

  /** まだ 1 枚も登録されていない牌。 */
  missing() {
    const out = [];
    for (let tile = 0; tile < NUM_TILE_KINDS; tile += 1) {
      if (!this.samples.get(tile)?.length) out.push(tile);
    }
    return out;
  }
}
