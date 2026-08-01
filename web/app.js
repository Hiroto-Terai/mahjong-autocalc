"use strict";

const WINDS = [
  { tile: 27, name: "東" },
  { tile: 28, name: "南" },
  { tile: 29, name: "西" },
  { tile: 30, name: "北" },
];

const FLAGS = [
  { key: "is_riichi", label: "立直" },
  { key: "is_double_riichi", label: "ダブル立直" },
  { key: "is_ippatsu", label: "一発" },
  { key: "is_haitei", label: "海底摸月" },
  { key: "is_houtei", label: "河底撈魚" },
  { key: "is_rinshan", label: "嶺上開花" },
  { key: "is_chankan", label: "搶槓" },
  { key: "is_tenhou", label: "天和" },
  { key: "is_chiihou", label: "地和" },
];

const MELD_TYPES = [
  { value: "hand", label: "手牌" },
  { value: "chii", label: "チー" },
  { value: "pon", label: "ポン" },
  { value: "open_kan", label: "明カン" },
  { value: "closed_kan", label: "暗カン" },
];

const state = {
  imageId: null,
  tiles: [],           // { index, tile, name, crop, uncertain, group, isWin, isRed }
  groupTypes: {},      // group -> meld type
  roundWind: 27,
  seatWind: 27,
  isTsumo: false,
  flags: {},
  dora: [],
  ura: [],
  catalog: [],
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  const response = await fetch("/api/tiles");
  state.catalog = (await response.json()).tiles;

  buildWindSelector($("round-wind"), "roundWind");
  buildWindSelector($("seat-wind"), "seatWind");
  buildFlags();
  bindWinType();
  bindUpload();

  $("calculate").addEventListener("click", calculate);
  $("learn-button").addEventListener("click", learn);
  $("picker-close").addEventListener("click", closePicker);
  $("picker").addEventListener("click", (e) => { if (e.target.id === "picker") closePicker(); });

  document.querySelectorAll("[data-add-dora]").forEach((button) => {
    button.addEventListener("click", () => addDora(button.dataset.addDora));
  });

  $("library-button").addEventListener("click", openLibrary);
  $("library-close").addEventListener("click", () => ($("library-modal").hidden = true));
  $("library-reset").addEventListener("click", resetLibrary);
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
      $("ura-field").hidden = !(state.flags.is_riichi || state.flags.is_double_riichi);
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

/* ------------------------------------------------------------------ */
/* 画像アップロード                                                     */
/* ------------------------------------------------------------------ */

function bindUpload() {
  const zone = $("dropzone");
  const input = $("file-input");

  input.addEventListener("change", () => {
    if (input.files && input.files[0]) upload(input.files[0]);
  });

  ["dragenter", "dragover"].forEach((type) =>
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add("over"); })
  );
  ["dragleave", "drop"].forEach((type) =>
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove("over"); })
  );
  zone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) upload(file);
  });
}

async function upload(file) {
  setStatus("upload-status", "認識中...", "");
  $("preview").src = URL.createObjectURL(file);
  $("preview-wrap").hidden = false;

  const form = new FormData();
  form.append("image", file);

  let payload;
  try {
    const response = await fetch("/api/recognize", { method: "POST", body: form });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "認識に失敗しました");
  } catch (error) {
    setStatus("upload-status", error.message, "error");
    return;
  }

  state.imageId = payload.image_id;
  state.groupTypes = {};
  state.tiles = payload.tiles.map((t) => ({
    index: t.index,
    tile: t.tile,
    crop: t.crop,
    uncertain: t.uncertain,
    group: t.group,
    isWin: false,
    isRed: false,
  }));

  // 一番後ろの牌を和了牌の初期値にしておく (ツモ切り前の並びで自然な位置)。
  if (state.tiles.length) state.tiles[state.tiles.length - 1].isWin = true;

  const uncertain = payload.uncertain_count;
  const note = payload.library_size === 0
    ? " 牌をまだ覚えていないので、直したうえで「覚えさせる」を押すと次から精度が上がります。"
    : "";
  setStatus(
    "upload-status",
    `${payload.count} 枚を検出しました。${uncertain ? `${uncertain} 枚は自信なしです。` : ""}${note}`,
    uncertain ? "" : "ok"
  );

  renderTiles();
  $("tiles-card").hidden = false;
  $("context-card").hidden = false;
}

/* ------------------------------------------------------------------ */
/* 牌の表示と修正                                                       */
/* ------------------------------------------------------------------ */

