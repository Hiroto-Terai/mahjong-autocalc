// ブラウザだけで完結する画面。サーバーとの通信は一切しない。

import {
  EAST, NUM_TILE_KINDS, HandTiles, Meld, MeldType,
  doraIndicatorToDora, tileName,
} from "./engine/tiles.js";
import {
  NoYakuError, NotWinningHandError, calculate, makeContext,
} from "./engine/scoring.js";
import { IndexedDbStorage, TileLibrary } from "./vision/library.js";

const WINDS = [
  { tile: 27, name: "東" }, { tile: 28, name: "南" },
  { tile: 29, name: "西" }, { tile: 30, name: "北" },
];

const FLAGS = [
  { key: "isRiichi", label: "立直" },
  { key: "isDoubleRiichi", label: "ダブル立直" },
  { key: "isIppatsu", label: "一発" },
  { key: "isHaitei", label: "海底摸月" },
  { key: "isHoutei", label: "河底撈魚" },
  { key: "isRinshan", label: "嶺上開花" },
  { key: "isChankan", label: "搶槓" },
  { key: "isTenhou", label: "天和" },
  { key: "isChiihou", label: "地和" },
];

const MELD_TYPES = [
  { value: "hand", label: "手牌" },
  { value: MeldType.CHII, label: "チー" },
  { value: MeldType.PON, label: "ポン" },
  { value: MeldType.OPEN_KAN, label: "明カン" },
  { value: MeldType.CLOSED_KAN, label: "暗カン" },
];

const RED_FIVES = [4, 13, 22];
const MAX_IMAGE_SIDE = 2000;

const state = {
  tiles: [],        // { index, tile, face, descriptor, uncertain, group, isWin, isRed }
  groupTypes: {},
  roundWind: EAST,
  seatWind: EAST,
  isTsumo: false,
  flags: {},
  dora: [],
  ura: [],
};

const $ = (id) => document.getElementById(id);

let library = null;
let worker = null;
let nextJobId = 1;
const pendingJobs = new Map();

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function init() {
  library = await TileLibrary.open(new IndexedDbStorage());

  startWorker();

  buildWindSelector($("round-wind"), "roundWind");
  buildWindSelector($("seat-wind"), "seatWind");
  buildFlags();
  bindWinType();
  bindUpload();

  $("calculate").addEventListener("click", calculateScore);
  $("learn-button").addEventListener("click", learn);
  $("picker-close").addEventListener("click", closePicker);
  $("picker").addEventListener("click", (e) => { if (e.target.id === "picker") closePicker(); });

  document.querySelectorAll("[data-add-dora]").forEach((button) => {
    button.addEventListener("click", () => addDora(button.dataset.addDora));
  });

  $("library-button").addEventListener("click", openLibrary);
  $("library-close").addEventListener("click", () => { $("library-modal").hidden = true; });
  $("library-reset").addEventListener("click", resetLibrary);

  updateCalibrationBanner();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("./sw.js", import.meta.url)).catch(() => {});
  }
}

/**
 * 認識用の Worker を起動する。
 *
 * モジュール Worker は古い iOS Safari (16.4 未満) が対応していない。使えない
 * 場合はメインスレッドで動かす。画面が一瞬固まるだけで、結果は変わらない。
 */
function startWorker() {
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const job = pendingJobs.get(event.data.id);
      if (!job) return;
      pendingJobs.delete(event.data.id);
      if (event.data.ok) job.resolve(event.data.result);
      else job.reject(new Error(event.data.error));
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
}

/** Worker が使えない環境向けに、同じ処理をメインスレッドで行う。 */
async function recognizeOnMainThread(image, samples) {
  const [{ recognize }, { TileLibrary }] = await Promise.all([
    import("./vision/pipeline.js"),
    import("./vision/library.js"),
  ]);

  let localLibrary = null;
  if (Object.keys(samples).length) {
    localLibrary = new TileLibrary();
    localLibrary.samples = new Map(
      Object.entries(samples).map(([tile, vectors]) => [
        Number(tile),
        vectors.map((v) => Float32Array.from(v)),
      ])
    );
  }

  const result = recognize(image, localLibrary);
  return {
    guesses: result.guesses.map((g) => ({
      index: g.index,
      tile: g.tile,
      name: g.name,
      confidence: g.confidence,
      source: g.source,
      group: g.group,
      uncertain: g.uncertain,
      alternatives: g.alternatives,
      face: { width: g.face.width, height: g.face.height, data: g.face.data },
      descriptor: g.features.descriptor,
    })),
    count: result.count,
    uncertainCount: result.uncertainCount,
    librarySize: result.librarySize,
  };
}

