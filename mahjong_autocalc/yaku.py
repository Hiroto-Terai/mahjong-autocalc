"""役の判定。

``detect`` は与えられた解釈 (``Decomposition``) に対して成立する役をすべて返す。
役満が成立する場合は通常役を返さない (標準的な複合ルール)。
"""

from __future__ import annotations

from dataclasses import dataclass

from .context import WinContext
from .parser import Decomposition, Group, HandForm, Wait
from .tiles import (
    DRAGONS,
    GREEN_TILES,
    HONOR,
    HandTiles,
    WINDS,
    WIND_NAMES_JA,
    YAOCHU,
    count_tiles,
    is_honor,
    is_terminal,
    suit_of,
    tile_name,
)


@dataclass(frozen=True)
class Yaku:
    name: str
    han: int = 0
    yakuman: int = 0  # 0 = 通常役, 1 = 役満, 2 = ダブル役満

    @property
    def is_yakuman(self) -> bool:
        return self.yakuman > 0


def _numeric_suits(tiles: tuple[int, ...]) -> set[str]:
    return {suit_of(t) for t in tiles if not is_honor(t)}


def _run_counts(groups: tuple[Group, ...]) -> dict[int, int]:
    out: dict[int, int] = {}
    for group in groups:
        if group.is_run:
            out[group.tile] = out.get(group.tile, 0) + 1
    return out


def _yakuhai(decomp: Decomposition, ctx: WinContext) -> list[Yaku]:
    out: list[Yaku] = []
    for group in decomp.groups:
        if group.is_run:
            continue
        tile = group.tile
        if tile in DRAGONS:
            out.append(Yaku(f"役牌 {tile_name(tile)}", 1))
        else:
            if tile == ctx.round_wind:
                out.append(Yaku(f"場風 {WIND_NAMES_JA[tile]}", 1))
            if tile == ctx.seat_wind:
                out.append(Yaku(f"自風 {WIND_NAMES_JA[tile]}", 1))
    return out


def _is_pinfu(hand: HandTiles, decomp: Decomposition, ctx: WinContext) -> bool:
    if not hand.is_menzen or decomp.form is not HandForm.STANDARD:
        return False
    if any(not g.is_run for g in decomp.groups):
        return False
    if decomp.wait is not Wait.RYANMEN:
        return False
    pair = decomp.pair
    if pair in DRAGONS or pair == ctx.round_wind or pair == ctx.seat_wind:
        return False
    return True


def _chanta_family(decomp: Decomposition) -> str | None:
    """``"chanta"`` / ``"junchan"`` / ``None`` を返す。"""
    if decomp.form is not HandForm.STANDARD:
        return None
    parts: list[tuple[int, ...]] = [(decomp.pair, decomp.pair)]  # type: ignore[list-item]
    parts.extend(g.tiles for g in decomp.groups)
    if not all(any(t in YAOCHU for t in part) for part in parts):
        return None
    if not any(g.is_run for g in decomp.groups):
        # 順子を含まない全帯幺形は混老頭/清老頭として扱う。
        return None
    has_honor = any(is_honor(t) for part in parts for t in part)
    return "chanta" if has_honor else "junchan"


def _sanshoku_doujun(groups: tuple[Group, ...]) -> bool:
    by_rank: dict[int, set[str]] = {}
    for group in groups:
        if group.is_run and group.tile < HONOR:
            by_rank.setdefault(group.tile % 9, set()).add(suit_of(group.tile))
    return any(len(suits) == 3 for suits in by_rank.values())


def _sanshoku_doukou(groups: tuple[Group, ...]) -> bool:
    by_rank: dict[int, set[str]] = {}
    for group in groups:
        if group.is_triplet and group.tile < HONOR:
            by_rank.setdefault(group.tile % 9, set()).add(suit_of(group.tile))
    return any(len(suits) == 3 for suits in by_rank.values())


def _ittsuu(groups: tuple[Group, ...]) -> bool:
    runs = {g.tile for g in groups if g.is_run}
    for base in (0, 9, 18):
        if {base, base + 3, base + 6} <= runs:
            return True
    return False


