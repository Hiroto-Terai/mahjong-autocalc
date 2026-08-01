"""手牌を面子構成 (4 面子 1 雀頭 / 七対子 / 国士無双) に分解する。

同じ手牌でも複数の解釈が成り立つことがあり (例: ``11122233m`` は
``111m 222m 333m`` とも ``123m 123m 123m`` とも取れる)、符・役が変わる。
ここでは可能な分解をすべて列挙し、点数計算側で最も高くなるものを選ぶ。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .tiles import (
    HandTiles,
    HONOR,
    Meld,
    MeldType,
    YAOCHU,
    count_tiles,
)


class Wait(str, Enum):
    RYANMEN = "ryanmen"    # 両面
    PENCHAN = "penchan"    # 辺張
    KANCHAN = "kanchan"    # 嵌張
    SHANPON = "shanpon"    # 双碰
    TANKI = "tanki"        # 単騎

    @property
    def fu(self) -> int:
        return 2 if self in (Wait.PENCHAN, Wait.KANCHAN, Wait.TANKI) else 0


class HandForm(str, Enum):
    STANDARD = "standard"
    CHIITOITSU = "chiitoitsu"
    KOKUSHI = "kokushi"


@dataclass(frozen=True)
class Group:
    """面子ひとつ。順子は ``tile`` を最小牌、刻子/槓子は構成牌とする。"""

    is_run: bool
    tile: int
    concealed: bool
    is_kan: bool = False
    from_meld: bool = False

    @property
    def tiles(self) -> tuple[int, ...]:
        if self.is_run:
            return (self.tile, self.tile + 1, self.tile + 2)
        n = 4 if self.is_kan else 3
        return (self.tile,) * n

    @property
    def is_triplet(self) -> bool:
        return not self.is_run

    @property
    def has_yaochu(self) -> bool:
        return any(t in YAOCHU for t in self.tiles)

    @property
    def all_yaochu(self) -> bool:
        return all(t in YAOCHU for t in self.tiles)

    def fu(self) -> int:
        """この面子が持つ符。"""
        if self.is_run:
            return 0
        base = 2
        if self.is_kan:
            base = 8
        if not self.concealed:
            return base * 2 if self.tile in YAOCHU else base
        return base * 4 if self.tile in YAOCHU else base * 2


@dataclass(frozen=True)
class Decomposition:
    """ひとつの解釈。和了牌がどの面子に属するかまで確定させたもの。"""

    form: HandForm
    pair: int | None
    groups: tuple[Group, ...]
    wait: Wait

    @property
    def all_tiles(self) -> tuple[int, ...]:
        out: list[int] = []
        if self.pair is not None:
            out.extend([self.pair, self.pair])
        for group in self.groups:
            out.extend(group.tiles)
        return tuple(out)


def _meld_to_group(meld: Meld) -> Group:
    return Group(
        is_run=meld.type is MeldType.CHII,
        tile=meld.base_tile,
        concealed=meld.type is MeldType.CLOSED_KAN,
        is_kan=meld.is_kan,
        from_meld=True,
    )


def _extract_sets(counts: list[int]) -> list[list[tuple[bool, int]]]:
    """残り牌をすべて面子に分解する。戻り値は (is_run, tile) のリストの集合。"""
    index = next((i for i, n in enumerate(counts) if n), None)
    if index is None:
        return [[]]

    results: list[list[tuple[bool, int]]] = []

    if counts[index] >= 3:
        counts[index] -= 3
        for rest in _extract_sets(counts):
            results.append([(False, index)] + rest)
        counts[index] += 3

    if (
        index < HONOR
        and index % 9 <= 6
        and counts[index + 1] > 0
        and counts[index + 2] > 0
    ):
        counts[index] -= 1
        counts[index + 1] -= 1
        counts[index + 2] -= 1
        for rest in _extract_sets(counts):
            results.append([(True, index)] + rest)
        counts[index] += 1
        counts[index + 1] += 1
        counts[index + 2] += 1

    return results


def _wait_for_run(base: int, win_tile: int) -> Wait:
    offset = win_tile - base
    if offset == 1:
        return Wait.KANCHAN
    if base % 9 == 0 and offset == 2:
        return Wait.PENCHAN
    if base % 9 == 6 and offset == 0:
        return Wait.PENCHAN
    return Wait.RYANMEN


def _standard_decompositions(
    hand: HandTiles, win_tile: int, is_tsumo: bool
) -> list[Decomposition]:
    counts = count_tiles(hand.concealed)
    meld_groups = tuple(_meld_to_group(m) for m in hand.melds)
    seen: set[tuple] = set()
    results: list[Decomposition] = []

    for pair in range(len(counts)):
        if counts[pair] < 2:
            continue
        counts[pair] -= 2
        for combo in _extract_sets(list(counts)):
            concealed_groups = [
                Group(is_run=is_run, tile=tile, concealed=True) for is_run, tile in combo
            ]
            for candidate in _win_tile_placements(
                pair, concealed_groups, meld_groups, win_tile, is_tsumo
            ):
                key = (
                    candidate.pair,
                    tuple(sorted((g.is_run, g.tile, g.concealed, g.is_kan) for g in candidate.groups)),
                    candidate.wait,
                )
                if key in seen:
                    continue
                seen.add(key)
                results.append(candidate)
        counts[pair] += 2

    return results


def _win_tile_placements(
    pair: int,
    concealed_groups: list[Group],
    meld_groups: tuple[Group, ...],
    win_tile: int,
    is_tsumo: bool,
) -> list[Decomposition]:
    """和了牌をどの面子の一部と見なすかで場合分けする。

    ロンの場合、和了牌を含む刻子は明刻扱いになり符が下がる。待ちの形も
    ここで決まるため、解釈ごとに別々の候補として返す。
    """
    out: list[Decomposition] = []
    placements: set[int] = set()

    if pair == win_tile:
        out.append(
            Decomposition(
                HandForm.STANDARD,
                pair,
                tuple(concealed_groups) + meld_groups,
                Wait.TANKI,
            )
        )

    for i, group in enumerate(concealed_groups):
        if win_tile not in group.tiles:
            continue
        signature = (group.is_run, group.tile)
        if signature in placements:
            continue
        placements.add(signature)

        if group.is_run:
            wait = _wait_for_run(group.tile, win_tile)
            groups = list(concealed_groups)
        else:
            wait = Wait.SHANPON
            groups = list(concealed_groups)
            # ロン和了では、和了牌で完成した刻子は明刻として数える。
            if not is_tsumo:
                groups[i] = Group(is_run=False, tile=group.tile, concealed=False)

        out.append(
            Decomposition(HandForm.STANDARD, pair, tuple(groups) + meld_groups, wait)
        )

    return out


def _chiitoitsu(hand: HandTiles, win_tile: int) -> list[Decomposition]:
    if hand.melds:
        return []
    counts = count_tiles(hand.concealed)
    if sum(1 for n in counts if n == 2) != 7:
        return []
    return [Decomposition(HandForm.CHIITOITSU, None, (), Wait.TANKI)]


def _kokushi(hand: HandTiles, win_tile: int) -> list[Decomposition]:
    if hand.melds:
        return []
    counts = count_tiles(hand.concealed)
    if any(counts[t] for t in range(34) if t not in YAOCHU):
        return []
    if any(counts[t] == 0 for t in YAOCHU):
        return []
    if sum(counts) != 14:
        return []
    pair = next(t for t in YAOCHU if counts[t] == 2)
    return [Decomposition(HandForm.KOKUSHI, pair, (), Wait.TANKI)]


def decompose(hand: HandTiles, win_tile: int, is_tsumo: bool) -> list[Decomposition]:
    """和了形として成立するすべての解釈を返す。和了形でなければ空リスト。"""
    hand.validate()
    if win_tile not in hand.concealed:
        raise ValueError("和了牌が手の内に含まれていません")

    results: list[Decomposition] = []
    results.extend(_kokushi(hand, win_tile))
    results.extend(_chiitoitsu(hand, win_tile))
    results.extend(_standard_decompositions(hand, win_tile, is_tsumo))
    return results


def is_winning_hand(hand: HandTiles, win_tile: int) -> bool:
    return bool(decompose(hand, win_tile, is_tsumo=True))


def is_tenpai(tiles: list[int], melds: tuple[Meld, ...] = ()) -> list[int]:
    """聴牌なら待ち牌の一覧を返す。手の内は 13 - 3*副露数 枚。"""
    counts = count_tiles(tiles)
    waits: list[int] = []
    for tile in range(34):
        if counts[tile] >= 4:
            continue
        candidate = HandTiles(tuple(sorted(tiles + [tile])), melds)
        try:
            if decompose(candidate, tile, is_tsumo=True):
                waits.append(tile)
        except Exception:
            continue
    return waits


__all__ = [
    "Decomposition",
    "Group",
    "HandForm",
    "Wait",
    "decompose",
    "is_tenpai",
    "is_winning_hand",
]