function updateCalibrationBanner() {
  $("calibration-banner").hidden = library.missing().length === 0;
}

function buildWindSelector(container, key) {
  container.innerHTML = "";
  WINDS.forEach((wind) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = wind.name;
    button.className = state[key] === wind.tile ? "active" : "";
    button.addEventListener("click", () => {
      state[key] = wind.tile;
      buildWindSelector(container, key);
    });
    container.appendChild(button);
  });
}

function buildFlags() {
  const container = $("flags");
  container.innerHTML = "";
  FLAGS.forEach((flag) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      state.flags[flag.key] = input.checked;
      $("ura-field").hidden = !(state.flags.isRiichi || state.flags.isDoubleRiichi);
    });
    label.append(input, document.createTextNode(flag.label));
    container.appendChild(label);
  });
}

function bindWinType() {
  $("win-type").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.isTsumo = button.dataset.value === "tsumo";
      $("win-type").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// 画像の読み込みと認識
// ---------------------------------------------------------------------------

function bindUpload() {
  const zone = $("dropzone");

  // カメラ用とアルバム用で input を分ける。capture 付きの input は
  // スマホでカメラを直接開いてしまい、アルバムから選べないため。
  [["pick-camera", "camera-input"], ["pick-album", "album-input"]].forEach(
    ([buttonId, inputId]) => {
      const input = $(inputId);
      $(buttonId).addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        if (input.files && input.files[0]) handleImage(input.files[0]);
        input.value = "";  // 同じ写真をもう一度選んでも change が起きるように
      });
    }
  );

  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add("over"); })
  );
  ["dragleave", "drop"].forEach((type) =>
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove("over"); })
  );
  zone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleImage(file);
  });

  // 貼り付けでも読めるようにしておく (PC で便利)。
  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (item) handleImage(item.getAsFile());
  });
}

/** <img> 経由で読み込む。createImageBitmap が使えない環境や HEIC 向けの逃げ道。 */
function loadViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像は読み込めませんでした。JPEG か PNG で試してください"));
    };
    image.src = url;
  });
}

/** ファイルを描画できるものにする。 */
async function loadDrawable(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // アルバムの写真は EXIF に回転情報を持つことがある。反映させないと
      // 牌が横倒しのまま渡ってしまうので from-image を明示する。
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        // HEIC など createImageBitmap が扱えない形式は <img> に任せる。
      }
    }
  }
  return loadViaImageElement(file);
}

/** 写真を読み込んで RGB の生データにする。大きすぎる画像はここで縮める。 */
async function decodeImage(file) {
  const bitmap = await loadDrawable(file);
  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("画像のサイズを取得できませんでした");

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  // OffscreenCanvas も古い Safari には無いので、通常の canvas に落とす。
  let canvas;
  if (typeof OffscreenCanvas === "function") {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();


  const rgba = context.getImageData(0, 0, width, height).data;
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    data[j] = rgba[i];
    data[j + 1] = rgba[i + 1];
    data[j + 2] = rgba[i + 2];
  }
  return { width, height, channels: 3, data };
}

function runRecognition(image) {
  const samples = {};
  for (const [tile, vectors] of library.samples) {
    samples[tile] = vectors.map((v) => Array.from(v));
  }
  if (!worker) return recognizeOnMainThread(image, samples);

  return new Promise((resolve, reject) => {
    const id = nextJobId;
    nextJobId += 1;
    pendingJobs.set(id, { resolve, reject });
    worker.postMessage({ id, image, library: samples }, [image.data.buffer]);
  });
}

async function handleImage(file) {
  setStatus("upload-status", "読み込み中...", "");
  $("preview").src = URL.createObjectURL(file);
  $("preview-wrap").hidden = false;

  let result;
  try {
    const image = await decodeImage(file);
    setStatus("upload-status", "認識中...", "");
    result = await runRecognition(image);
  } catch (error) {
    setStatus("upload-status", error.message, "error");
    return;
  }

  state.groupTypes = {};
  state.tiles = result.guesses.map((g) => ({
    index: g.index,
    tile: g.tile,
    face: g.face,
    descriptor: g.descriptor,
    uncertain: g.uncertain,
    group: g.group,
    isWin: false,
    isRed: false,
  }));

  // 一番後ろの牌を和了牌の初期値にしておく。
  if (state.tiles.length) state.tiles[state.tiles.length - 1].isWin = true;

  const note = result.librarySize === 0
    ? " 牌をまだ覚えていないので、直したうえで「覚えさせる」を押すと次から精度が上がります。"
    : "";
  setStatus(
    "upload-status",
    `${result.count} 枚を検出しました。` +
    `${result.uncertainCount ? `${result.uncertainCount} 枚は自信なしです。` : ""}${note}`,
    result.uncertainCount ? "" : "ok"
  );

  renderTiles();
  $("tiles-card").hidden = false;
  $("context-card").hidden = false;
}