def _chuuren(hand: HandTiles, decomp: Decomposition, win_tile: int) -> int:
    """九蓮宝燈なら 1 (純正なら 2)、不成立なら 0。"""
    if not hand.is_menzen or hand.melds:
        return 0
    tiles = hand.concealed
    if any(is_honor(t) for t in tiles):
        return 0
    if len({suit_of(t) for t in tiles}) != 1:
        return 0
    base = (tiles[0] // 9) * 9
    counts = count_tiles(tiles)[base : base + 9]
    required = [3, 1, 1, 1, 1, 1, 1, 1, 3]
    diff = [c - r for c, r in zip(counts, required)]
    if any(d < 0 for d in diff) or sum(diff) != 1:
        return 0
    # 純正九蓮宝燈: 和了牌を除いた 13 枚がちょうど 1112345678999 の形。
    extra = diff.index(1)
    return 2 if base + extra == win_tile else 1


def _suuankou(decomp: Decomposition) -> int:
    """四暗刻なら 1 (単騎なら 2)、不成立なら 0。"""
    if decomp.form is not HandForm.STANDARD:
        return 0
    concealed_triplets = [g for g in decomp.groups if g.is_triplet and g.concealed]
    if len(concealed_triplets) != 4:
        return 0
    return 2 if decomp.wait is Wait.TANKI else 1


def _detect_yakuman(
    hand: HandTiles, decomp: Decomposition, ctx: WinContext, win_tile: int
) -> list[Yaku]:
    out: list[Yaku] = []
    tiles = decomp.all_tiles if decomp.form is not HandForm.CHIITOITSU else hand.all_tiles

    if ctx.is_tenhou:
        out.append(Yaku("天和", yakuman=1))
    if ctx.is_chiihou:
        out.append(Yaku("地和", yakuman=1))

    if decomp.form is HandForm.KOKUSHI:
        thirteen_wait = decomp.pair == win_tile
        out.append(
            Yaku("国士無双十三面待ち", yakuman=2)
            if thirteen_wait
            else Yaku("国士無双", yakuman=1)
        )
        return out

    if decomp.form is HandForm.STANDARD:
        triplet_tiles = [g.tile for g in decomp.groups if g.is_triplet]

        suuankou = _suuankou(decomp)
        if suuankou == 2:
            out.append(Yaku("四暗刻単騎", yakuman=2))
        elif suuankou == 1:
            out.append(Yaku("四暗刻", yakuman=1))

        dragons_in_triplets = [t for t in triplet_tiles if t in DRAGONS]
        if len(dragons_in_triplets) == 3:
            out.append(Yaku("大三元", yakuman=1))

        winds_in_triplets = [t for t in triplet_tiles if t in WINDS]
        if len(winds_in_triplets) == 4:
            out.append(Yaku("大四喜", yakuman=2))
        elif len(winds_in_triplets) == 3 and decomp.pair in WINDS:
            out.append(Yaku("小四喜", yakuman=1))

        if sum(1 for g in decomp.groups if g.is_kan) == 4:
            out.append(Yaku("四槓子", yakuman=1))

        chuuren = _chuuren(hand, decomp, win_tile)
        if chuuren == 2:
            out.append(Yaku("純正九蓮宝燈", yakuman=2))
        elif chuuren == 1:
            out.append(Yaku("九蓮宝燈", yakuman=1))

        if all(t in GREEN_TILES for t in tiles):
            out.append(Yaku("緑一色", yakuman=1))

        if all(is_terminal(t) for t in tiles):
            out.append(Yaku("清老頭", yakuman=1))

    if all(is_honor(t) for t in tiles):
        out.append(Yaku("字一色", yakuman=1))

    return out


def _detect_normal(
    hand: HandTiles, decomp: Decomposition, ctx: WinContext, win_tile: int
) -> list[Yaku]:
    out: list[Yaku] = []
    menzen = hand.is_menzen
    tiles = decomp.all_tiles if decomp.form is not HandForm.CHIITOITSU else hand.all_tiles

    # --- 状況役 -------------------------------------------------------
    if ctx.is_double_riichi:
        out.append(Yaku("ダブル立直", 2))
    elif ctx.is_riichi:
        out.append(Yaku("立直", 1))
    if ctx.is_ippatsu:
        out.append(Yaku("一発", 1))
    if ctx.is_tsumo and menzen:
        out.append(Yaku("門前清自摸和", 1))
    if ctx.is_haitei:
        out.append(Yaku("海底摸月", 1))
    if ctx.is_houtei:
        out.append(Yaku("河底撈魚", 1))
    if ctx.is_rinshan:
        out.append(Yaku("嶺上開花", 1))
    if ctx.is_chankan:
        out.append(Yaku("搶槓", 1))

    # --- 形役 ---------------------------------------------------------
    if decomp.form is HandForm.CHIITOITSU:
        out.append(Yaku("七対子", 2))
    else:
        out.extend(_yakuhai(decomp, ctx))
        if _is_pinfu(hand, decomp, ctx):
            out.append(Yaku("平和", 1))

        if menzen:
            pairs = sum(n // 2 for n in _run_counts(decomp.groups).values())
            if pairs >= 2:
                out.append(Yaku("二盃口", 3))
            elif pairs == 1:
                out.append(Yaku("一盃口", 1))

        if _sanshoku_doujun(decomp.groups):
            out.append(Yaku("三色同順", 2 if menzen else 1))
        if _ittsuu(decomp.groups):
            out.append(Yaku("一気通貫", 2 if menzen else 1))
        if _sanshoku_doukou(decomp.groups):
            out.append(Yaku("三色同刻", 2))

        chanta = _chanta_family(decomp)
        if chanta == "chanta":
            out.append(Yaku("混全帯幺九", 2 if menzen else 1))
        elif chanta == "junchan":
            out.append(Yaku("純全帯幺九", 3 if menzen else 2))

        if all(g.is_triplet for g in decomp.groups):
            out.append(Yaku("対々和", 2))

        concealed_triplets = sum(1 for g in decomp.groups if g.is_triplet and g.concealed)
        if concealed_triplets == 3:
            out.append(Yaku("三暗刻", 2))

        kans = sum(1 for g in decomp.groups if g.is_kan)
        if kans == 3:
            out.append(Yaku("三槓子", 2))

        dragon_triplets = [g for g in decomp.groups if g.is_triplet and g.tile in DRAGONS]
        if len(dragon_triplets) == 2 and decomp.pair in DRAGONS:
            out.append(Yaku("小三元", 2))

    # --- 牌の種類による役 ---------------------------------------------
    if not any(t in YAOCHU for t in tiles):
        if menzen or ctx.rules.allow_kuitan:
            out.append(Yaku("断幺九", 1))

    if all(t in YAOCHU for t in tiles) and any(is_honor(t) for t in tiles):
        if any(not is_honor(t) for t in tiles):
            out.append(Yaku("混老頭", 2))

    suits = _numeric_suits(tiles)
    has_honor = any(is_honor(t) for t in tiles)
    if len(suits) == 1 and not has_honor:
        out.append(Yaku("清一色", 6 if menzen else 5))
    elif len(suits) <= 1 and has_honor and suits:
        out.append(Yaku("混一色", 3 if menzen else 2))

    return out


def detect(
    hand: HandTiles, decomp: Decomposition, ctx: WinContext, win_tile: int
) -> list[Yaku]:
    """成立する役の一覧を返す。役満成立時は役満のみを返す。"""
    yakuman = _detect_yakuman(hand, decomp, ctx, win_tile)
    if yakuman:
        if not ctx.rules.double_yakuman:
            yakuman = [
                Yaku(y.name, yakuman=1) if y.yakuman > 1 else y for y in yakuman
            ]
        if not ctx.rules.multiple_yakuman:
            yakuman = [max(yakuman, key=lambda y: y.yakuman)]
        return yakuman
    return _detect_normal(hand, decomp, ctx, win_tile)


def count_dora(hand: HandTiles, ctx: WinContext) -> list[Yaku]:
    """ドラ・赤ドラ・裏ドラを翻数として数える (役ではないので役の有無とは別扱い)。"""
    from .tiles import dora_indicator_to_dora

    out: list[Yaku] = []
    tiles = hand.all_tiles

    dora = 0
    for indicator in ctx.dora_indicators:
        target = dora_indicator_to_dora(indicator)
        dora += sum(1 for t in tiles if t == target)
    if dora:
        out.append(Yaku("ドラ", dora))

    reds = len(hand.all_red_fives)
    if reds:
        out.append(Yaku("赤ドラ", reds))

    ura = 0
    if ctx.is_riichi or ctx.is_double_riichi:
        for indicator in ctx.ura_indicators:
            target = dora_indicator_to_dora(indicator)
            ura += sum(1 for t in tiles if t == target)
    if ura:
        out.append(Yaku("裏ドラ", ura))

    return out


__all__ = ["Yaku", "count_dora", "detect"]
