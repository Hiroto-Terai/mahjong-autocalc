// 符計算・基本点・支払い・全体のまとめ。
// Python 版 fu.py / score.py / calculator.py / context.py の移植。

import { HandForm, decompose, waitFu } from "./parser.js";
import { DRAGONS, EAST, WINDS, WIND_NAMES_JA, tileName } from "./tiles.js";
import { Yaku, countDora, detect } from "./yaku.js";

export const CHIITOITSU_FU = 25;
export const BASE_FU = 20;
export const MANGAN_BASE = 2000;

export class NoYakuError extends Error {}
export class NotWinningHandError extends Error {}

/** 卓ごとに揺れるローカルルール。既定値は一般的な設定。 */
export function makeRules(overrides = {}) {
  return {
    kiriageMangan: false,
    doubleWindPairFu: 2,
    allowKuitan: true,
    multipleYakuman: true,
    doubleYakuman: true,
    ...overrides,
  };
}

/** 和了の状況。 */
export function makeContext(overrides = {}) {
  const ctx = {
    roundWind: EAST,
    seatWind: EAST,
    isTsumo: false,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: false,
    isTenhou: false,
    isChiihou: false,
    doraIndicators: [],
    uraIndicators: [],
    honba: 0,
    riichiSticks: 0,
    ...overrides,
    rules: makeRules(overrides.rules || {}),
  };
  ctx.isDealer = ctx.seatWind === EAST;
  return ctx;
}

export function validateContext(ctx) {
  if (!WINDS.includes(ctx.roundWind)) throw new Error("場風は東南西北のいずれかです");
  if (!WINDS.includes(ctx.seatWind)) throw new Error("自風は東南西北のいずれかです");
  if (ctx.isTsumo && ctx.isChankan) throw new Error("搶槓はロン和了のみです");
  if (ctx.isTsumo && ctx.isHoutei) throw new Error("河底撈魚はロン和了のみです");
  if (!ctx.isTsumo && (ctx.isHaitei || ctx.isRinshan)) {
    throw new Error("海底摸月・嶺上開花はツモ和了のみです");
  }
  if (ctx.isHaitei && ctx.isHoutei) throw new Error("海底と河底は同時に成立しません");
  if (ctx.isIppatsu && !(ctx.isRiichi || ctx.isDoubleRiichi)) throw new Error("一発は立直が前提です");
  if (ctx.isIppatsu && (ctx.isHaitei || ctx.isHoutei)) {
    throw new Error("一発と海底/河底は同時に成立しません");
  }
  if (ctx.isTenhou && ctx.isChiihou) throw new Error("天和と地和は同時に成立しません");
  if (ctx.isTenhou && !(ctx.isDealer && ctx.isTsumo)) throw new Error("天和は親のツモ和了のみです");
  if (ctx.isChiihou && (ctx.isDealer || !ctx.isTsumo)) throw new Error("地和は子のツモ和了のみです");
  if (ctx.honba < 0 || ctx.riichiSticks < 0) throw new Error("本場・供託は 0 以上です");
}

// ---------------------------------------------------------------------------
// 符
// ---------------------------------------------------------------------------

function pairFu(decomp, ctx) {
  const pair = decomp.pair;
  if (pair === null || pair === undefined) return [0, null];
  if (DRAGONS.includes(pair)) return [2, `雀頭 ${tileName(pair)}`];
  const isRound = pair === ctx.roundWind;
  const isSeat = pair === ctx.seatWind;
  if (isRound && isSeat) return [ctx.rules.doubleWindPairFu, `雀頭 連風牌 ${WIND_NAMES_JA[pair]}`];
  if (isRound) return [2, `雀頭 場風 ${WIND_NAMES_JA[pair]}`];
  if (isSeat) return [2, `雀頭 自風 ${WIND_NAMES_JA[pair]}`];
  return [0, null];
}

function groupLabel(group) {
  const kind = group.isRun ? "順子" : group.isKan ? "槓子" : "刻子";
  const state = group.concealed ? "暗" : "明";
  return `${state}${kind} ${group.tiles.slice(0, 3).map(tileName).join("")}`;
}

export function calculateFu(hand, decomp, ctx, isPinfuHand) {
  if (decomp.form === HandForm.CHIITOITSU) {
    return { fu: CHIITOITSU_FU, rawFu: CHIITOITSU_FU, details: [{ label: "七対子固定", fu: CHIITOITSU_FU }] };
  }
  if (decomp.form === HandForm.KOKUSHI) {
    return { fu: BASE_FU, rawFu: BASE_FU, details: [{ label: "副底", fu: BASE_FU }] };
  }

  const details = [{ label: "副底", fu: BASE_FU }];
  let total = BASE_FU;

  if (isPinfuHand && ctx.isTsumo) {
    return { fu: BASE_FU, rawFu: BASE_FU, details: [{ label: "平和ツモ固定", fu: BASE_FU }] };
  }

  if (hand.isMenzen && !ctx.isTsumo) {
    details.push({ label: "門前ロン", fu: 10 });
    total += 10;
  }
  if (ctx.isTsumo && !isPinfuHand) {
    details.push({ label: "ツモ", fu: 2 });
    total += 2;
  }

  for (const group of decomp.groups) {
    const fu = group.fu();
    if (fu) {
      details.push({ label: groupLabel(group), fu });
      total += fu;
    }
  }

  const [pFu, pLabel] = pairFu(decomp, ctx);
  if (pFu && pLabel) {
    details.push({ label: pLabel, fu: pFu });
    total += pFu;
  }

  const wFu = waitFu(decomp.wait);
  if (wFu) {
    const labels = { penchan: "辺張待ち", kanchan: "嵌張待ち", tanki: "単騎待ち" };
    details.push({ label: labels[decomp.wait], fu: wFu });
    total += wFu;
  }

  const raw = total;
  let rounded = Math.ceil(total / 10) * 10;
  if (!hand.isMenzen && rounded === BASE_FU) {
    // 鳴いた平和形は 30 符として扱う (いわゆる食い平和)。
    rounded = 30;
    details.push({ label: "食い平和形の補正", fu: 10 });
  }
  return { fu: rounded, rawFu: raw, details };
}

