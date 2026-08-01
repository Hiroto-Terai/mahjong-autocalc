"""符計算。"""

from __future__ import annotations

from dataclasses import dataclass

from .context import WinContext
from .parser import Decomposition, HandForm, Wait
from .tiles import DRAGONS, HandTiles, WIND_NAMES_JA, tile_name

CHIITOITSU_FU = 25
BASE_FU = 20


@dataclass(frozen=True)
class FuDetail:
    label: str
    fu: int


@dataclass(frozen=True)
class FuResult:
    fu: int
    raw_fu: int
    details: tuple[FuDetail, ...]


def _pair_fu(decomp: Decomposition, ctx: WinContext) -> tuple[int, str | None]:
    pair = decomp.pair
    if pair is None:
        return 0, None
    if pair in DRAGONS:
        return 2, f"雀頭 {tile_name(pair)}"
    is_round = pair == ctx.round_wind
    is_seat = pair == ctx.seat_wind
    if is_round and is_seat:
        return ctx.rules.double_wind_pair_fu, f"雀頭 連風牌 {WIND_NAMES_JA[pair]}"
    if is_round:
        return 2, f"雀頭 場風 {WIND_NAMES_JA[pair]}"
    if is_seat:
        return 2, f"雀頭 自風 {WIND_NAMES_JA[pair]}"
    return 0, None


def _group_label(group) -> str:
    kind = "順子" if group.is_run else ("槓子" if group.is_kan else "刻子")
    state = "暗" if group.concealed else "明"
    tiles = "".join(tile_name(t) for t in group.tiles[:3])
    return f"{state}{kind} {tiles}"


def calculate_fu(
    hand: HandTiles,
    decomp: Decomposition,
    ctx: WinContext,
    *,
    is_pinfu: bool,
) -> FuResult:
    """解釈ひとつぶんの符を計算する。

    ``is_pinfu`` は役判定側で確定した平和の成立可否。平和ツモの 20 符固定と
    ツモ符の扱いに必要なため引数で受け取る。
    """
    if decomp.form is HandForm.CHIITOITSU:
        return FuResult(
            CHIITOITSU_FU, CHIITOITSU_FU, (FuDetail("七対子固定", CHIITOITSU_FU),)
        )
    if decomp.form is HandForm.KOKUSHI:
        # 役満なので符は点数に影響しないが、表示用に副底のみ返す。
        return FuResult(BASE_FU, BASE_FU, (FuDetail("副底", BASE_FU),))

    details = [FuDetail("副底", BASE_FU)]
    total = BASE_FU

    if is_pinfu and ctx.is_tsumo:
        return FuResult(BASE_FU, BASE_FU, (FuDetail("平和ツモ固定", BASE_FU),))

    if hand.is_menzen and not ctx.is_tsumo:
        details.append(FuDetail("門前ロン", 10))
        total += 10

    if ctx.is_tsumo and not is_pinfu:
        details.append(FuDetail("ツモ", 2))
        total += 2

    for group in decomp.groups:
        fu = group.fu()
        if fu:
            details.append(FuDetail(_group_label(group), fu))
            total += fu

    pair_fu, pair_label = _pair_fu(decomp, ctx)
    if pair_fu and pair_label:
        details.append(FuDetail(pair_label, pair_fu))
        total += pair_fu

    wait_fu = decomp.wait.fu
    if wait_fu:
        labels = {
            Wait.PENCHAN: "辺張待ち",
            Wait.KANCHAN: "嵌張待ち",
            Wait.TANKI: "単騎待ち",
        }
        details.append(FuDetail(labels[decomp.wait], wait_fu))
        total += wait_fu

    raw = total
    rounded = -(-total // 10) * 10
    if not hand.is_menzen and rounded == BASE_FU:
        # 鳴いた平和形は 30 符として扱う (いわゆる食い平和)。
        rounded = 30
        details.append(FuDetail("食い平和形の補正", 10))

    return FuResult(rounded, raw, tuple(details))


__all__ = ["FuDetail", "FuResult", "calculate_fu"]
