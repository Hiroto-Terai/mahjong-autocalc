"""牌の表現と記法のパース。

牌は 0-33 の整数 ID で表す。

    0-8   : 一萬 - 九萬 (manzu)
    9-17  : 一筒 - 九筒 (pinzu)
    18-26 : 一索 - 九索 (souzu)
    27-30 : 東 南 西 北
    31-33 : 白 發 中

記法は標準的な MPSZ 表記を使う。``123m456p789s11z`` のように書き、
``0`` は赤五 (赤ドラ) を意味する。``0m`` は赤五萬。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Iterator, Sequence

NUM_TILE_KINDS = 34

MAN = 0
PIN = 9
SOU = 18
HONOR = 27

EAST, SOUTH, WEST, NORTH = 27, 28, 29, 30
HAKU, HATSU, CHUN = 31, 32, 33

WINDS = (EAST, SOUTH, WEST, NORTH)
DRAGONS = (HAKU, HATSU, CHUN)
HONORS = WINDS + DRAGONS

TERMINALS = (MAN + 0, MAN + 8, PIN + 0, PIN + 8, SOU + 0, SOU + 8)
YAOCHU = frozenset(TERMINALS + HONORS)
GREEN_TILES = frozenset({SOU + 1, SOU + 2, SOU + 3, SOU + 5, SOU + 7, HATSU})

_SUIT_ORDER = "mpsz"
_SUIT_BASE = {"m": MAN, "p": PIN, "s": SOU, "z": HONOR}

TILE_NAMES_JA = (
    "一萬", "二萬", "三萬", "四萬", "五萬", "六萬", "七萬", "八萬", "九萬",
    "一筒", "二筒", "三筒", "四筒", "五筒", "六筒", "七筒", "八筒", "九筒",
    "一索", "二索", "三索", "四索", "五索", "六索", "七索", "八索", "九索",
    "東", "南", "西", "北", "白", "發", "中",
)

WIND_NAMES_JA = {EAST: "東", SOUTH: "南", WEST: "西", NORTH: "北"}


class InvalidHandError(ValueError):
    """手牌の記法や構成が不正なときに送出する。"""


def is_honor(tile: int) -> bool:
    return tile >= HONOR


def is_terminal(tile: int) -> bool:
    """老頭牌 (1/9 の数牌) かどうか。字牌は含まない。"""
    return not is_honor(tile) and tile % 9 in (0, 8)


def is_yaochu(tile: int) -> bool:
    """幺九牌 (老頭牌 + 字牌) かどうか。"""
    return tile in YAOCHU


def is_simple(tile: int) -> bool:
    """中張牌 (2-8 の数牌) かどうか。"""
    return not is_yaochu(tile)


def suit_of(tile: int) -> str:
    if tile >= HONOR:
        return "z"
    return _SUIT_ORDER[tile // 9]


def rank_of(tile: int) -> int:
    """数牌なら 1-9、字牌なら 1-7 を返す。"""
    if tile >= HONOR:
        return tile - HONOR + 1
    return tile % 9 + 1


def tile_to_str(tile: int) -> str:
    return f"{rank_of(tile)}{suit_of(tile)}"


def tile_name(tile: int) -> str:
    return TILE_NAMES_JA[tile]


def tiles_to_str(tiles: Iterable[int]) -> str:
    """牌 ID の列を MPSZ 記法にまとめる。"""
    buckets: dict[str, list[int]] = {s: [] for s in _SUIT_ORDER}
    for tile in sorted(tiles):
        buckets[suit_of(tile)].append(rank_of(tile))
    out = []
    for suit in _SUIT_ORDER:
        if buckets[suit]:
            out.append("".join(str(r) for r in buckets[suit]) + suit)
    return "".join(out)


def dora_indicator_to_dora(indicator: int) -> int:
    """ドラ表示牌から実際のドラ牌を求める。"""
    if indicator >= HONOR:
        if indicator in WINDS:
            return EAST + (indicator - EAST + 1) % 4
        return HAKU + (indicator - HAKU + 1) % 3
    base = (indicator // 9) * 9
    return base + (indicator % 9 + 1) % 9


@dataclass(frozen=True)
class ParsedTiles:
    """パース結果。牌 ID の列と、そのうち赤五である枚数。"""

    tiles: tuple[int, ...]
    red_fives: tuple[int, ...] = ()  # 赤五として指定された牌 ID (5m/5p/5s)

    def __iter__(self) -> Iterator[int]:
        return iter(self.tiles)

    def __len__(self) -> int:
        return len(self.tiles)


def parse_tiles(notation: str) -> ParsedTiles:
    """``123m456p11z`` 形式の文字列を牌 ID にパースする。

    ``0`` は赤五を表し、牌 ID としては五 (rank 5) に正規化したうえで
    ``red_fives`` に記録する。
    """
    tiles: list[int] = []
    reds: list[int] = []
    pending: list[str] = []

    for char in notation:
        if char.isspace() or char in ",-_":
            continue
        if char.isdigit():
            pending.append(char)
            continue
        if char not in _SUIT_BASE:
            raise InvalidHandError(f"不明な文字です: {char!r}")
        if not pending:
            raise InvalidHandError(f"'{char}' の前に数字がありません")
        base = _SUIT_BASE[char]
        for digit in pending:
            value = int(digit)
            if char == "z":
                if not 1 <= value <= 7:
                    raise InvalidHandError(f"字牌は 1-7 で指定します: {value}{char}")
                tiles.append(HONOR + value - 1)
            else:
                if value == 0:
                    tiles.append(base + 4)
                    reds.append(base + 4)
                elif 1 <= value <= 9:
                    tiles.append(base + value - 1)
                else:
                    raise InvalidHandError(f"数牌は 0-9 で指定します: {value}{char}")
        pending = []

    if pending:
        raise InvalidHandError("末尾の数字に対応する種類 (m/p/s/z) がありません")
    return ParsedTiles(tuple(tiles), tuple(reds))


class MeldType(str, Enum):
    CHII = "chii"          # 順子 (必ず副露)
    PON = "pon"            # 明刻
    OPEN_KAN = "open_kan"  # 明槓 (大明槓・加槓)
    CLOSED_KAN = "closed_kan"  # 暗槓


@dataclass(frozen=True)
class Meld:
    """副露 (鳴き) または暗槓を表す。

    ``tiles`` は構成牌の ID をソートしたもの。順子は 3 枚、刻子は 3 枚、
    槓子は 4 枚を持つ。
    """

    type: MeldType
    tiles: tuple[int, ...]
    red_fives: tuple[int, ...] = ()

    def __post_init__(self) -> None:
        expected = 4 if self.is_kan else 3
        if len(self.tiles) != expected:
            raise InvalidHandError(
                f"{self.type.value} は {expected} 枚である必要があります: {self.tiles}"
            )
        if self.type is MeldType.CHII:
            a, b, c = self.tiles
            if is_honor(a) or not (b == a + 1 and c == a + 2) or a % 9 > 6:
                raise InvalidHandError(f"順子として不正です: {self.tiles}")
        elif len(set(self.tiles)) != 1:
            raise InvalidHandError(f"刻子/槓子として不正です: {self.tiles}")

    @property
    def is_kan(self) -> bool:
        return self.type in (MeldType.OPEN_KAN, MeldType.CLOSED_KAN)

    @property
    def is_concealed(self) -> bool:
        """門前性を保つ副露か。暗槓のみ True。"""
        return self.type is MeldType.CLOSED_KAN

    @property
    def is_triplet(self) -> bool:
        return self.type is not MeldType.CHII

    @property
    def base_tile(self) -> int:
        return self.tiles[0]

    def as_set_tiles(self) -> tuple[int, ...]:
        """符計算・役判定用に 3 枚の面子として見た牌 (槓子は 3 枚に潰す)。"""
        return self.tiles[:3]


def make_meld(kind: str, notation: str) -> Meld:
    """``make_meld("pon", "111m")`` のように副露を組み立てる。"""
    parsed = parse_tiles(notation)
    return Meld(MeldType(kind), tuple(sorted(parsed.tiles)), parsed.red_fives)


def count_tiles(tiles: Sequence[int]) -> list[int]:
    """牌 ID 列から 34 要素の枚数配列を作る。"""
    counts = [0] * NUM_TILE_KINDS
    for tile in tiles:
        counts[tile] += 1
    return counts


@dataclass
class HandTiles:
    """手牌全体 (手の内 + 副露) をまとめて保持する。"""

    concealed: tuple[int, ...]
    melds: tuple[Meld, ...] = ()
    red_fives: tuple[int, ...] = field(default=())

    @property
    def all_tiles(self) -> tuple[int, ...]:
        out = list(self.concealed)
        for meld in self.melds:
            out.extend(meld.tiles)
        return tuple(out)

    @property
    def all_red_fives(self) -> tuple[int, ...]:
        out = list(self.red_fives)
        for meld in self.melds:
            out.extend(meld.red_fives)
        return tuple(out)

    @property
    def is_menzen(self) -> bool:
        """門前かどうか。暗槓は門前を崩さない。"""
        return all(meld.is_concealed for meld in self.melds)

    def validate(self) -> None:
        expected_concealed = 14 - 3 * len(self.melds)
        if len(self.concealed) != expected_concealed:
            raise InvalidHandError(
                f"手の内は {expected_concealed} 枚である必要があります "
                f"(副露 {len(self.melds)} 個 / 実際 {len(self.concealed)} 枚)"
            )
        counts = count_tiles(self.all_tiles)
        for tile, n in enumerate(counts):
            if n > 4:
                raise InvalidHandError(f"{tile_name(tile)} が {n} 枚あります (上限 4 枚)")
        for tile in self.all_red_fives:
            if rank_of(tile) != 5 or is_honor(tile):
                raise InvalidHandError(f"赤ドラに指定できない牌です: {tile_name(tile)}")