// ---------------------------------------------------------------------------
// 点数
// ---------------------------------------------------------------------------

const roundUp100 = (value) => Math.ceil(value / 100) * 100;

export function limitName(han, yakuman, basePoints) {
  if (yakuman) {
    return { 1: "役満", 2: "ダブル役満", 3: "トリプル役満" }[yakuman] || `${yakuman}倍役満`;
  }
  if (han >= 13) return "数え役満";
  if (han >= 11) return "三倍満";
  if (han >= 8) return "倍満";
  if (han >= 6) return "跳満";
  if (basePoints >= MANGAN_BASE) return "満貫";
  return "";
}

export function basePointsFor(han, fu, yakuman, ctx) {
  if (yakuman) return 8000 * yakuman;
  if (han >= 13) return 8000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han === 5) return MANGAN_BASE;
  if (ctx.rules.kiriageMangan && ((han === 4 && fu >= 30) || (han === 3 && fu >= 60))) {
    return MANGAN_BASE;
  }
  return Math.min(fu * 2 ** (2 + han), MANGAN_BASE);
}

export function calculateScore(han, fu, yakuman, ctx) {
  const base = basePointsFor(han, fu, yakuman, ctx);
  const honbaRon = 300 * ctx.honba;
  const honbaTsumo = 100 * ctx.honba;
  const sticks = 1000 * ctx.riichiSticks;

  let payments;
  if (ctx.isTsumo) {
    if (ctx.isDealer) {
      const each = roundUp100(base * 2) + honbaTsumo;
      payments = {
        fromDiscarder: 0, fromDealer: 0, fromEachNonDealer: each,
        riichiSticks: sticks, total: each * 3 + sticks,
      };
    } else {
      const fromDealer = roundUp100(base * 2) + honbaTsumo;
      const fromChild = roundUp100(base) + honbaTsumo;
      payments = {
        fromDiscarder: 0, fromDealer, fromEachNonDealer: fromChild,
        riichiSticks: sticks, total: fromDealer + fromChild * 2 + sticks,
      };
    }
  } else {
    const amount = roundUp100(base * (ctx.isDealer ? 6 : 4)) + honbaRon;
    payments = {
      fromDiscarder: amount, fromDealer: 0, fromEachNonDealer: 0,
      riichiSticks: sticks, total: amount + sticks,
    };
  }

  return { han, fu, yakuman, basePoints: base, limitName: limitName(han, yakuman, base), payments };
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

function describeHandShape(decomp) {
  if (decomp.form === HandForm.CHIITOITSU) return "七対子";
  if (decomp.form === HandForm.KOKUSHI) return "国士無双";
  const parts = [];
  if (decomp.pair !== null && decomp.pair !== undefined) {
    const pair = tileName(decomp.pair);
    parts.push(`[${pair}${pair}]`);
  }
  for (const group of decomp.groups) {
    parts.push("[" + group.tiles.map(tileName).join("") + "]");
  }
  return parts.join(" ");
}

function evaluate(hand, winTile, ctx, decomp) {
  const yaku = detect(hand, decomp, ctx, winTile);
  if (!yaku.length) return null;

  const yakumanTotal = yaku.reduce((sum, y) => sum + y.yakuman, 0);
  if (yakumanTotal) {
    const fuResult = calculateFu(hand, decomp, ctx, false);
    return {
      hand, winTile, context: ctx, decomposition: decomp,
      yaku, dora: [], fuResult,
      score: calculateScore(0, fuResult.fu, yakumanTotal, ctx),
      handShape: describeHandShape(decomp),
    };
  }

  const pinfu = yaku.some((y) => y.name === "平和");
  const fuResult = calculateFu(hand, decomp, ctx, pinfu);
  const dora = countDora(hand, ctx);
  const han = yaku.reduce((s, y) => s + y.han, 0) + dora.reduce((s, d) => s + d.han, 0);
  return {
    hand, winTile, context: ctx, decomposition: decomp,
    yaku, dora, fuResult,
    score: calculateScore(han, fuResult.fu, 0, ctx),
    handShape: describeHandShape(decomp),
  };
}

/**
 * 手牌・和了牌・状況から点数を計算する。
 * 複数の解釈が成り立つ場合は最も高くなるものを採用する (高点法)。
 */
export function calculate(hand, winTile, ctx) {
  validateContext(ctx);
  hand.validate();

  const decompositions = decompose(hand, winTile, ctx.isTsumo);
  if (!decompositions.length) throw new NotWinningHandError("和了形になっていません");

  const candidates = decompositions
    .map((d) => evaluate(hand, winTile, ctx, d))
    .filter(Boolean);
  if (!candidates.length) throw new NoYakuError("役がありません (ドラだけでは和了できません)");

  return candidates.reduce((best, calc) => {
    const rank = (c) => [c.score.yakuman, c.score.payments.total, c.score.han, c.score.fu];
    const a = rank(best);
    const b = rank(calc);
    for (let i = 0; i < a.length; i += 1) {
      if (b[i] !== a[i]) return b[i] > a[i] ? calc : best;
    }
    return best;
  });
}

export { Yaku };
