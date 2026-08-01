"""同梱の漢字テンプレートを読み込んで照合する。

テンプレートは ``tools/build_glyph_templates.py`` で生成した 32x32 の二値画像。
実際の牌の刻印は書体が違うので完全一致はしないが、字の判別には十分な差が出る。
"""

from __future__ import annotations

import functools
import pathlib

import cv2
import numpy as np

GLYPH_SIZE = 32
_NPZ = pathlib.Path(__file__).with_name("glyphs.npz")


@functools.lru_cache(maxsize=1)
def templates() -> dict[str, np.ndarray]:
    if not _NPZ.exists():
        return {}
    with np.load(_NPZ) as data:
        return {key: data[key].astype(np.uint8) for key in data.files}


def normalize_glyph(mask: np.ndarray) -> np.ndarray | None:
    """刻印マスクを外接矩形で切り出し、縦横比を保って 32x32 に収める。"""
    ys, xs = np.nonzero(mask)
    if len(xs) < 8:
        return None
    cropped = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = cropped.shape
    side = max(h, w)
    canvas = np.zeros((side, side), dtype=np.uint8)
    canvas[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = cropped
    resized = cv2.resize(canvas, (GLYPH_SIZE, GLYPH_SIZE), interpolation=cv2.INTER_AREA)
    return (resized > 96).astype(np.uint8)


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.count_nonzero(a | b)
    if union == 0:
        return 0.0
    return float(np.count_nonzero(a & b)) / union


def match(mask: np.ndarray, keys: list[str]) -> list[tuple[str, float]]:
    """``keys`` のテンプレートと照合し、(キー, 類似度) を降順で返す。"""
    library = templates()
    glyph = normalize_glyph(mask)
    if glyph is None:
        return []

    # 刻印の太さの違いを吸収するため、少し膨張させたものとも比べて良い方を採る。
    kernel = np.ones((3, 3), np.uint8)
    fat = cv2.dilate(glyph, kernel, iterations=1)

    scored: list[tuple[str, float]] = []
    for key in keys:
        template = library.get(key)
        if template is None:
            continue
        fat_template = cv2.dilate(template, kernel, iterations=1)
        score = max(_iou(glyph, template), _iou(fat, fat_template))
        scored.append((key, score))

    scored.sort(key=lambda item: -item[1])
    return scored


__all__ = ["GLYPH_SIZE", "match", "normalize_glyph", "templates"]