// ---------------------------------------------------------------------------
// 牌の表示と修正
// ---------------------------------------------------------------------------

function renderTiles() {
  const container = $("groups");
  container.innerHTML = "";

  const groups = [...new Set(state.tiles.map((t) => t.group))];
  groups.forEach((group) => {
    const tiles = state.tiles.filter((t) => t.group === group);
    const wrap = document.createElement("div");
    wrap.className = "group";

    const head = document.createElement("div");
    head.className = "group-head";
    head.append(document.createTextNode(`かたまり ${group + 1} (${tiles.length} 枚)`));

    if (tiles.length === 3 || tiles.length === 4) {
      const select = document.createElement("select");
      MELD_TYPES
        .filter((m) => (tiles.length === 4
          ? m.value === "hand" || m.value.includes("kan")
          : m.value === "hand" || m.value === MeldType.CHII || m.value === MeldType.PON))
        .forEach((meld) => {
          const option = document.createElement("option");
          option.value = meld.value;
          option.textContent = meld.label;
          select.appendChild(option);
        });
      select.value = state.groupTypes[group] || "hand";
      select.addEventListener("change", () => { state.groupTypes[group] = select.value; });
      head.appendChild(select);
    }
    wrap.appendChild(head);

    const row = document.createElement("div");
    row.className = "tile-row";
    tiles.forEach((tile) => row.appendChild(renderTile(tile)));
    wrap.appendChild(row);
    container.appendChild(wrap);
  });
}

function faceCanvas(face) {
  const canvas = document.createElement("canvas");
  canvas.width = face.width;
  canvas.height = face.height;
  const rgba = new Uint8ClampedArray(face.width * face.height * 4);
  for (let p = 0, i = 0, o = 0; p < face.width * face.height; p += 1, i += 3, o += 4) {
    rgba[o] = face.data[i];
    rgba[o + 1] = face.data[i + 1];
    rgba[o + 2] = face.data[i + 2];
    rgba[o + 3] = 255;
  }
  canvas.getContext("2d").putImageData(new ImageData(rgba, face.width, face.height), 0, 0);
  return canvas;
}

function renderTile(tile) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  if (tile.uncertain) button.classList.add("uncertain");
  if (tile.isWin) button.classList.add("win");

  button.appendChild(faceCanvas(tile.face));

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = tile.tile === null ? "?" : tileName(tile.tile);
  button.appendChild(name);

  if (tile.isWin) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "和";
    button.appendChild(badge);
  }
  if (tile.isRed) {
    const badge = document.createElement("span");
    badge.className = "badge red";
    badge.textContent = "赤";
    button.appendChild(badge);
  }

  button.addEventListener("click", () => openPicker(tile));
  return button;
}

// ---------------------------------------------------------------------------
// 牌を選ぶモーダル
// ---------------------------------------------------------------------------

function openPicker(tile) {
  $("picker-title").textContent = "牌を選び直す";
  renderPickerGrid(tile.tile, (id) => {
    tile.tile = id;
    tile.uncertain = false;
    closePicker();
    renderTiles();
  });

  const extra = $("picker-extra");
  extra.innerHTML = "";
  extra.appendChild(makeExtraButton(tile.isWin ? "和了牌を解除" : "この牌で和了", () => {
    const next = !tile.isWin;
    state.tiles.forEach((t) => { t.isWin = false; });
    tile.isWin = next;
    closePicker();
    renderTiles();
  }));
  if (tile.tile !== null && RED_FIVES.includes(tile.tile)) {
    extra.appendChild(makeExtraButton(tile.isRed ? "赤ドラを解除" : "赤ドラにする", () => {
      tile.isRed = !tile.isRed;
      closePicker();
      renderTiles();
    }));
  }
  extra.appendChild(makeExtraButton("この牌を削除", () => {
    state.tiles = state.tiles.filter((t) => t !== tile);
    closePicker();
    renderTiles();
  }));

  $("picker").hidden = false;
}

function makeExtraButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost small";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderPickerGrid(current, onPick) {
  const grid = $("picker-grid");
  grid.innerHTML = "";
  for (let tile = 0; tile < NUM_TILE_KINDS; tile += 1) {
    if (tile > 0 && tile % 9 === 0 && tile <= 27) {
      const line = document.createElement("div");
      line.className = "suit-break";
      grid.appendChild(line);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tileName(tile);
    if (tile === current) button.classList.add("current");
    button.addEventListener("click", () => onPick(tile));
    grid.appendChild(button);
  }
}

