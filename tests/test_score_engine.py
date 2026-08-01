"""点数計算エンジンのテスト。

期待値は一般的な麻雀ルール (アリアリ・喰い断あり・切り上げ満貫なし) に基づく。
"""

from __future__ import annotations

import pytest

from mahjong_autocalc import (
    HandTiles,
    NoYakuError,
    NotWinningHandError,
    Rules,
    WinContext,
    calculate,
    make_meld,
)
from mahjong_autocalc.tiles import EAST, SOUTH, parse_tiles as pt


def hand(notation: str, *melds) -> HandTiles:
    parsed = pt(notation)
    return HandTiles(tuple(sorted(parsed.tiles)), tuple(melds), parsed.red_fives)


def one(notation: str) -> int:
    parsed = pt(notation)
    assert len(parsed.tiles) == 1
    return parsed.tiles[0]


def yaku_names(calc) -> set[str]:
    return {y.name for y in calc.yaku}


# ---------------------------------------------------------------------------
# 基本形
# ---------------------------------------------------------------------------


def test_pinfu_tsumo_is_20_fu():
    """平和ツモは 20 符固定、門前ツモと合わせて 2 翻。"""
    calc = calculate(
        hand("234567m234567p33s"),
        one("7m"),
        WinContext(is_tsumo=True, seat_wind=SOUTH),
    )
    assert calc.fu == 20
    assert "平和" in yaku_names(calc)
    assert "門前清自摸和" in yaku_names(calc)
    assert calc.han == 3  # 平和 + ツモ + 断幺九
    # 子の 20符3翻 ツモ: 子 700 / 親 1300
    assert calc.score.payments.from_each_non_dealer == 700
    assert calc.score.payments.from_dealer == 1300
    assert calc.score.payments.total == 2700


def test_pinfu_ron_is_30_fu():
    calc = calculate(
        hand("234567m234567p33s"),
        one("7m"),
        WinContext(is_tsumo=False, seat_wind=SOUTH),
    )
    assert calc.fu == 30
    assert calc.han == 2  # 平和 + 断幺九
    assert calc.score.payments.from_discarder == 2000


def test_riichi_pinfu_tsumo_ippatsu_ura():
    calc = calculate(
        hand("234567m234567p33s"),
        one("3s"),
        WinContext(
            is_tsumo=True,
            is_riichi=True,
            is_ippatsu=True,
            seat_wind=SOUTH,
            ura_indicators=(one("2s"),),
        ),
    )
    # 立直1 + 一発1 + ツモ1 + 平和1 + 裏ドラ2 = 6翻 → 跳満
    assert calc.han == 6
    assert calc.score.limit_name == "跳満"
    assert calc.score.payments.total == 12000


def test_tanyao_open_with_kuitan():
    calc = calculate(
        hand("234m567m22s", make_meld("chii", "456p"), make_meld("pon", "888s")),
        one("2s"),
        WinContext(seat_wind=SOUTH),
    )
    assert yaku_names(calc) == {"断幺九"}
    assert calc.han == 1


def test_kuitan_disabled_means_no_yaku():
    with pytest.raises(NoYakuError):
        calculate(
            hand("234m567m22s", make_meld("chii", "456p"), make_meld("pon", "888s")),
            one("2s"),
            WinContext(seat_wind=SOUTH, rules=Rules(allow_kuitan=False)),
        )


def test_dora_only_is_not_a_win():
    with pytest.raises(NoYakuError):
        calculate(
            hand("123456m789p22345s"),
            one("2s"),
            WinContext(seat_wind=SOUTH, dora_indicators=(one("8p"),)),
        )


def test_not_a_winning_hand():
    with pytest.raises(NotWinningHandError):
        calculate(hand("123456m789p22357s"), one("7s"), WinContext(seat_wind=SOUTH))


# ---------------------------------------------------------------------------
# 符計算
# ---------------------------------------------------------------------------


def test_fu_closed_terminal_triplet_and_kanchan():
    """暗刻(幺九)8符 + 嵌張2符 + 門前ロン10符 + 副底20符 = 40符。"""
    calc = calculate(
        hand("111m345m789m11p234s"),
        one("4m"),
        WinContext(seat_wind=SOUTH, is_riichi=True),
    )
    assert calc.fu == 40
    detail = {d.label: d.fu for d in calc.fu_result.details}
    assert detail["嵌張待ち"] == 2
    assert any("暗刻" in k and "一萬" in k for k in detail)


def test_fu_open_hand_all_runs_rounds_to_30():
    calc = calculate(
        hand("234m567m22s", make_meld("chii", "456p"), make_meld("chii", "678s")),
        one("2s"),
        WinContext(seat_wind=SOUTH),
    )
    assert calc.fu == 30


