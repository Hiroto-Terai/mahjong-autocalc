// JS 版画像認識のテスト。Python 版と同じ合成画像 (生 RGB) を入力にして、
// 検出枚数と、ライブラリ登録後の判別精度を確認する。
//
//   python tools/export_raw_samples.py /tmp/mj-raw
//   MJ_RAW_DIR=/tmp/mj-raw node --test webapp/tests/vision.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { tileName } from "../engine/tiles.js";
import { detectTiles } from "../vision/detect.js";
import { extract } from "../vision/features.js";
import { TileLibrary } from "../vision/library.js";
import { recognize } from "../vision/pipeline.js";
import { buildPriorLibrary } from "../vision/prior.js";

const RAW_DIR = process.env.MJ_RAW_DIR || "/tmp/mj-raw";
const available = fs.existsSync(path.join(RAW_DIR, "index.json"));

const index = available
  ? JSON.parse(fs.readFileSync(path.join(RAW_DIR, "index.json"), "utf8"))
  : [];

function loadImage(entry) {
  const data = fs.readFileSync(path.join(RAW_DIR, `${entry.name}.bin`));
  return {
    width: entry.width,
    height: entry.height,
    channels: 3,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
  };
}

const find = (notation, seed) => index.find((e) => e.notation === notation && e.seed === seed);

const skip = available
  ? false
  : "生データがありません (python tools/export_raw_samples.py /tmp/mj-raw を実行してください)";

// ---------------------------------------------------------------------------

test("検出枚数が手牌の枚数と一致する", { skip }, () => {
  for (const entry of index.filter((e) => e.seed === 3)) {
    const detected = detectTiles(loadImage(entry));
    assert.equal(detected.length, entry.tiles.length, `${entry.notation}: 検出数がずれています`);
  }
});

test("切り出した牌は正規化され、順番が保たれる", { skip }, () => {
  const entry = find("123456789m", 3);
  const detected = detectTiles(loadImage(entry));
  assert.deepEqual(detected.map((t) => t.order), [...Array(9).keys()]);
  for (const tile of detected) {
    assert.equal(tile.image.width, 64);
    assert.equal(tile.image.height, 88);
  }
});

test("特徴量が色を見分ける", { skip }, () => {
  const detected = detectTiles(loadImage(find("1234567z", 3)));
  const features = detected.map((t) => extract(t.image));
  assert.ok(features[5].greenRatio > 0.4, "發が緑と判定されていない");
  assert.ok(features[6].redRatio > 0.4, "中が赤と判定されていない");
});

test("萬子の刻印は上下 2 帯に割れる", { skip }, () => {
  const detected = detectTiles(loadImage(find("123456789m", 3)));
  for (const tile of detected) {
    assert.ok(extract(tile.image).bands.length >= 2);
  }
});

function calibrate(library) {
  for (const notation of ["123456789m", "123456789p", "123456789s", "1234567z"]) {
    const entry = find(notation, 7);
    const detected = detectTiles(loadImage(entry));
    assert.equal(detected.length, entry.tiles.length);
    detected.forEach((crop, i) => library.add(entry.tiles[i], extract(crop.image)));
  }
}

test("ライブラリの保存と読み込み", { skip }, async () => {
  const library = new TileLibrary();
  calibrate(library);
  assert.deepEqual(library.missing(), []);
  await library.save();

  const reloaded = new TileLibrary(library.storage);
  await reloaded.load();
  assert.equal(reloaded.size, library.size);
  assert.deepEqual(reloaded.missing(), []);
});