function closePicker() {
  $("picker").hidden = true;
}

// ---------------------------------------------------------------------------
// ドラ
// ---------------------------------------------------------------------------

function addDora(kind) {
  $("picker-title").textContent = kind === "dora" ? "ドラ表示牌を選ぶ" : "裏ドラ表示牌を選ぶ";
  $("picker-extra").innerHTML = "";
  renderPickerGrid(null, (id) => {
    state[kind === "dora" ? "dora" : "ura"].push(id);
    closePicker();
    renderDora();
  });
  $("picker").hidden = false;
}

function renderDora() {
  [["dora", "dora-list"], ["ura", "ura-list"]].forEach(([key, elementId]) => {
    const container = $(elementId);
    container.innerHTML = "";
    state[key].forEach((tile, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.append(document.createTextNode(`${tileName(tile)} → ${tileName(doraIndicatorToDora(tile))}`));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        state[key].splice(i, 1);
        renderDora();
      });
      chip.appendChild(remove);
      container.appendChild(chip);
    });
  });
}

// ---------------------------------------------------------------------------
// 学習
// ---------------------------------------------------------------------------

async function learn() {
  const targets = state.tiles.filter((t) => t.tile !== null);
  if (!targets.length) return;

  setStatus("learn-status", "登録中...", "");
  try {
    let learned = 0;
    for (const tile of targets) {
      if (library.add(tile.tile, { descriptor: tile.descriptor })) learned += 1;
    }
    await library.save();
    updateCalibrationBanner();
    setStatus(
      "learn-status",
      `${learned} 枚を登録しました (合計 ${library.size} 件、未登録 ${library.missing().length} 種)`,
      "ok"
    );
  } catch (error) {
    setStatus("learn-status", error.message, "error");
  }
}

// ---------------------------------------------------------------------------
// 計算
// ---------------------------------------------------------------------------

function buildHandAndContext() {
  const winTile = state.tiles.find((t) => t.isWin);
  if (!winTile || winTile.tile === null) throw new Error("和了牌を 1 枚指定してください");
  if (state.tiles.some((t) => t.tile === null)) throw new Error("認識できていない牌があります");

  const concealed = [];
  const melds = [];
  const redFives = [];

  for (const group of [...new Set(state.tiles.map((t) => t.group))]) {
    const tiles = state.tiles.filter((t) => t.group === group);
    const kind = state.groupTypes[group] || "hand";
    const reds = tiles.filter((t) => t.isRed).map((t) => t.tile);
    if (kind === "hand") {
      tiles.forEach((t) => concealed.push(t.tile));
      redFives.push(...reds);
    } else {
      melds.push(new Meld(kind, tiles.map((t) => t.tile), reds));
    }
  }

  if (!concealed.includes(winTile.tile)) {
    throw new Error("和了牌は手牌 (副露していないかたまり) の中から選んでください");
  }

  const context = makeContext({
    roundWind: state.roundWind,
    seatWind: state.seatWind,
    isTsumo: state.isTsumo,
    isRiichi: !!state.flags.isRiichi,
    isDoubleRiichi: !!state.flags.isDoubleRiichi,
    isIppatsu: !!state.flags.isIppatsu,
    isHaitei: !!state.flags.isHaitei,
    isHoutei: !!state.flags.isHoutei,
    isRinshan: !!state.flags.isRinshan,
    isChankan: !!state.flags.isChankan,
    isTenhou: !!state.flags.isTenhou,
    isChiihou: !!state.flags.isChiihou,
    doraIndicators: state.dora,
    uraIndicators: state.ura,
    honba: Number($("honba").value) || 0,
    riichiSticks: Number($("sticks").value) || 0,
    rules: {
      allowKuitan: $("rule-kuitan").checked,
      kiriageMangan: $("rule-kiriage").checked,
      doubleYakuman: $("rule-double-yakuman").checked,
      multipleYakuman: $("rule-multi-yakuman").checked,
      doubleWindPairFu: Number($("rule-double-wind").value),
    },
  });

  return { hand: new HandTiles(concealed, melds, redFives), winTile: winTile.tile, context };
}

function calculateScore() {
  let calc;
  try {
    const { hand, winTile, context } = buildHandAndContext();
    calc = calculate(hand, winTile, context);
  } catch (error) {
    const message = error instanceof NotWinningHandError || error instanceof NoYakuError
      ? error.message
      : error.message;
    setStatus("calc-status", message, "error");
    $("result-card").hidden = true;
    return;
  }
  setStatus("calc-status", "", "");
  renderResult(calc);
}

