// JS 版点数計算エンジンのテスト。Python 版 tests/test_score_engine.py と同じ期待値。
//   node --test webapp/tests/

import assert from "node:assert/strict";
import test from "node:test";

import { HandTiles, Meld, MeldType, EAST, SOUTH, parseTiles } from "../engine/tiles.js";
import {
  NoYakuError, NotWinningHandError, calculate, calculateScore, makeContext,
} from "../engine/scoring.js";

const hand = (notation, ...melds) => {
  const { tiles, redFives } = parseTiles(notation);
  return new HandTiles(tiles, melds, redFives);
};

const one = (notation) => {
  const { tiles } = parseTiles(notation);
  assert.equal(tiles.length, 1);
  return tiles[0];
};

const meld = (kind, notation) => {
  const { tiles, redFives } = parseTiles(notation);
  return new Meld(kind, tiles, redFives);
};

const yakuNames = (calc) => new Set(calc.yaku.map((y) => y.name));

// ---------------------------------------------------------------------------
// 基本形
// ---------------------------------------------------------------------------

test("平和ツモは 20 符固定", () => {
  const calc = calculate(hand("234567m234567p33s"), one("7m"),
    makeContext({ isTsumo: true, seatWind: SOUTH }));
  assert.equal(calc.fuResult.fu, 20);
  assert.ok(yakuNames(calc).has("平和"));
  assert.ok(yakuNames(calc).has("門前清自摸和"));
  assert.equal(calc.score.han, 3);
  assert.equal(calc.score.payments.fromEachNonDealer, 700);
  assert.equal(calc.score.payments.fromDealer, 1300);
  assert.equal(calc.score.payments.total, 2700);
});

test("平和ロンは 30 符", () => {
  const calc = calculate(hand("234567m234567p33s"), one("7m"),
    makeContext({ isTsumo: false, seatWind: SOUTH }));
  assert.equal(calc.fuResult.fu, 30);
  assert.equal(calc.score.han, 2);
  assert.equal(calc.score.payments.fromDiscarder, 2000);
});

test("立直+一発+ツモ+裏ドラで跳満", () => {
  const calc = calculate(hand("234567m234567p33s"), one("3s"),
    makeContext({
      isTsumo: true, isRiichi: true, isIppatsu: true, seatWind: SOUTH,
      uraIndicators: [one("2s")],
    }));
  assert.equal(calc.score.han, 6);
  assert.equal(calc.score.limitName, "跳満");
  assert.equal(calc.score.payments.total, 12000);
});

test("喰い断あり", () => {
  const calc = calculate(hand("234m567m22s", meld(MeldType.CHII, "456p"), meld(MeldType.PON, "888s")),
    one("2s"), makeContext({ seatWind: SOUTH }));
  assert.deepEqual([...yakuNames(calc)], ["断幺九"]);
  assert.equal(calc.score.han, 1);
});

test("喰い断なしなら役なし", () => {
  assert.throws(() => calculate(
    hand("234m567m22s", meld(MeldType.CHII, "456p"), meld(MeldType.PON, "888s")),
    one("2s"), makeContext({ seatWind: SOUTH, rules: { allowKuitan: false } })
  ), NoYakuError);
});

test("ドラのみでは和了できない", () => {
  assert.throws(() => calculate(hand("123456m789p22345s"), one("2s"),
    makeContext({ seatWind: SOUTH, doraIndicators: [one("8p")] })), NoYakuError);
});

test("和了形でなければエラー", () => {
  assert.throws(() => calculate(hand("123456m789p22357s"), one("7s"),
    makeContext({ seatWind: SOUTH })), NotWinningHandError);
});

// ---------------------------------------------------------------------------
// 符計算
// ---------------------------------------------------------------------------

test("暗刻(幺九)+嵌張+門前ロン = 40符", () => {
  const calc = calculate(hand("111m345m789m11p234s"), one("4m"),
    makeContext({ seatWind: SOUTH, isRiichi: true }));
  assert.equal(calc.fuResult.fu, 40);
  const detail = Object.fromEntries(calc.fuResult.details.map((d) => [d.label, d.fu]));
  assert.equal(detail["嵌張待ち"], 2);
  assert.ok(Object.keys(detail).some((k) => k.includes("暗刻") && k.includes("一萬")));
});

test("鳴いた平和形は 30 符", () => {
  const calc = calculate(hand("234m567m22s", meld(MeldType.CHII, "456p"), meld(MeldType.CHII, "678s")),
    one("2s"), makeContext({ seatWind: SOUTH }));
  assert.equal(calc.fuResult.fu, 30);
});

