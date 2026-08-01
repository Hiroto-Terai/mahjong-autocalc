// ブラウザだけで完結する画面。サーバーとの通信は一切しない。

import {
  EAST, NUM_TILE_KINDS, HandTiles, Meld, MeldType,
  doraIndicatorToDora, parseTiles, tileName,
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
  tiles: [],          // { index, tile, face, descriptor, uncertain, group, isWin, isRed }
  quads: [],          // 検出した牌の四隅 (重ね表示用)
  source: null,       // EXIF 補正・縮小済みの元画像 (canvas)
  rotation: 0,        // 表示・認識に適用する回転 (0/90/180/270)
  zoom: 1,
  decodedSize: null,  // 回転後の、実際に認識にかける大きさ
  regions: [],        // 指定した範囲 [{ quad: [[x,y]x4], count }]
  activeRegion: 0,
  manualMode: false,
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

  $("show-overlay").addEventListener("change", drawOverlay);
  $("manual-toggle").addEventListener("click", () => setManualMode(!state.manualMode));
  $("manual-clear").addEventListener("click", () => {
    state.regions = [];
    renderManualRegions();
    drawOverlay();
  });
  $("manual-apply").addEventListener("click", applyManualRegions);
  $("manual-add").addEventListener("click", () => addRegion());
  $("rotate-left").addEventListener("click", () => rotateStage(-90));
  $("rotate-right").addEventListener("click", () => rotateStage(90));
  $("zoom-in").addEventListener("click", () => setZoom(nextZoom(1)));
  $("zoom-out").addEventListener("click", () => setZoom(nextZoom(-1)));
  $("zoom-fit").addEventListener("click", () => setZoom(1));
  $("preview-scroll").addEventListener("scroll", drawOverlay, { passive: true });
  buildBulkPresets();
  $("bulk-apply").addEventListener("click", () => applyBulk($("bulk-notation").value.trim()));
  bindStageInteraction();
  window.addEventListener("resize", applyZoom);

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
async function recognizeOnMainThread(image, samples, regions = null) {
  const [{ recognize, recognizeRegions }, { TileLibrary }] = await Promise.all([
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

  const result = regions && regions.length
    ? recognizeRegions(image, regions, localLibrary)
    : recognize(image, localLibrary);
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
      quad: g.quad,
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

/** 写真を canvas に読み込む。EXIF の回転を反映し、大きすぎる画像は縮める。 */
async function decodeToCanvas(file) {
  const bitmap = await loadDrawable(file);
  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("画像のサイズを取得できませんでした");

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/** いま画面に出ている (回転済みの) 画像を、認識にかける形で取り出す。 */
function currentImage() {
  const canvas = $("preview");
  const rgba = canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    data[j] = rgba[i];
    data[j + 1] = rgba[i + 1];
    data[j + 2] = rgba[i + 2];
  }
  return { width: canvas.width, height: canvas.height, channels: 3, data };
}

function runRecognition(image, regions = null) {
  const samples = {};
  for (const [tile, vectors] of library.samples) {
    samples[tile] = vectors.map((v) => Array.from(v));
  }
  if (!worker) return recognizeOnMainThread(image, samples, regions);

  return new Promise((resolve, reject) => {
    const id = nextJobId;
    nextJobId += 1;
    pendingJobs.set(id, { resolve, reject });
    worker.postMessage({ id, image, library: samples, regions }, [image.data.buffer]);
  });
}

async function handleImage(file) {
  setStatus("upload-status", "読み込み中...", "");
  state.regions = [];
  state.activeRegion = 0;
  state.rotation = 0;
  state.zoom = 1;
  renderManualRegions();
  $("preview-wrap").hidden = false;

  let result;
  try {
    state.source = await decodeToCanvas(file);
    renderStage();
    setStatus("upload-status", "認識中...", "");
    result = await runRecognition(currentImage());
  } catch (error) {
    // 自動検出が失敗しても、範囲を指定すれば読めるので導線を出しておく。
    setStatus("upload-status", `${error.message} 「範囲を指定して読む」から囲んでください。`, "error");
    setManualMode(true);
    return;
  }
  applyResult(result, { manual: false });
}

/** 認識結果を画面に反映する。自動検出と手動指定で共通。 */
function applyResult(result, { manual }) {
  state.groupTypes = {};
  state.quads = result.guesses.map((g) => g.quad);
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
  const head = manual ? "指定した範囲から" : "";
  setStatus(
    "upload-status",
    `${head}${result.count} 枚を読み込みました。` +
    `${result.uncertainCount ? `${result.uncertainCount} 枚は自信なしです。` : ""}${note}`,
    result.uncertainCount ? "" : "ok"
  );

  renderTiles();
  drawOverlay();
  // まだ牌を覚えていないなら、一括指定を最初から開いておく。
  $("bulk-panel").open = library.missing().length > 0;
  setStatus("bulk-status", "", "");
  $("tiles-card").hidden = false;
  $("context-card").hidden = false;
}

// ---------------------------------------------------------------------------
// 画像ステージ (回転・ズーム)
// ---------------------------------------------------------------------------

const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6];

function nextZoom(direction) {
  const index = ZOOM_STEPS.findIndex((z) => z >= state.zoom - 1e-6);
  const target = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  return ZOOM_STEPS[target];
}

/** 回転を反映して #preview に描き、大きさとズームを整える。 */
function renderStage() {
  const source = state.source;
  if (!source) return;

  const turned = state.rotation % 180 !== 0;
  const width = turned ? source.height : source.width;
  const height = turned ? source.width : source.height;

  const preview = $("preview");
  preview.width = width;
  preview.height = height;
  const context = preview.getContext("2d");
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((state.rotation * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  context.restore();

  state.decodedSize = { width, height };
  applyZoom();
}

function applyZoom() {
  const scroll = $("preview-scroll");
  const stage = $("preview-stage");
  const preview = $("preview");
  if (!state.decodedSize) return;

  // ズーム 1 倍 = 横幅いっぱいに収まる大きさ。
  const fitWidth = scroll.clientWidth || scroll.getBoundingClientRect().width;
  const displayWidth = Math.max(1, fitWidth * state.zoom);
  const displayHeight = displayWidth * (state.decodedSize.height / state.decodedSize.width);

  stage.style.width = `${displayWidth}px`;
  stage.style.height = `${displayHeight}px`;
  preview.style.width = `${displayWidth}px`;
  preview.style.height = `${displayHeight}px`;

  $("zoom-value").textContent = `${Math.round(state.zoom * 100)}%`;
  drawOverlay();
}

function setZoom(next, anchor) {
  const scroll = $("preview-scroll");
  const before = state.zoom;
  state.zoom = Math.min(6, Math.max(1, next));
  if (state.zoom === before) return;

  // 拡大しても、いま見ている位置が画面の外に飛ばないようにする。
  const centerX = (scroll.scrollLeft + (anchor?.x ?? scroll.clientWidth / 2)) / before;
  const centerY = (scroll.scrollTop + (anchor?.y ?? scroll.clientHeight / 2)) / before;
  applyZoom();
  scroll.scrollLeft = centerX * state.zoom - (anchor?.x ?? scroll.clientWidth / 2);
  scroll.scrollTop = centerY * state.zoom - (anchor?.y ?? scroll.clientHeight / 2);
}

/** 画像を回して、指定済みの範囲も一緒に回す。 */
function rotateStage(delta) {
  if (!state.source) return;
  const before = state.decodedSize;
  state.rotation = (((state.rotation + delta) % 360) + 360) % 360;

  const turn = ((delta % 360) + 360) % 360;
  state.regions.forEach((region) => {
    region.quad = region.quad.map(([x, y]) => {
      if (turn === 90) return [before.height - y, x];
      if (turn === 180) return [before.width - x, before.height - y];
      if (turn === 270) return [y, before.width - x];
      return [x, y];
    });
  });
  // 認識済みの結果は回転前の座標なので、重ね表示を消しておく。
  state.quads = [];
  renderStage();
}

// ---------------------------------------------------------------------------
// 範囲の指定 (自由な四角形)
// ---------------------------------------------------------------------------

const HANDLE_HIT_PX = 26;

/** 表示座標 → 認識にかける画像の座標。 */
function toImageCoords(clientX, clientY) {
  const rect = $("preview").getBoundingClientRect();
  const scale = state.decodedSize.width / rect.width;
  return [
    Math.max(0, Math.min(state.decodedSize.width, (clientX - rect.left) * scale)),
    Math.max(0, Math.min(state.decodedSize.height, (clientY - rect.top) * scale)),
  ];
}

/** 画像座標 → 表示座標。 */
function toDisplayCoords([x, y]) {
  const rect = $("preview").getBoundingClientRect();
  const scale = rect.width / state.decodedSize.width;
  return [x * scale, y * scale];
}

function defaultQuad() {
  const { width, height } = state.decodedSize;
  const x0 = width * 0.10;
  const x1 = width * 0.90;
  const y0 = height * 0.35;
  const y1 = height * 0.65;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function rectToQuad([x0, y0, x1, y1]) {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** 四角形の縦横比から枚数の初期値を出す。 */
function estimateCountForQuad(quad) {
  const side = (a, b) => Math.hypot(quad[b][0] - quad[a][0], quad[b][1] - quad[a][1]);
  const long = Math.max((side(0, 1) + side(3, 2)) / 2, (side(0, 3) + side(1, 2)) / 2);
  const short = Math.min((side(0, 1) + side(3, 2)) / 2, (side(0, 3) + side(1, 2)) / 2);
  if (short <= 0) return 1;
  return Math.max(1, Math.min(18, Math.round((long / short) / (64 / 88))));
}

function addRegion(quad) {
  const shape = quad ?? defaultQuad();
  state.regions.push({ quad: shape, count: estimateCountForQuad(shape) });
  state.activeRegion = state.regions.length - 1;
  renderManualRegions();
  drawOverlay();
}

function bindStageInteraction() {
  const stage = $("preview-stage");
  let mode = null;      // "handle" | "draw"
  let handleIndex = -1;
  let drawStart = null;

  const findHandle = (clientX, clientY) => {
    const region = state.regions[state.activeRegion];
    if (!region) return -1;
    const rect = $("preview").getBoundingClientRect();
    for (let i = 0; i < 4; i += 1) {
      const [dx, dy] = toDisplayCoords(region.quad[i]);
      if (Math.hypot(rect.left + dx - clientX, rect.top + dy - clientY) <= HANDLE_HIT_PX) return i;
    }
    return -1;
  };

  stage.addEventListener("pointerdown", (e) => {
    if (!state.manualMode || !state.decodedSize) return;
    handleIndex = findHandle(e.clientX, e.clientY);
    if (handleIndex >= 0) {
      mode = "handle";
    } else {
      mode = "draw";
      drawStart = toImageCoords(e.clientX, e.clientY);
      state.dragRect = null;
    }
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    if (mode === "handle") showLoupe(e.clientX, e.clientY);
  });

  stage.addEventListener("pointermove", (e) => {
    if (!mode) return;
    e.preventDefault();
    if (mode === "handle") {
      state.regions[state.activeRegion].quad[handleIndex] = toImageCoords(e.clientX, e.clientY);
      showLoupe(e.clientX, e.clientY);
    } else {
      const now = toImageCoords(e.clientX, e.clientY);
      state.dragRect = [
        Math.min(drawStart[0], now[0]), Math.min(drawStart[1], now[1]),
        Math.max(drawStart[0], now[0]), Math.max(drawStart[1], now[1]),
      ];
    }
    drawOverlay();
  });

  const finish = (e) => {
    if (!mode) return;
    if (stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    hideLoupe();

    if (mode === "draw") {
      const rect = state.dragRect;
      state.dragRect = null;
      const minSide = state.decodedSize.width * 0.03;
      if (rect && rect[2] - rect[0] >= minSide && rect[3] - rect[1] >= minSide) {
        addRegion(rectToQuad(rect));
      }
    } else {
      // 枚数は利用者が合わせた値なので、隅を動かしても勝手に変えない。
      renderManualRegions();
    }
    mode = null;
    handleIndex = -1;
    drawStart = null;
    drawOverlay();
  };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
}

/** 指で隠れる位置を拡大して見せる。4 隅を正確に合わせるために要る。 */
function showLoupe(clientX, clientY) {
  const loupe = $("loupe");
  const preview = $("preview");
  const rect = preview.getBoundingClientRect();
  const size = 108;
  const magnify = 3;

  loupe.hidden = false;
  loupe.width = size;
  loupe.height = size;

  const [ix, iy] = toImageCoords(clientX, clientY);
  const displayScale = rect.width / state.decodedSize.width;
  const half = size / (2 * magnify * displayScale);

  const context = loupe.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = false;
  context.drawImage(preview, ix - half, iy - half, half * 2, half * 2, 0, 0, size, size);

  context.strokeStyle = "#4c9ae8";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(size / 2, 0); context.lineTo(size / 2, size);
  context.moveTo(0, size / 2); context.lineTo(size, size / 2);
  context.stroke();

  // 指の反対側に出す。
  const stageRect = $("preview-scroll").getBoundingClientRect();
  loupe.style.top = `${stageRect.top + 8 + window.scrollY}px`;
  loupe.style.left = clientX < stageRect.left + stageRect.width / 2
    ? `${stageRect.right - size - 8}px`
    : `${stageRect.left + 8}px`;
}

function hideLoupe() {
  $("loupe").hidden = true;
}

function renderManualRegions() {
  const container = $("manual-regions");
  container.innerHTML = "";

  state.regions.forEach((region, i) => {
    const row = document.createElement("div");
    row.className = "manual-region" + (i === state.activeRegion ? " active" : "");
    row.addEventListener("click", () => {
      state.activeRegion = i;
      renderManualRegions();
      drawOverlay();
    });

    const label = document.createElement("span");
    label.textContent = `囲み ${i + 1}`;
    row.appendChild(label);

    const stepper = document.createElement("div");
    stepper.className = "stepper";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    const value = document.createElement("span");
    value.className = "stepper-value";
    value.textContent = `${region.count} 枚`;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "＋";

    const bump = (delta) => {
      region.count = Math.max(1, Math.min(18, region.count + delta));
      value.textContent = `${region.count} 枚`;
      drawOverlay();
    };
    minus.addEventListener("click", (e) => { e.stopPropagation(); bump(-1); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); bump(1); });
    stepper.append(minus, value, plus);
    row.appendChild(stepper);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost small";
    remove.textContent = "削除";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      state.regions.splice(i, 1);
      state.activeRegion = Math.max(0, Math.min(state.activeRegion, state.regions.length - 1));
      renderManualRegions();
      drawOverlay();
    });
    row.appendChild(remove);

    container.appendChild(row);
  });

  $("manual-apply").disabled = state.regions.length === 0;
}

/** 指定した範囲だけを読み直す。 */
async function applyManualRegions() {
  if (!state.regions.length || !state.source) return;
  setStatus("upload-status", "指定した範囲を読み込み中...", "");
  try {
    const regions = state.regions.map(({ quad, count }) => ({ quad, count }));
    const result = await runRecognition(currentImage(), regions);
    applyResult(result, { manual: true });
  } catch (error) {
    setStatus("upload-status", error.message, "error");
  }
}

function setManualMode(on) {
  state.manualMode = on;
  $("manual-panel").hidden = !on;
  $("manual-toggle").textContent = on ? "範囲の指定をやめる" : "範囲を指定して読む";
  $("preview-stage").classList.toggle("selecting", on);
  // 何も無いまま入っても分からないので、最初の囲みを置いておく。
  if (on && !state.regions.length && state.decodedSize) addRegion();
  drawOverlay();
}

/**
 * 検出した牌の位置を写真に重ねて描く。
 *
 * 判別を間違えているのか、そもそも切り出しに失敗しているのかは、これを見ると
 * 一目で分かる。枠が牌とずれていれば判別以前の問題。
 */
function drawOverlay() {
  const canvas = $("overlay");
  const image = $("preview");
  const wantsOverlay = $("show-overlay").checked || state.manualMode;
  const hasSomething = state.quads.length || state.regions.length || state.dragRect;
  if (!state.decodedSize || !image.clientWidth || !hasSomething || !wantsOverlay) {
    canvas.hidden = true;
    return;
  }
  canvas.hidden = false;

  const ratio = window.devicePixelRatio || 1;
  const width = image.clientWidth;
  const height = image.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const scale = width / state.decodedSize.width;
  context.lineWidth = Math.max(1, width / 400);
  context.font = `${Math.max(9, width / 42)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  // 指定した範囲と、その等分線。
  state.regions.forEach((region, index) => {
    const points = region.quad.map(([x, y]) => [x * scale, y * scale]);
    const active = index === state.activeRegion;

    context.strokeStyle = active ? "#4c9ae8" : "rgba(76,154,232,.45)";
    context.fillStyle = active ? "rgba(76,154,232,.12)" : "rgba(76,154,232,.06)";
    context.lineWidth = Math.max(1.5, width / 320);
    context.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
    context.closePath();
    context.fill();
    context.stroke();

    // 等分線。牌の境目と合っているかを見るためのもの。
    context.strokeStyle = active ? "rgba(76,154,232,.8)" : "rgba(76,154,232,.35)";
    context.lineWidth = Math.max(1, width / 500);
    for (let i = 1; i < region.count; i += 1) {
      const t = i / region.count;
      const top = [
        points[0][0] + (points[1][0] - points[0][0]) * t,
        points[0][1] + (points[1][1] - points[0][1]) * t,
      ];
      const bottom = [
        points[3][0] + (points[2][0] - points[3][0]) * t,
        points[3][1] + (points[2][1] - points[3][1]) * t,
      ];
      context.beginPath();
      context.moveTo(top[0], top[1]);
      context.lineTo(bottom[0], bottom[1]);
      context.stroke();
    }

    // 4 隅のつまみ。触れる大きさで描く。
    if (active && state.manualMode) {
      const radius = Math.max(7, width / 46);
      points.forEach(([x, y]) => {
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = "#fff";
        context.strokeStyle = "#4c9ae8";
        context.lineWidth = Math.max(2, width / 200);
        context.fill();
        context.stroke();
      });
    }
  });

  if (state.dragRect) {
    const [x0, y0, x1, y1] = state.dragRect;
    context.strokeStyle = "#4c9ae8";
    context.fillStyle = "rgba(76,154,232,.20)";
    context.lineWidth = Math.max(1.5, width / 320);
    context.beginPath();
    context.rect(x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    context.fill();
    context.stroke();
  }

  if (!$("show-overlay").checked) return;

  state.quads.forEach((quad, i) => {
    const tile = state.tiles[i];
    const uncertain = !tile || tile.uncertain;
    context.strokeStyle = uncertain ? "#e0a13a" : "#3fb984";
    context.fillStyle = uncertain ? "rgba(224,161,58,.18)" : "rgba(63,185,132,.14)";

    context.beginPath();
    quad.forEach(([x, y], j) => {
      const px = x * scale;
      const py = y * scale;
      if (j === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.closePath();
    context.fill();
    context.stroke();

    const cx = (quad.reduce((s, p) => s + p[0], 0) / 4) * scale;
    const cy = (quad.reduce((s, p) => s + p[1], 0) / 4) * scale;
    context.fillStyle = "#fff";
    context.strokeStyle = "rgba(0,0,0,.65)";
    context.lineWidth = Math.max(2, width / 200);
    context.strokeText(String(i + 1), cx, cy);
    context.fillText(String(i + 1), cx, cy);
    context.lineWidth = Math.max(1, width / 400);
  });
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
// 並び順でまとめて指定する (牌を覚えさせるときに使う)
// ---------------------------------------------------------------------------

const BULK_PRESETS = [
  { label: "萬子 一〜九", notation: "123456789m" },
  { label: "筒子 一〜九", notation: "123456789p" },
  { label: "索子 一〜九", notation: "123456789s" },
  { label: "字牌 東南西北白發中", notation: "1234567z" },
];

function buildBulkPresets() {
  const container = $("bulk-presets");
  container.innerHTML = "";
  BULK_PRESETS.forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost small";
    button.textContent = preset.label;
    button.addEventListener("click", () => applyBulk(preset.notation));
    container.appendChild(button);
  });
}

/**
 * 認識した牌に、指定した並びを左から順に割り当てる。
 *
 * 牌を覚えさせるときは並び順が分かっているので、1 枚ずつ選び直すより
 * こちらのほうが速いし間違えにくい。
 */
function applyBulk(notation) {
  let tiles;
  try {
    tiles = parseTiles(notation).tiles;
  } catch (error) {
    setStatus("bulk-status", `並びを読み取れません: ${error.message}`, "error");
    return;
  }

  if (!state.tiles.length) {
    setStatus("bulk-status", "先に写真を読み込んでください", "error");
    return;
  }
  if (tiles.length !== state.tiles.length) {
    setStatus(
      "bulk-status",
      `枚数が合いません (指定 ${tiles.length} 枚 / 認識 ${state.tiles.length} 枚)。` +
      "「手で囲む」で枚数を合わせてから、もう一度押してください。",
      "error"
    );
    return;
  }

  const order = $("bulk-reverse").checked ? [...tiles].reverse() : tiles;
  state.tiles.forEach((tile, i) => {
    tile.tile = order[i];
    tile.uncertain = false;
  });

  renderTiles();
  drawOverlay();
  setStatus("bulk-status", `${tiles.length} 枚を割り当てました。「この結果を覚えさせる」を押してください。`, "ok");
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
    drawOverlay();
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
