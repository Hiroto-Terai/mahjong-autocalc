// 役の判定。Python 版 mahjong_autocalc/yaku.py の移植。
// 役満が成立する場合は通常役を返さない (標準的な複合ルール)。

import { HandForm, Wait } from "./parser.js";
import {
  DRAGONS, GREEN_TILES, HONOR, WINDS, WIND_NAMES_JA, YAOCHU,
  countTiles, doraIndicatorToDora, isHonor, isTerminal, suitOf, tileName,
} from "./tiles.js";

export class Yaku {
  constructor(name, han = 0, yakuman = 0) {
    this.name = name;
    this.han = han;
    this.yakuman = yakuman;
  }
  get isYakuman() { return this.yakuman > 0; }
}

const numericSuits = (tiles) => new Set(tiles.filter((t) => !isHonor(t)).map(suitOf));

function runCounts(groups) {
  const out = new Map();
  for (const g of groups) {
    if (g.isRun) out.set(g.tile, (out.get(g.tile) || 0) + 1);
  }
  return out;
}

function yakuhai(decomp, ctx) {
  const out = [];
  for (const group of decomp.groups) {
    if (group.isRun) continue;
    const tile = group.tile;
    if (DRAGONS.includes(tile)) {
      out.push(new Yaku(`役牌 ${tileName(tile)}`, 1));
    } else {
      if (tile === ctx.roundWind) out.push(new Yaku(`場風 ${WIND_NAMES_JA[tile]}`, 1));
      if (tile === ctx.seatWind) out.push(new Yaku(`自風 ${WIND_NAMES_JA[tile]}`, 1));
    }
  }
  return out;
}

function isPinfu(hand, decomp, ctx) {
  if (!hand.isMenzen || decomp.form !== HandForm.STANDARD) return false;
  if (decomp.groups.some((g) => !g.isRun)) return false;
  if (decomp.wait !== Wait.RYANMEN) return false;
  const pair = decomp.pair;
  if (DRAGONS.includes(pair) || pair === ctx.roundWind || pair === ctx.seatWind) return false;
  return true;
}

/** "chanta" / "junchan" / null を返す。 */
function chantaFamily(decomp) {
  if (decomp.form !== HandForm.STANDARD) return null;
  const parts = [[decomp.pair, decomp.pair], ...decomp.groups.map((g) => g.tiles)];
  if (!parts.every((part) => part.some((t) => YAOCHU.has(t)))) return null;
  // 順子を含まない全帯幺形は混老頭/清老頭として扱う。
  if (!decomp.groups.some((g) => g.isRun)) return null;
  const hasHonor = parts.some((part) => part.some(isHonor));
  return hasHonor ? "chanta" : "junchan";
}

function sanshokuDoujun(groups) {
  const byRank = new Map();
  for (const g of groups) {
    if (g.isRun && g.tile < HONOR) {
      const key = g.tile % 9;
      if (!byRank.has(key)) byRank.set(key, new Set());
      byRank.get(key).add(suitOf(g.tile));
    }
  }
  return [...byRank.values()].some((s) => s.size === 3);
}

function sanshokuDoukou(groups) {
  const byRank = new Map();
  for (const g of groups) {
    if (g.isTriplet && g.tile < HONOR) {
      const key = g.tile % 9;
      if (!byRank.has(key)) byRank.set(key, new Set());
      byRank.get(key).add(suitOf(g.tile));
    }
  }
  return [...byRank.values()].some((s) => s.size === 3);
}

function ittsuu(groups) {
  const runs = new Set(groups.filter((g) => g.isRun).map((g) => g.tile));
  return [0, 9, 18].some((base) => runs.has(base) && runs.has(base + 3) && runs.has(base + 6));
}