function tileName(id) {
  const entry = state.catalog.find((t) => t.tile === id);
  return entry ? entry.name : "?";
}

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
      MELD_TYPES.filter((m) => (tiles.length === 4 ? m.value.includes("kan") || m.value === "hand" : m.value !== "open_kan" && m.value !== "closed_kan"))
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

function renderTile(tile) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  if (tile.uncertain) button.classList.add("uncertain");
  if (tile.isWin) button.classList.add("win");

  const image = document.createElement("img");
  image.src = tile.crop;
  image.alt = "";
  button.appendChild(image);

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

/* ------------------------------------------------------------------ */
/* 牌を選ぶモーダル                                                     */
/* ------------------------------------------------------------------ */

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
  if (tile.tile !== null && [4, 13, 22].includes(tile.tile)) {
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
  state.catalog.forEach((entry, i) => {
    if (i > 0 && i % 9 === 0 && i <= 27) {
      const line = document.createElement("div");
      line.className = "suit-break";
      grid.appendChild(line);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry.name;
    if (entry.tile === current) button.classList.add("current");
    button.addEventListener("click", () => onPick(entry.tile));
    grid.appendChild(button);
  });
}

function closePicker() {
  $("picker").hidden = true;
}

/* ------------------------------------------------------------------ */
/* ドラ                                                                */
/* ------------------------------------------------------------------ */

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
      chip.append(document.createTextNode(tileName(tile)));
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

/* ------------------------------------------------------------------ */
/* 学習                                                                */
/* ------------------------------------------------------------------ */

async function learn() {
  if (!state.imageId) return;
  const assignments = {};
  state.tiles.forEach((tile) => {
    if (tile.tile !== null) assignments[tile.index] = tile.tile;
  });
  if (!Object.keys(assignments).length) return;

  setStatus("learn-status", "登録中...", "");
  try {
    const response = await fetch("/api/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_id: state.imageId, assignments }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "登録に失敗しました");
    setStatus(
      "learn-status",
      `${payload.learned} 枚を登録しました (合計 ${payload.library_size} 件、未登録 ${payload.missing.length} 種)`,
      "ok"
    );
  } catch (error) {
    setStatus("learn-status", error.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* 計算                                                                */
/* ------------------------------------------------------------------ */

function buildRequest() {
  const winTile = state.tiles.find((t) => t.isWin);
  if (!winTile || winTile.tile === null) throw new Error("和了牌を 1 枚指定してください");
  if (state.tiles.some((t) => t.tile === null)) throw new Error("認識できていない牌があります");

  const concealed = [];
  const melds = [];
  const redFives = [];

  const groups = [...new Set(state.tiles.map((t) => t.group))];
  groups.forEach((group) => {
    const tiles = state.tiles.filter((t) => t.group === group);
    const kind = state.groupTypes[group] || "hand";
    const reds = tiles.filter((t) => t.isRed).map((t) => t.tile);
    if (kind === "hand") {
      tiles.forEach((t) => concealed.push(t.tile));
      redFives.push(...reds);
    } else {
      melds.push({ type: kind, tiles: tiles.map((t) => t.tile), red_fives: reds });
    }
  });

  if (winTile.tile !== null && !concealed.includes(winTile.tile)) {
    throw new Error("和了牌は手牌 (副露していないかたまり) の中から選んでください");
  }

  return {
    concealed,
    melds,
    red_fives: redFives,
    win_tile: winTile.tile,
    round_wind: state.roundWind,
    seat_wind: state.seatWind,
    is_tsumo: state.isTsumo,
    is_riichi: !!state.flags.is_riichi,
    is_double_riichi: !!state.flags.is_double_riichi,
    is_ippatsu: !!state.flags.is_ippatsu,
    is_haitei: !!state.flags.is_haitei,
    is_houtei: !!state.flags.is_houtei,
    is_rinshan: !!state.flags.is_rinshan,
    is_chankan: !!state.flags.is_chankan,
    is_tenhou: !!state.flags.is_tenhou,
    is_chiihou: !!state.flags.is_chiihou,
    dora_indicators: state.dora,
    ura_indicators: state.ura,
    honba: Number($("honba").value) || 0,
    riichi_sticks: Number($("sticks").value) || 0,
    rules: {
      allow_kuitan: $("rule-kuitan").checked,
      kiriage_mangan: $("rule-kiriage").checked,
      double_yakuman: $("rule-double-yakuman").checked,
      multiple_yakuman: $("rule-multi-yakuman").checked,
      double_wind_pair_fu: Number($("rule-double-wind").value),
    },
  };
}

async function calculate() {
  let request;
  try {
    request = buildRequest();
  } catch (error) {
    setStatus("calc-status", error.message, "error");
    return;
  }

  setStatus("calc-status", "計算中...", "");
  try {
    const response = await fetch("/api/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "計算に失敗しました");
    setStatus("calc-status", "", "");
    renderResult(payload);
  } catch (error) {
    setStatus("calc-status", error.message, "error");
    $("result-card").hidden = true;
  }
}

function renderResult(result) {
  const container = $("result");
  container.innerHTML = "";

  const headline = document.createElement("div");
  headline.className = "headline";

  const points = document.createElement("span");
  points.className = "points";
  points.textContent = `${result.payments.total.toLocaleString()} 点`;
  headline.appendChild(points);

  const hanfu = document.createElement("span");
  hanfu.className = "hanfu";
  hanfu.textContent = result.yakuman
    ? `役満 ×${result.yakuman}`
    : `${result.fu} 符 ${result.han} 翻`;
  headline.appendChild(hanfu);

  if (result.limit_name) {
    const limit = document.createElement("span");
    limit.className = "limit";
    limit.textContent = result.limit_name;
    headline.appendChild(limit);
  }
  container.appendChild(headline);

  container.appendChild(section("内訳", [describePayment(result)]));

  const yakuItems = result.yaku.map((y) => ({
    label: y.name,
    value: y.yakuman ? (y.yakuman > 1 ? `ダブル役満` : `役満`) : `${y.han} 翻`,
    highlight: !!y.yakuman,
  }));
  if (result.dora.length) {
    result.dora.forEach((d) => yakuItems.push({ label: d.name, value: `${d.han} 翻` }));
  }
  container.appendChild(listSection("役", yakuItems));

  if (!result.yakuman) {
    container.appendChild(
      listSection(
        `符 (${result.fu_raw} 符 → 切り上げ ${result.fu} 符)`,
        result.fu_details.map((d) => ({ label: d.label, value: `${d.fu} 符` }))
      )
    );
  }

  const shape = document.createElement("p");
  shape.className = "shape";
  shape.textContent = `面子構成: ${result.hand_shape}`;
  container.appendChild(section("採用した形", [shape]));

  $("result-card").hidden = false;
  $("result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function describePayment(result) {
  const p = result.payments;
  const parts = [];
  if (result.is_tsumo) {
    if (result.is_dealer) {
      parts.push(`子 各 ${p.from_each_non_dealer.toLocaleString()} 点`);
    } else {
      parts.push(`親 ${p.from_dealer.toLocaleString()} 点`);
      parts.push(`子 各 ${p.from_each_non_dealer.toLocaleString()} 点`);
    }
  } else {
    parts.push(`放銃者から ${p.from_discarder.toLocaleString()} 点`);
  }
  if (p.riichi_sticks) parts.push(`供託 ${p.riichi_sticks.toLocaleString()} 点`);

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

/* ------------------------------------------------------------------ */
/* ライブラリ                                                           */
/* ------------------------------------------------------------------ */

async function openLibrary() {
  const response = await fetch("/api/library");
  const payload = await response.json();
  const body = $("library-body");
  body.innerHTML = "";

  const summary = document.createElement("p");
  summary.textContent = `登録済み ${payload.size} 件 / 未登録 ${payload.missing.length} 種`;
  body.appendChild(summary);

  if (payload.missing.length) {
    const missing = document.createElement("p");
    missing.className = "missing";
    missing.textContent = "未登録: " + payload.missing.map((m) => m.name).join(" ");
    body.appendChild(missing);
  } else {
    const done = document.createElement("p");
    done.textContent = "34 種すべて登録済みです。";
    body.appendChild(done);
  }

  const path = document.createElement("p");
  path.className = "shape";
  path.textContent = `保存先: ${payload.path}`;
  body.appendChild(path);

  $("library-modal").hidden = false;
}

async function resetLibrary() {
  if (!confirm("登録した牌のデータをすべて削除します。よろしいですか?")) return;
  await fetch("/api/library", { method: "DELETE" });
  openLibrary();
}

/* ------------------------------------------------------------------ */

function setStatus(id, message, kind) {
  const element = $(id);
  element.textContent = message;
  element.className = "status" + (kind ? ` ${kind}` : "");
}

init();
