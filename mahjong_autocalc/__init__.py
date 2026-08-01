"""麻雀の点数自動計算ツール。

写真から手牌を認識し (``mahjong_autocalc.vision``)、点数を計算する
(``mahjong_autocalc.calculator``)。
"""

from .calculator import Calculation, NoYakuError, NotWinningHandError, calculate
from .context import Rules, WinContext
from .tiles import (
    HandTiles,
    InvalidHandError,
    Meld,
    MeldType,
    make_meld,
    parse_tiles,
    tile_name,
    tiles_to_str,
)

__version__ = "0.1.0"

__all__ = [
    "Calculation",
    "HandTiles",
    "InvalidHandError",
    "Meld",
    "MeldType",
    "NoYakuError",
    "NotWinningHandError",
    "Rules",
    "WinContext",
    "calculate",
    "make_meld",
    "parse_tiles",
    "tile_name",
    "tiles_to_str",
]
