"""点数計算のエントリポイント。

複数の面子構成が成り立つ場合はすべて計算し、最も高くなる解釈を採用する
(高点法)。
"""

from __future__ import annotations

from dataclasses import dataclass

from .context import WinContext
from .fu import FuResult, calculate_fu
from .parser import Decomposition, HandForm, decompose
from .score import ScoreResult, calculate_score
from .tiles import HandTiles, tile_name
from .yaku import Yaku, count_dora, detect


class NoYakuError(ValueError):
    """役がなく和了できない場合。"""


class NotWinningHandError(ValueError):
    """和了形になっていない場合。"""


@dataclass(frozen=True)
class Calculation:
    hand: HandTiles
    win_tile: int
    context: WinContext
    decomposition: Decomposition
    yaku: tuple[Yaku, ...]
    dora: tuple[Yaku, ...]
    fu_result: FuResult
    score: ScoreResult

    @property
    def han(self) -> int:
        return self.score.han

    @property
    def fu(self) -> int:
        return self.score.fu

    @property
    def is_yakuman(self) -> bool:
        return self.score.yakuman > 0

    def describe_hand_shape(self) -> str:
        if self.decomposition.form is HandForm.CHIITOITSU:
            return "七対子"
        if self.decomposition.form is HandForm.KOKUSHI:
            return "国士無双"
        parts = []
        if self.decomposition.pair is not None:
            pair = tile_name(self.decomposition.pair)
            parts.append(f"[{pair}{pair}]")
        for group in self.decomposition.groups:
            parts.append("[" + "".join(tile_name(t) for t in group.tiles) + "]")
        return " ".join(parts)


def _evaluate(
    hand: HandTiles, win_tile: int, ctx: WinContext, decomp: Decomposition
) -> Calculation | None:
    yaku = detect(hand, decomp, ctx, win_tile)
    if not yaku:
        return None

    yakuman_total = sum(y.yakuman for y in yaku)
    if yakuman_total:
        fu_result = calculate_fu(hand, decomp, ctx, is_pinfu=False)
        dora: tuple[Yaku, ...] = ()
        score = calculate_score(0, fu_result.fu, yakuman_total, ctx)
        return Calculation(
            hand, win_tile, ctx, decomp, tuple(yaku), dora, fu_result, score
        )

    is_pinfu = any(y.name == "平和" for y in yaku)
    fu_result = calculate_fu(hand, decomp, ctx, is_pinfu=is_pinfu)
    dora = tuple(count_dora(hand, ctx))
    han = sum(y.han for y in yaku) + sum(d.han for d in dora)
    score = calculate_score(han, fu_result.fu, 0, ctx)
    return Calculation(hand, win_tile, ctx, decomp, tuple(yaku), dora, fu_result, score)


def _rank(calc: Calculation) -> tuple[int, int, int, int]:
    return (
        calc.score.yakuman,
        calc.score.payments.total,
        calc.score.han,
        calc.score.fu,
    )


def calculate(hand: HandTiles, win_tile: int, ctx: WinContext) -> Calculation:
    """手牌・和了牌・状況から点数を計算する。

    Raises:
        NotWinningHandError: 和了形になっていない。
        NoYakuError: 和了形だが役がない (ドラのみ)。
    """
    ctx.validate()
    hand.validate()

    decompositions = decompose(hand, win_tile, ctx.is_tsumo)
    if not decompositions:
        raise NotWinningHandError("和了形になっていません")

    candidates = [
        calc
        for decomp in decompositions
        if (calc := _evaluate(hand, win_tile, ctx, decomp)) is not None
    ]
    if not candidates:
        raise NoYakuError("役がありません (ドラだけでは和了できません)")

    return max(candidates, key=_rank)


__all__ = ["Calculation", "NoYakuError", "NotWinningHandError", "calculate"]
