"""正規化した牌の面から特徴量を取り出す。

牌の面は「明るい下地 + 濃い/色付きの刻印」という構造なので、下地の色からの
距離で刻印 (ink) を分離し、その形と色を特徴量にする。照明の色かぶりに強い
ように、しきい値はすべて牌ごとの分布から動的に決める。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .detect import TILE_H, TILE_W

# 面の縁 (段差や影が出る) を除いた内側だけを見る。
INNER_MARGIN_X = 0.10
INNER_MARGIN_Y = 0.07

DESCRIPTOR_GRID = (14, 18)  # (幅, 高さ)
HALF_GRID = (16, 12)    # 上半分/下半分をそれぞれ見るためのグリッド
GLYPH_GRID = (16, 16)   # 外接矩形で切り出した刻印を正規化するグリッド


@dataclass(frozen=True)
class TileFeatures:
    ink: np.ndarray            # 刻印の二値マスク (内側領域, uint8 0/255)
    ink_ratio: float           # 内側領域に占める刻印の割合
    red_ratio: float           # 刻印のうち赤の割合
    green_ratio: float
    blue_ratio: float
    dark_ratio: float          # 刻印のうち無彩色 (黒) の割合
    descriptor: np.ndarray     # 照合用のベクトル (L2 正規化済み)
    blobs: tuple[tuple[int, int, int, int, int], ...]
    """刻印の連結成分 (x, y, w, h, 面積) を面積降順で。"""

    top_ink_ratio: float       # 上半分の刻印量
    bottom_ink_ratio: float    # 下半分の刻印量
    bottom_red_ratio: float    # 下半分の刻印のうち赤の割合

    bands: tuple[tuple[int, int], ...]
    """刻印を横方向に見たときの帯 (y0, y1)。萬子は上下 2 帯に割れる。"""

    circularity: float
    """最大ブロブの円形度 (4πA/P²)。筒子の丸は 1 に近く、漢字は低い。"""

    area_cv: float
    """ブロブ面積のばらつき (標準偏差/平均)。数牌の刻印は揃うので小さい。"""

    coverage: float
    """刻印全体の外接矩形が内側領域に占める割合。"""


def inner_region(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    dx = int(w * INNER_MARGIN_X)
    dy = int(h * INNER_MARGIN_Y)
    return image[dy : h - dy, dx : w - dx]


def _ink_mask(face: np.ndarray) -> np.ndarray:
    """下地の色から離れた画素を刻印として取り出す。"""
    lab = cv2.cvtColor(face, cv2.COLOR_BGR2LAB).astype(np.float32)
    # 下地は面積の大半を占めるので中央値で代表させる。
    base = np.median(lab.reshape(-1, 3), axis=0)
    distance = np.linalg.norm(lab - base, axis=2)
    distance = cv2.GaussianBlur(distance, (3, 3), 0)

    norm = np.clip(distance / max(distance.max(), 1e-6) * 255, 0, 255).astype(np.uint8)
    threshold, mask = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # 刻印が無い牌 (白) では Otsu がノイズを拾うため、絶対量でも足切りする。
    if distance[mask > 0].size == 0 or np.percentile(distance, 97) < 18:
        return np.zeros(face.shape[:2], dtype=np.uint8)

    # オープニングは「三」のような細い横棒を消してしまうので使わない。
    # 途切れを埋めるクローズだけかけ、ノイズは連結成分の面積で落とす。
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    return _drop_specks(mask)


def _drop_specks(mask: np.ndarray) -> np.ndarray:
    """面積の小さい連結成分をノイズとして取り除く。"""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask
    floor = max(6, int(mask.size * 0.0015))
    keep = np.zeros(count, dtype=bool)
    for i in range(1, count):
        keep[i] = stats[i, cv2.CC_STAT_AREA] >= floor
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def _color_ratios(face: np.ndarray, mask: np.ndarray) -> tuple[float, float, float, float]:
    """刻印画素を 赤/緑/青/黒 に分類して割合を返す。"""
    if not mask.any():
        return 0.0, 0.0, 0.0, 0.0
    hsv = cv2.cvtColor(face, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0][mask > 0].astype(np.int32)
    sat = hsv[:, :, 1][mask > 0].astype(np.int32)
    val = hsv[:, :, 2][mask > 0].astype(np.int32)

    colored = sat >= 70
    red = colored & ((hue <= 12) | (hue >= 165))
    green = colored & (hue >= 35) & (hue <= 95)
    blue = colored & (hue > 95) & (hue < 140)
    dark = ~(red | green | blue) & (val < 200)

    total = float(hue.size)
    return (
        float(red.sum()) / total,
        float(green.sum()) / total,
        float(blue.sum()) / total,
        float(dark.sum()) / total,
    )


def _blobs(mask: np.ndarray) -> tuple[tuple[int, int, int, int, int], ...]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    area_floor = max(12, int(mask.size * 0.004))
    found = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area < area_floor:
            continue
        found.append((int(x), int(y), int(w), int(h), int(area)))
    found.sort(key=lambda b: -b[4])
    return tuple(found)


def _bands(mask: np.ndarray) -> tuple[tuple[int, int], ...]:
    """刻印の行方向の帯を求める。萬子の「数字 + 萬」のような上下分割を捉える。"""
    coverage = (mask > 0).mean(axis=1)
    active = coverage > 0.04
    bands: list[list[int]] = []
    start: int | None = None
    for y, on in enumerate(active):
        if on and start is None:
            start = y
        elif not on and start is not None:
            bands.append([start, y])
            start = None
    if start is not None:
        bands.append([start, len(active)])

    # 細い隙間は同じ帯とみなす (画数の切れ目で割れないように)。
    min_gap = max(3, int(mask.shape[0] * 0.07))
    merged: list[list[int]] = []
    for band in bands:
        if merged and band[0] - merged[-1][1] < min_gap:
            merged[-1][1] = band[1]
        else:
            merged.append(band)

    min_height = max(2, int(mask.shape[0] * 0.05))
    return tuple((a, b) for a, b in merged if b - a >= min_height)


def _circularity(mask: np.ndarray, blob: tuple[int, int, int, int, int]) -> float:
    x, y, w, h, _ = blob
    patch = mask[y : y + h, x : x + w]
    contours, _ = cv2.findContours(patch, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return 0.0
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    if perimeter <= 0:
        return 0.0
    return float(4 * np.pi * cv2.contourArea(contour) / (perimeter * perimeter))


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 1e-6 else vector


def _region_grid(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    if mask.size == 0:
        return np.zeros(size[0] * size[1], dtype=np.float32)
    grid = cv2.resize(mask, size, interpolation=cv2.INTER_AREA)
    return _unit(grid.astype(np.float32).ravel() / 255.0)


def _cropped_grid(mask: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """刻印を外接矩形で切り出してから正規化する。

    位置と大きさの違いを吸収するので、萬子の漢数字のように「小さくて似ている」
    刻印の差がはっきり出る。
    """
    empty = np.zeros(size[0] * size[1], dtype=np.float32)
    if mask.size == 0:
        return empty
    ys, xs = np.nonzero(mask)
    if len(xs) < 6:
        return empty
    cropped = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    grid = cv2.resize(cropped, size, interpolation=cv2.INTER_AREA)
    return _unit(grid.astype(np.float32).ravel() / 255.0)


def _upper_glyph_region(
    mask: np.ndarray, bands: tuple[tuple[int, int], ...]
) -> np.ndarray:
    """萬子の漢数字にあたる部分を取り出す。

    上下を機械的に半分で割ると、切り出しが数ピクセルずれただけで漢数字の一部が
    はみ出して別の字に見えてしまう。刻印の帯構造を使って「一番下の帯より上」を
    取れば、位置ずれに左右されずに数字だけを見られる。
    """
    if len(bands) >= 2:
        return mask[: bands[-1][0]]
    return mask


def _descriptor(
    mask: np.ndarray,
    ratios: tuple[float, float, float, float],
    ink_ratio: float,
    bands: tuple[tuple[int, int], ...],
) -> np.ndarray:
    """照合用ベクトル。

    牌全体を 1 枚のグリッドにしただけだと、萬子のように「共通部分 (萬) が大きく
    違いが小さい (数字)」牌で差が埋もれる。上半分・下半分をそれぞれ正規化して
    足すことで、面積の小さい部分にも発言権を持たせている。
    """
    half = mask.shape[0] // 2
    full = _region_grid(mask, DESCRIPTOR_GRID)
    top = _region_grid(mask[:half], HALF_GRID)
    bottom = _region_grid(mask[half:], HALF_GRID)
    top_glyph = _cropped_grid(_upper_glyph_region(mask, bands), GLYPH_GRID)
    color = _unit(np.asarray(list(ratios) + [min(ink_ratio * 3.0, 1.0)], dtype=np.float32))

    vector = np.concatenate(
        [full, top * 1.1, bottom * 0.5, top_glyph * 0.9, color * 0.65]
    )
    return _unit(vector)


def extract(face: np.ndarray) -> TileFeatures:
    """正規化済みの牌の面 (TILE_H x TILE_W, BGR) から特徴量を計算する。"""
    if face.shape[:2] != (TILE_H, TILE_W):
        face = cv2.resize(face, (TILE_W, TILE_H), interpolation=cv2.INTER_AREA)

    region = inner_region(face)
    mask = _ink_mask(region)
    ratios = _color_ratios(region, mask)
    ink_ratio = float((mask > 0).mean())

    half = mask.shape[0] // 2
    top, bottom = mask[:half], mask[half:]
    bottom_red = _color_ratios(region[half:], bottom)[0]

    bands = _bands(mask)
    blobs = _blobs(mask)
    if blobs:
        areas = np.array([b[4] for b in blobs], dtype=np.float32)
        area_cv = float(areas.std() / max(areas.mean(), 1e-6))
        circularity = _circularity(mask, blobs[0])
        xs = [b[0] for b in blobs] + [b[0] + b[2] for b in blobs]
        ys = [b[1] for b in blobs] + [b[1] + b[3] for b in blobs]
        coverage = ((max(xs) - min(xs)) * (max(ys) - min(ys))) / mask.size
    else:
        area_cv, circularity, coverage = 0.0, 0.0, 0.0

    return TileFeatures(
        ink=mask,
        ink_ratio=ink_ratio,
        red_ratio=ratios[0],
        green_ratio=ratios[1],
        blue_ratio=ratios[2],
        dark_ratio=ratios[3],
        descriptor=_descriptor(mask, ratios, ink_ratio, bands),
        blobs=blobs,
        top_ink_ratio=float((top > 0).mean()),
        bottom_ink_ratio=float((bottom > 0).mean()),
        bottom_red_ratio=bottom_red,
        bands=bands,
        circularity=circularity,
        area_cv=area_cv,
        coverage=float(coverage),
    )


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    """L2 正規化済みベクトル同士のコサイン類似度。"""
    return float(np.dot(a, b))


__all__ = ["TileFeatures", "extract", "inner_region", "similarity"]
