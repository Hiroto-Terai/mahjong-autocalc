"""基本点と支払いの計算。"""

from __future__ import annotations

from dataclasses import dataclass

from .context import WinContext

MANGAN_BASE = 2000


def _round_up_100(value: int) -> int:
    return -(-value // 100) * 100


@dataclass(frozen=True)
class Payments:
    """支払いの内訳。本場・供託を含む。"""

    from_discarder: int = 0
    """ロン和了で放銃者が支払う点数 (本場込み)。"""

    from_dealer: int = 0
    """子のツモ和了で親が支払う点数 (本場込み)。"""

    from_each_non_dealer: int = 0
    """ツモ和了で子ひとりが支払う点数 (本場込み)。"""

    riichi_sticks: int = 0
    """供託から受け取る点数。"""

    total: int = 0
    """和了者の収入合計。"""


@dataclass(frozen=True)
class ScoreResult:
    han: int
    fu: int
    yakuman: int
    base_points: int
    limit_name: str
    payments: Payments


def limit_name(han: int, yakuman: int, base_points: int) -> str:
    if yakuman:
        names = {1: "役満", 2: "ダブル役満", 3: "トリプル役満"}
        return names.get(yakuman, f"{yakuman}倍役満")
    if han >= 13:
        return "数え役満"
    if han >= 11:
        return "三倍満"
    if han >= 8:
        return "倍満"
    if han >= 6:
        return "跳満"
    if base_points >= MANGAN_BASE:
        return "満貫"
    return ""


def base_points_for(han: int, fu: int, yakuman: int, ctx: WinContext) -> int:
    """基本点 (子のロンで 4 倍する前の値) を求める。"""
    if yakuman:
        return 8000 * yakuman
    if han >= 13:
        return 8000
    if han >= 11:
        return 6000
    if han >= 8:
        return 4000
    if han >= 6:
        return 3000
    if han == 5:
        return MANGAN_BASE
    if ctx.rules.kiriage_mangan and ((han == 4 and fu >= 30) or (han == 3 and fu >= 60)):
        return MANGAN_BASE
    return min(fu * (2 ** (2 + han)), MANGAN_BASE)


def calculate_score(han: int, fu: int, yakuman: int, ctx: WinContext) -> ScoreResult:
    base = base_points_for(han, fu, yakuman, ctx)
    honba_bonus_ron = 300 * ctx.honba
    honba_bonus_tsumo = 100 * ctx.honba
    sticks = 1000 * ctx.riichi_sticks

    if ctx.is_tsumo:
        if ctx.is_dealer:
            each = _round_up_100(base * 2) + honba_bonus_tsumo
            total = each * 3 + sticks
            payments = Payments(
                from_each_non_dealer=each,
                riichi_sticks=sticks,
                total=total,
            )
        else:
            from_dealer = _round_up_100(base * 2) + honba_bonus_tsumo
            from_child = _round_up_100(base) + honba_bonus_tsumo
            total = from_dealer + from_child * 2 + sticks
            payments = Payments(
                from_dealer=from_dealer,
                from_each_non_dealer=from_child,
                riichi_sticks=sticks,
                total=total,
            )
    else:
        multiplier = 6 if ctx.is_dealer else 4
        amount = _round_up_100(base * multiplier) + honba_bonus_ron
        payments = Payments(
            from_discarder=amount,
            riichi_sticks=sticks,
            total=amount + sticks,
        )

    return ScoreResult(
        han=han,
        fu=fu,
        yakuman=yakuman,
        base_points=base,
        limit_name=limit_name(han, yakuman, base),
        payments=payments,
    )


__all__ = ["Payments", "ScoreResult", "base_points_for", "calculate_score", "limit_name"]