def test_chiitoitsu_is_25_fu_2_han():
    calc = calculate(
        hand("1133m5588p224477s"),
        one("7s"),
        WinContext(seat_wind=SOUTH),
    )
    assert calc.fu == 25
    assert "七対子" in yaku_names(calc)
    assert calc.han == 2
    # 子 25符2翻 ロン = 1600
    assert calc.score.payments.from_discarder == 1600


def test_closed_kan_of_honors_gives_32_fu():
    calc = calculate(
        hand("234m567m234p55s", make_meld("closed_kan", "1111z")),
        one("5s"),
        WinContext(seat_wind=EAST, round_wind=EAST, is_tsumo=True),
    )
    detail = {d.label: d.fu for d in calc.fu_result.details}
    assert any(v == 32 for v in detail.values())


# ---------------------------------------------------------------------------
# 役
# ---------------------------------------------------------------------------


def test_double_wind_counts_twice():
    """東場の東家が東の刻子を持つと場風+自風で 2 翻。"""
    calc = calculate(
        hand("234m567m234p55s111z"),
        one("5s"),
        WinContext(seat_wind=EAST, round_wind=EAST),
    )
    names = yaku_names(calc)
    assert "場風 東" in names
    assert "自風 東" in names


def test_sanshoku_doujun_closed_and_open():
    closed = calculate(
        hand("345m345p345s11z678m"),
        one("8m"),
        WinContext(seat_wind=SOUTH),
    )
    assert "三色同順" in yaku_names(closed)
    assert next(y.han for y in closed.yaku if y.name == "三色同順") == 2

    opened = calculate(
        hand("345m345p11z678m", make_meld("chii", "345s")),
        one("8m"),
        WinContext(seat_wind=SOUTH),
    )
    assert next(y.han for y in opened.yaku if y.name == "三色同順") == 1


def test_ittsuu():
    calc = calculate(
        hand("123456789m234p55s"),
        one("5s"),
        WinContext(seat_wind=SOUTH),
    )
    assert "一気通貫" in yaku_names(calc)