/** 九蓮宝燈なら 1 (純正なら 2)、不成立なら 0。 */
function chuuren(hand, winTile) {
  if (!hand.isMenzen || hand.melds.length) return 0;
  const tiles = hand.concealed;
  if (tiles.some(isHonor)) return 0;
  if (numericSuits(tiles).size !== 1) return 0;

  const base = Math.floor(tiles[0] / 9) * 9;
  const counts = countTiles(tiles).slice(base, base + 9);
  const required = [3, 1, 1, 1, 1, 1, 1, 1, 3];
  const diff = counts.map((c, i) => c - required[i]);
  if (diff.some((d) => d < 0)) return 0;
  if (diff.reduce((a, b) => a + b, 0) !== 1) return 0;

  // 純正: 和了牌を除いた 13 枚がちょうど 1112345678999 の形。
  const extra = diff.indexOf(1);
  return base + extra === winTile ? 2 : 1;
}

/** 四暗刻なら 1 (単騎なら 2)、不成立なら 0。 */
function suuankou(decomp) {
  if (decomp.form !== HandForm.STANDARD) return 0;
  const concealedTriplets = decomp.groups.filter((g) => g.isTriplet && g.concealed);
  if (concealedTriplets.length !== 4) return 0;
  return decomp.wait === Wait.TANKI ? 2 : 1;
}

function detectYakuman(hand, decomp, ctx, winTile) {
  const out = [];
  const tiles = decomp.form !== HandForm.CHIITOITSU ? decomp.allTiles : hand.allTiles;

  if (ctx.isTenhou) out.push(new Yaku("天和", 0, 1));
  if (ctx.isChiihou) out.push(new Yaku("地和", 0, 1));

  if (decomp.form === HandForm.KOKUSHI) {
    out.push(decomp.pair === winTile
      ? new Yaku("国士無双十三面待ち", 0, 2)
      : new Yaku("国士無双", 0, 1));
    return out;
  }

  if (decomp.form === HandForm.STANDARD) {
    const tripletTiles = decomp.groups.filter((g) => g.isTriplet).map((g) => g.tile);

    const ankou = suuankou(decomp);
    if (ankou === 2) out.push(new Yaku("四暗刻単騎", 0, 2));
    else if (ankou === 1) out.push(new Yaku("四暗刻", 0, 1));

    if (tripletTiles.filter((t) => DRAGONS.includes(t)).length === 3) {
      out.push(new Yaku("大三元", 0, 1));
    }

    const windTriplets = tripletTiles.filter((t) => WINDS.includes(t));
    if (windTriplets.length === 4) out.push(new Yaku("大四喜", 0, 2));
    else if (windTriplets.length === 3 && WINDS.includes(decomp.pair)) {
      out.push(new Yaku("小四喜", 0, 1));
    }

    if (decomp.groups.filter((g) => g.isKan).length === 4) out.push(new Yaku("四槓子", 0, 1));

    const nine = chuuren(hand, winTile);
    if (nine === 2) out.push(new Yaku("純正九蓮宝燈", 0, 2));
    else if (nine === 1) out.push(new Yaku("九蓮宝燈", 0, 1));

    if (tiles.every((t) => GREEN_TILES.has(t))) out.push(new Yaku("緑一色", 0, 1));
    if (tiles.every(isTerminal)) out.push(new Yaku("清老頭", 0, 1));
  }

  if (tiles.every(isHonor)) out.push(new Yaku("字一色", 0, 1));

  return out;
}