function renderResult(calc) {
  const container = $("result");
  container.innerHTML = "";

  const headline = document.createElement("div");
  headline.className = "headline";

  const points = document.createElement("span");
  points.className = "points";
  points.textContent = `${calc.score.payments.total.toLocaleString()} 点`;
  headline.appendChild(points);

  const hanfu = document.createElement("span");
  hanfu.className = "hanfu";
  hanfu.textContent = calc.score.yakuman
    ? `役満 ×${calc.score.yakuman}`
    : `${calc.score.fu} 符 ${calc.score.han} 翻`;
  headline.appendChild(hanfu);

  if (calc.score.limitName) {
    const limit = document.createElement("span");
    limit.className = "limit";
    limit.textContent = calc.score.limitName;
    headline.appendChild(limit);
  }
  container.appendChild(headline);

  container.appendChild(section("内訳", [describePayment(calc)]));

  const items = calc.yaku.map((y) => ({
    label: y.name,
    value: y.yakuman ? (y.yakuman > 1 ? "ダブル役満" : "役満") : `${y.han} 翻`,
    highlight: !!y.yakuman,
  }));
  calc.dora.forEach((d) => items.push({ label: d.name, value: `${d.han} 翻` }));
  container.appendChild(listSection("役", items));

  if (!calc.score.yakuman) {
    container.appendChild(listSection(
      `符 (${calc.fuResult.rawFu} 符 → 切り上げ ${calc.fuResult.fu} 符)`,
      calc.fuResult.details.map((d) => ({ label: d.label, value: `${d.fu} 符` }))
    ));
  }

  const shape = document.createElement("p");
  shape.className = "shape";
  shape.textContent = `面子構成: ${calc.handShape}`;
  container.appendChild(section("採用した形", [shape]));

  $("result-card").hidden = false;
  $("result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function describePayment(calc) {
  const p = calc.score.payments;
  const parts = [];
  if (calc.context.isTsumo) {
    if (calc.context.isDealer) {
      parts.push(`子 各 ${p.fromEachNonDealer.toLocaleString()} 点`);
    } else {
      parts.push(`親 ${p.fromDealer.toLocaleString()} 点`);
      parts.push(`子 各 ${p.fromEachNonDealer.toLocaleString()} 点`);
    }
  } else {
    parts.push(`放銃者から ${p.fromDiscarder.toLocaleString()} 点`);
  }
  if (p.riichiSticks) parts.push(`供託 ${p.riichiSticks.toLocaleString()} 点`);

  const element = document.createElement("p");
  element.className = "shape";
  element.textContent = parts.join(" ／ ");
  return element;
}

function section(title, children) {
  const fragment = document.createDocumentFragment();
  const heading = document.createElement("h3");
  heading.textContent = title;
  fragment.appendChild(heading);
  children.forEach((child) => fragment.appendChild(child));
  return fragment;
}

function listSection(title, items) {
  const list = document.createElement("ul");
  items.forEach((item) => {
    const li = document.createElement("li");
    if (item.highlight) li.className = "yakuman-row";
    const label = document.createElement("span");
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "han";
    value.textContent = item.value;
    li.append(label, value);
    list.appendChild(li);
  });
  return section(title, [list]);
}

// ---------------------------------------------------------------------------
// ライブラリ
// ---------------------------------------------------------------------------

function openLibrary() {
  const body = $("library-body");
  body.innerHTML = "";
  const missing = library.missing();

  const summary = document.createElement("p");
  summary.textContent = `登録済み ${library.size} 件 / 未登録 ${missing.length} 種`;
  body.appendChild(summary);

  const detail = document.createElement("p");
  if (missing.length) {
    detail.className = "missing";
    detail.textContent = "未登録: " + missing.map(tileName).join(" ");
  } else {
    detail.textContent = "34 種すべて登録済みです。";
  }
  body.appendChild(detail);

  const note = document.createElement("p");
  note.className = "shape";
  note.textContent = "この端末のブラウザ内 (IndexedDB) にのみ保存されます。";
  body.appendChild(note);

  $("library-modal").hidden = false;
}

async function resetLibrary() {
  if (!confirm("登録した牌のデータをすべて削除します。よろしいですか?")) return;
  library.clear();
  await library.save();
  updateCalibrationBanner();
  openLibrary();
}

// ---------------------------------------------------------------------------

function setStatus(id, message, kind) {
  const element = $(id);
  element.textContent = message;
  element.className = "status" + (kind ? ` ${kind}` : "");
}

init();