def test_iipeiko_and_ryanpeikou():
    iipeiko = calculate(
        hand("112233m456p789s11z"),
        one("1z"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "一盃口" in yaku_names(iipeiko)

    ryanpeikou = calculate(
        hand("112233m445566p11s"),
        one("1s"),
        WinContext(seat_wind=SOUTH),
    )
    assert "二盃口" in yaku_names(ryanpeikou)
    assert "七対子" not in yaku_names(ryanpeikou)


def test_toitoi_and_sanankou():
    calc = calculate(
        hand("111m333p555s22z", make_meld("pon", "777s")),
        one("2z"),
        WinContext(seat_wind=SOUTH),
    )
    names = yaku_names(calc)
    assert "対々和" in names
    assert "三暗刻" in names


def test_ron_on_shanpon_does_not_give_suuankou():
    """ロンで完成した刻子は明刻扱い。四暗刻にはならず三暗刻+対々和。"""
    calc = calculate(
        hand("111m333p555s777s22z"),
        one("7s"),
        WinContext(seat_wind=SOUTH, is_tsumo=False),
    )
    names = yaku_names(calc)
    assert "四暗刻" not in names
    assert "三暗刻" in names
    assert "対々和" in names


def test_tsumo_on_shanpon_gives_suuankou():
    calc = calculate(
        hand("111m333p555s777s22z"),
        one("7s"),
        WinContext(seat_wind=SOUTH, is_tsumo=True),
    )
    assert "四暗刻" in yaku_names(calc)
    assert calc.score.payments.total == 32000


def test_suuankou_tanki_is_double_yakuman():
    calc = calculate(
        hand("111m333p555s777s22z"),
        one("2z"),
        WinContext(seat_wind=SOUTH, is_tsumo=False),
    )
    assert "四暗刻単騎" in yaku_names(calc)
    assert calc.score.payments.total == 64000


def test_honitsu_and_chinitsu():
    honitsu = calculate(
        hand("123456789m11z234m"),
        one("4m"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "混一色" in yaku_names(honitsu)

    chinitsu = calculate(
        hand("123456789234m11m"),
        one("4m"),
        WinContext(seat_wind=SOUTH),
    )
    assert "清一色" in yaku_names(chinitsu)


def test_chanta_and_junchan():
    chanta = calculate(
        hand("123m789m123p11z999s"),
        one("9s"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "混全帯幺九" in yaku_names(chanta)

    junchan = calculate(
        hand("123m789m123p11s999s"),
        one("9s"),
        WinContext(seat_wind=SOUTH),
    )
    assert "純全帯幺九" in yaku_names(junchan)
    assert "混全帯幺九" not in yaku_names(junchan)


def test_honroutou_with_toitoi():
    calc = calculate(
        hand("111m999m111p11z999s"),
        one("9s"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    names = yaku_names(calc)
    assert "混老頭" in names
    assert "対々和" in names
    assert "混全帯幺九" not in names


def test_shousangen():
    calc = calculate(
        hand("555z666z77z234m567m"),
        one("7m"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "小三元" in yaku_names(calc)


# ---------------------------------------------------------------------------
# 役満
# ---------------------------------------------------------------------------


def test_kokushi_and_thirteen_wait():
    single = calculate(
        hand("19m19p19s1234567z1z"),
        one("1m"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "国士無双" in yaku_names(single)
    assert single.score.payments.from_discarder == 32000

    thirteen = calculate(
        hand("19m19p19s1234567z1z"),
        one("1z"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "国士無双十三面待ち" in yaku_names(thirteen)
    assert thirteen.score.payments.from_discarder == 64000


def test_daisangen():
    calc = calculate(
        hand("555z666z777z234m11p"),
        one("1p"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "大三元" in yaku_names(calc)


def test_tsuuiisou():
    calc = calculate(
        hand("111z222z333z444z55z"),
        one("5z"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    names = yaku_names(calc)
    assert "字一色" in names
    assert "大四喜" in names


def test_ryuuiisou():
    calc = calculate(
        hand("222s333s444s666s66z"),
        one("6z"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "緑一色" in yaku_names(calc)


def test_chinroutou():
    calc = calculate(
        hand("111m999m111p999p11s"),
        one("1s"),
        WinContext(seat_wind=SOUTH, round_wind=EAST),
    )
    assert "清老頭" in yaku_names(calc)


def test_junsei_chuuren():
    calc = calculate(
        hand("1112345678999m5m"),
        one("5m"),
        WinContext(seat_wind=SOUTH),
    )
    assert "純正九蓮宝燈" in yaku_names(calc)
    assert calc.score.payments.from_discarder == 64000


# ---------------------------------------------------------------------------
# 点数表
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "han,fu,dealer,expected",
    [
        (1, 30, False, 1000),
        (1, 40, False, 1300),
        (2, 30, False, 2000),
        (3, 30, False, 3900),
        (4, 30, False, 7700),
        (4, 40, False, 8000),
        (5, 30, False, 8000),
        (1, 30, True, 1500),
        (2, 30, True, 2900),
        (3, 40, True, 7700),
        (4, 30, True, 11600),
        (6, 30, True, 18000),
    ],
)
def test_ron_score_table(han, fu, dealer, expected):
    from mahjong_autocalc.score import calculate_score

    ctx = WinContext(seat_wind=EAST if dealer else SOUTH, is_tsumo=False)
    result = calculate_score(han, fu, 0, ctx)
    assert result.payments.from_discarder == expected


@pytest.mark.parametrize(
    "han,fu,dealer,from_dealer,from_child",
    [
        (1, 30, False, 500, 300),
        (2, 30, False, 1000, 500),
        (3, 30, False, 2000, 1000),
        (4, 30, False, 3900, 2000),
        (2, 30, True, 0, 1000),
        (3, 40, True, 0, 2600),
        (5, 30, True, 0, 4000),
    ],
)
def test_tsumo_score_table(han, fu, dealer, from_dealer, from_child):
    from mahjong_autocalc.score import calculate_score

    ctx = WinContext(seat_wind=EAST if dealer else SOUTH, is_tsumo=True)
    result = calculate_score(han, fu, 0, ctx)
    assert result.payments.from_dealer == from_dealer
    assert result.payments.from_each_non_dealer == from_child


def test_honba_and_riichi_sticks():
    from mahjong_autocalc.score import calculate_score

    ctx = WinContext(seat_wind=SOUTH, is_tsumo=False, honba=2, riichi_sticks=1)
    result = calculate_score(1, 30, 0, ctx)
    assert result.payments.from_discarder == 1000 + 600
    assert result.payments.total == 1600 + 1000


def test_kiriage_mangan_rule():
    from mahjong_autocalc.score import calculate_score

    plain = calculate_score(4, 30, 0, WinContext(seat_wind=SOUTH))
    assert plain.payments.from_discarder == 7700

    kiriage = calculate_score(
        4, 30, 0, WinContext(seat_wind=SOUTH, rules=Rules(kiriage_mangan=True))
    )
    assert kiriage.payments.from_discarder == 8000


def test_red_five_counts_as_dora():
    calc = calculate(
        hand("234067m234567p33s"),
        one("3s"),
        WinContext(is_tsumo=False, seat_wind=SOUTH),
    )
    assert any(y.name == "赤ドラ" and y.han == 1 for y in calc.dora)


def test_highest_interpretation_is_chosen():
    """111222333m は三暗刻とも一盃口ともとれる。高い方を採用する。"""
    calc = calculate(
        hand("111222333m456p11s"),
        one("1s"),
        WinContext(seat_wind=SOUTH, is_tsumo=True),
    )
    names = yaku_names(calc)
    assert "三暗刻" in names