function detectNormal(hand, decomp, ctx) {
  const out = [];
  const menzen = hand.isMenzen;
  const tiles = decomp.form !== HandForm.CHIITOITSU ? decomp.allTiles : hand.allTiles;

  // --- 状況役 ---
  if (ctx.isDoubleRiichi) out.push(new Yaku("ダブル立直", 2));
  else if (ctx.isRiichi) out.push(new Yaku("立直", 1));
  if (ctx.isIppatsu) out.push(new Yaku("一発", 1));
  if (ctx.isTsumo && menzen) out.push(new Yaku("門前清自摸和", 1));
  if (ctx.isHaitei) out.push(new Yaku("海底摸月", 1));
  if (ctx.isHoutei) out.push(new Yaku("河底撈魚", 1));
  if (ctx.isRinshan) out.push(new Yaku("嶺上開花", 1));
  if (ctx.isChankan) out.push(new Yaku("搶槓", 1));

  // --- 形役 ---
  if (decomp.form === HandForm.CHIITOITSU) {
    out.push(new Yaku("七対子", 2));
  } else {
    out.push(...yakuhai(decomp, ctx));
    if (isPinfu(hand, decomp, ctx)) out.push(new Yaku("平和", 1));

    if (menzen) {
      let pairs = 0;
      for (const n of runCounts(decomp.groups).values()) pairs += Math.floor(n / 2);
      if (pairs >= 2) out.push(new Yaku("二盃口", 3));
      else if (pairs === 1) out.push(new Yaku("一盃口", 1));
    }

    if (sanshokuDoujun(decomp.groups)) out.push(new Yaku("三色同順", menzen ? 2 : 1));
    if (ittsuu(decomp.groups)) out.push(new Yaku("一気通貫", menzen ? 2 : 1));
    if (sanshokuDoukou(decomp.groups)) out.push(new Yaku("三色同刻", 2));

    const chanta = chantaFamily(decomp);
    if (chanta === "chanta") out.push(new Yaku("混全帯幺九", menzen ? 2 : 1));
    else if (chanta === "junchan") out.push(new Yaku("純全帯幺九", menzen ? 3 : 2));

    if (decomp.groups.every((g) => g.isTriplet)) out.push(new Yaku("対々和", 2));

    const concealedTriplets = decomp.groups.filter((g) => g.isTriplet && g.concealed).length;
    if (concealedTriplets === 3) out.push(new Yaku("三暗刻", 2));

    if (decomp.groups.filter((g) => g.isKan).length === 3) out.push(new Yaku("三槓子", 2));

    const dragonTriplets = decomp.groups.filter((g) => g.isTriplet && DRAGONS.includes(g.tile));
    if (dragonTriplets.length === 2 && DRAGONS.includes(decomp.pair)) {
      out.push(new Yaku("小三元", 2));
    }
  }

  // --- 牌の種類による役 ---
  if (!tiles.some((t) => YAOCHU.has(t))) {
    if (menzen || ctx.rules.allowKuitan) out.push(new Yaku("断幺九", 1));
  }

  if (tiles.every((t) => YAOCHU.has(t)) && tiles.some(isHonor) && tiles.some((t) => !isHonor(t))) {
    out.push(new Yaku("混老頭", 2));
  }

  const suits = numericSuits(tiles);
  const hasHonor = tiles.some(isHonor);
  if (suits.size === 1 && !hasHonor) out.push(new Yaku("清一色", menzen ? 6 : 5));
  else if (suits.size === 1 && hasHonor) out.push(new Yaku("混一色", menzen ? 3 : 2));

  return out;
}

/** 成立する役の一覧を返す。役満成立時は役満のみを返す。 */
export function detect(hand, decomp, ctx, winTile) {
  let yakuman = detectYakuman(hand, decomp, ctx, winTile);
  if (yakuman.length) {
    if (!ctx.rules.doubleYakuman) {
      yakuman = yakuman.map((y) => (y.yakuman > 1 ? new Yaku(y.name, 0, 1) : y));
    }
    if (!ctx.rules.multipleYakuman) {
      yakuman = [yakuman.reduce((a, b) => (b.yakuman > a.yakuman ? b : a))];
    }
    return yakuman;
  }
  return detectNormal(hand, decomp, ctx);
}

/** ドラ・赤ドラ・裏ドラを翻数として数える (役の有無とは別扱い)。 */
export function countDora(hand, ctx) {
  const out = [];
  const tiles = hand.allTiles;

  let dora = 0;
  for (const indicator of ctx.doraIndicators) {
    const target = doraIndicatorToDora(indicator);
    dora += tiles.filter((t) => t === target).length;
  }
  if (dora) out.push(new Yaku("ドラ", dora));

  const reds = hand.allRedFives.length;
  if (reds) out.push(new Yaku("赤ドラ", reds));

  let ura = 0;
  if (ctx.isRiichi || ctx.isDoubleRiichi) {
    for (const indicator of ctx.uraIndicators) {
      const target = doraIndicatorToDora(indicator);
      ura += tiles.filter((t) => t === target).length;
    }
  }
  if (ura) out.push(new Yaku("裏ドラ", ura));

  return out;
}