test("登録すると規則ベースより明確に当たる", { skip }, () => {
  const library = new TileLibrary();
  calibrate(library);

  let without = 0;
  let withLibrary = 0;
  let total = 0;

  for (const notation of ["234567m234567p33s", "1133m5588p224477s", "19m19p19s1234567z"]) {
    const entry = find(notation, 3);
    const image = loadImage(entry);
    const plain = recognize(image, null).guesses.map((g) => g.tile);
    const learned = recognize(image, library).guesses.map((g) => g.tile);
    assert.equal(plain.length, entry.tiles.length);

    total += entry.tiles.length;
    entry.tiles.forEach((expected, i) => {
      if (plain[i] === expected) without += 1;
      if (learned[i] === expected) withLibrary += 1;
    });
  }

  assert.ok(withLibrary > without, `登録しても改善していない (${without} → ${withLibrary})`);
  assert.ok(withLibrary / total >= 0.95, `登録後の正解率が低い: ${withLibrary}/${total}`);
});

test("登録済みなら自信ありとして返す", { skip }, () => {
  const library = new TileLibrary();
  calibrate(library);
  const result = recognize(loadImage(find("123456789p", 3)), library);
  assert.equal(result.uncertainCount, 0);
  assert.ok(result.guesses.every((g) => g.source === "library"));
});

test("未登録なら数牌は自信なしとして扱う", { skip }, () => {
  const result = recognize(loadImage(find("123456789s", 3)), null);
  assert.ok(result.uncertainCount > 0);
});

test("全ケースで Python 版と同じ精度が出る", { skip }, () => {
  const library = new TileLibrary();
  calibrate(library);

  let correct = 0;
  let total = 0;
  const errors = [];
  for (const entry of index.filter((e) => e.seed === 3)) {
    const guesses = recognize(loadImage(entry), library).guesses;
    assert.equal(guesses.length, entry.tiles.length, entry.notation);
    entry.tiles.forEach((expected, i) => {
      total += 1;
      if (guesses[i].tile === expected) correct += 1;
      else errors.push(`${entry.notation}: ${tileName(expected)}→${guesses[i].name ?? "?"}`);
    });
  }
  assert.ok(correct / total >= 0.95, `正解率 ${correct}/${total}\n${errors.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 同梱の初期ライブラリ
// ---------------------------------------------------------------------------

function loadPrior() {
  const meta = JSON.parse(fs.readFileSync("webapp/vision/prior-library.json", "utf8"));
  const bin = fs.readFileSync("webapp/vision/prior-library.bin");
  return buildPriorLibrary(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
}

test("初期ライブラリが同梱されていて 34 種そろっている", { skip }, () => {
  const prior = loadPrior();
  assert.deepEqual(prior.missing(), []);
  assert.ok(prior.size > 0);
});

test("登録なしでも初期ライブラリで大幅に当たる", { skip }, () => {
  const prior = loadPrior();
  let rulesOnly = 0;
  let withPrior = 0;
  let total = 0;

  for (const entry of index.filter((e) => e.seed === 3)) {
    const image = loadImage(entry);
    const rules = recognize(image, null, null).guesses.map((g) => g.tile);
    const primed = recognize(image, null, prior).guesses.map((g) => g.tile);
    if (rules.length !== entry.tiles.length) continue;
    total += entry.tiles.length;
    entry.tiles.forEach((expected, i) => {
      if (rules[i] === expected) rulesOnly += 1;
      if (primed[i] === expected) withPrior += 1;
    });
  }

  assert.ok(withPrior > rulesOnly, `初期ライブラリが効いていない (${rulesOnly} → ${withPrior})`);
  assert.ok(withPrior / total >= 0.90, `初期ライブラリでの正解率が低い: ${withPrior}/${total}`);
});

test("Python 版と JS 版で初期ライブラリの中身が一致する", { skip }, () => {
  const meta = JSON.parse(fs.readFileSync("webapp/vision/prior-library.json", "utf8"));
  const bin = fs.readFileSync("webapp/vision/prior-library.bin");
  const expected = Object.values(meta.counts).reduce((a, b) => a + b, 0) * meta.dims;
  assert.equal(bin.length, expected, "バイト数がメタ情報と合っていません");
});
