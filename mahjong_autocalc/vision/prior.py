"""同梱の初期ライブラリ。

合成した多数の牌デザインから作った参照データ。これがあるおかげで、何も登録
しなくても最初からある程度読める。利用者が自分の牌を登録した場合は、そちらが
優先される (手元のセットに特化したデータのほうが当然強い)。

``tools/build_prior_library.py --write`` で作り直せる。
"""

from __future__ import annotations

import functools
import pathlib

import numpy as np

from .library import TileLibrary

_NPZ = pathlib.Path(__file__).with_name("prior_library.npz")


@functools.lru_cache(maxsize=1)
def load_prior_library() -> TileLibrary | None:
    """初期ライブラリを読み込む。無ければ None (規則ベースに落ちるだけ)。"""
    if not _NPZ.exists():
        return None
    try:
        with np.load(_NPZ) as data:
            samples = {
                int(key): [row.astype(np.float32) for row in data[key]]
                for key in data.files
                if key != "scale"
            }
    except Exception:
        return None
    if not samples:
        return None

    library = TileLibrary(_NPZ)
    library._samples = samples
    return library


__all__ = ["load_prior_library"]