test("七対子は 25符2翻", () => {
  const calc = calculate(hand("1133m5588p224477s"), one("7s"), makeContext({ seatWind: SOUTH }));
  assert.equal(calc.fuResult.fu, 25);
  assert.ok(yakuNames(calc).has("七対子"));
  assert.equal(calc.score.han, 2);
  assert.equal(calc.score.payments.fromDiscarder, 1600);
});

test("字牌の暗槓は 32 符", () => {
  const calc = calculate(hand("234m567m234p55s", meld(MeldType.CLOSED_KAN, "1111z")),
    one("5s"), makeContext({ seatWind: EAST, roundWind: EAST, isTsumo: true }));
  assert.ok(calc.fuResult.details.some((d) => d.fu === 32));
});

// ---------------------------------------------------------------------------
// 役
// ---------------------------------------------------------------------------

test("連風牌は場風+自風で 2 翻", () => {
  const calc = calculate(hand("234m567m234p55s111z"), one("5s"),
    makeContext({ seatWind: EAST, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("場風 東"));
  assert.ok(yakuNames(calc).has("自風 東"));
});

test("三色同順は食い下がる", () => {
  const closed = calculate(hand("345m345p345s11z678m"), one("8m"), makeContext({ seatWind: SOUTH }));
  assert.equal(closed.yaku.find((y) => y.name === "三色同順").han, 2);

  const opened = calculate(hand("345m345p11z678m", meld(MeldType.CHII, "345s")), one("8m"),
    makeContext({ seatWind: SOUTH }));
  assert.equal(opened.yaku.find((y) => y.name === "三色同順").han, 1);
});

test("一気通貫", () => {
  const calc = calculate(hand("123456789m234p55s"), one("5s"), makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(calc).has("一気通貫"));
});

test("一盃口と二盃口", () => {
  const iipeiko = calculate(hand("112233m456p789s11z"), one("1z"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(iipeiko).has("一盃口"));

  const ryanpeikou = calculate(hand("112233m445566p11s"), one("1s"), makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(ryanpeikou).has("二盃口"));
  assert.ok(!yakuNames(ryanpeikou).has("七対子"));
});

test("対々和と三暗刻", () => {
  const calc = calculate(hand("111m333p555s22z", meld(MeldType.PON, "777s")), one("2z"),
    makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(calc).has("対々和"));
  assert.ok(yakuNames(calc).has("三暗刻"));
});

test("シャンポンロンは四暗刻にならない", () => {
  const calc = calculate(hand("111m333p555s777s22z"), one("7s"),
    makeContext({ seatWind: SOUTH, isTsumo: false }));
  assert.ok(!yakuNames(calc).has("四暗刻"));
  assert.ok(yakuNames(calc).has("三暗刻"));
  assert.ok(yakuNames(calc).has("対々和"));
});

test("シャンポンツモは四暗刻", () => {
  const calc = calculate(hand("111m333p555s777s22z"), one("7s"),
    makeContext({ seatWind: SOUTH, isTsumo: true }));
  assert.ok(yakuNames(calc).has("四暗刻"));
  assert.equal(calc.score.payments.total, 32000);
});

test("四暗刻単騎はダブル役満", () => {
  const calc = calculate(hand("111m333p555s777s22z"), one("2z"),
    makeContext({ seatWind: SOUTH, isTsumo: false }));
  assert.ok(yakuNames(calc).has("四暗刻単騎"));
  assert.equal(calc.score.payments.total, 64000);
});

test("混一色と清一色", () => {
  const honitsu = calculate(hand("123456789m11z234m"), one("4m"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(honitsu).has("混一色"));

  const chinitsu = calculate(hand("123456789234m11m"), one("4m"), makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(chinitsu).has("清一色"));
});

test("混全帯幺九と純全帯幺九", () => {
  const chanta = calculate(hand("123m789m123p11z999s"), one("9s"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(chanta).has("混全帯幺九"));

  const junchan = calculate(hand("123m789m123p11s999s"), one("9s"), makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(junchan).has("純全帯幺九"));
  assert.ok(!yakuNames(junchan).has("混全帯幺九"));
});

test("混老頭は混全帯幺九と複合しない", () => {
  const calc = calculate(hand("111m999m111p11z999s"), one("9s"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("混老頭"));
  assert.ok(yakuNames(calc).has("対々和"));
  assert.ok(!yakuNames(calc).has("混全帯幺九"));
});

test("小三元", () => {
  const calc = calculate(hand("555z666z77z234m567m"), one("7m"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("小三元"));
});

// ---------------------------------------------------------------------------
// 役満
// ---------------------------------------------------------------------------

test("国士無双と十三面待ち", () => {
  const single = calculate(hand("19m19p19s1234567z1z"), one("1m"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(single).has("国士無双"));
  assert.equal(single.score.payments.fromDiscarder, 32000);

  const thirteen = calculate(hand("19m19p19s1234567z1z"), one("1z"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(thirteen).has("国士無双十三面待ち"));
  assert.equal(thirteen.score.payments.fromDiscarder, 64000);
});

test("大三元", () => {
  const calc = calculate(hand("555z666z777z234m11p"), one("1p"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("大三元"));
});

test("字一色と大四喜", () => {
  const calc = calculate(hand("111z222z333z444z55z"), one("5z"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("字一色"));
  assert.ok(yakuNames(calc).has("大四喜"));
});

test("緑一色", () => {
  const calc = calculate(hand("222s333s444s666s66z"), one("6z"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("緑一色"));
});

test("清老頭", () => {
  const calc = calculate(hand("111m999m111p999p11s"), one("1s"),
    makeContext({ seatWind: SOUTH, roundWind: EAST }));
  assert.ok(yakuNames(calc).has("清老頭"));
});

test("純正九蓮宝燈", () => {
  const calc = calculate(hand("1112345678999m5m"), one("5m"), makeContext({ seatWind: SOUTH }));
  assert.ok(yakuNames(calc).has("純正九蓮宝燈"));
  assert.equal(calc.score.payments.fromDiscarder, 64000);
});

// ---------------------------------------------------------------------------
// 点数表
// ---------------------------------------------------------------------------

test("ロンの点数表", () => {
  const cases = [
    [1, 30, false, 1000], [1, 40, false, 1300], [2, 30, false, 2000],
    [3, 30, false, 3900], [4, 30, false, 7700], [4, 40, false, 8000],
    [5, 30, false, 8000], [1, 30, true, 1500], [2, 30, true, 2900],
    [3, 40, true, 7700], [4, 30, true, 11600], [6, 30, true, 18000],
  ];
  for (const [han, fu, dealer, expected] of cases) {
    const ctx = makeContext({ seatWind: dealer ? EAST : SOUTH, isTsumo: false });
    assert.equal(calculateScore(han, fu, 0, ctx).payments.fromDiscarder, expected,
      `${han}翻${fu}符 ${dealer ? "親" : "子"}`);
  }
});

test("ツモの点数表", () => {
  const cases = [
    [1, 30, false, 500, 300], [2, 30, false, 1000, 500], [3, 30, false, 2000, 1000],
    [4, 30, false, 3900, 2000], [2, 30, true, 0, 1000], [3, 40, true, 0, 2600],
    [5, 30, true, 0, 4000],
  ];
  for (const [han, fu, dealer, fromDealer, fromChild] of cases) {
    const ctx = makeContext({ seatWind: dealer ? EAST : SOUTH, isTsumo: true });
    const r = calculateScore(han, fu, 0, ctx);
    assert.equal(r.payments.fromDealer, fromDealer, `${han}翻${fu}符 親から`);
    assert.equal(r.payments.fromEachNonDealer, fromChild, `${han}翻${fu}符 子から`);
  }
});

test("本場と供託", () => {
  const ctx = makeContext({ seatWind: SOUTH, isTsumo: false, honba: 2, riichiSticks: 1 });
  const r = calculateScore(1, 30, 0, ctx);
  assert.equal(r.payments.fromDiscarder, 1600);
  assert.equal(r.payments.total, 2600);
});

test("切り上げ満貫", () => {
  assert.equal(calculateScore(4, 30, 0, makeContext({ seatWind: SOUTH })).payments.fromDiscarder, 7700);
  assert.equal(
    calculateScore(4, 30, 0, makeContext({ seatWind: SOUTH, rules: { kiriageMangan: true } }))
      .payments.fromDiscarder, 8000);
});

test("赤ドラが数えられる", () => {
  const calc = calculate(hand("234067m234567p33s"), one("3s"),
    makeContext({ isTsumo: false, seatWind: SOUTH }));
  assert.ok(calc.dora.some((d) => d.name === "赤ドラ" && d.han === 1));
});

test("高点法で高い解釈を選ぶ", () => {
  const calc = calculate(hand("111222333m456p11s"), one("1s"),
    makeContext({ seatWind: SOUTH, isTsumo: true }));
  assert.ok(yakuNames(calc).has("三暗刻"));
});
