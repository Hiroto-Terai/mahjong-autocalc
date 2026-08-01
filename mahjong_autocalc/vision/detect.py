"""写真から牌の面を切り出す。

想定する入力は「牌を表向きに一列 (または数グループ) に並べて、正面から撮った
写真」。牌の面は明るく彩度が低いので、まず面の領域をマスクで取り出し、
隣接して繋がった塊は牌の継ぎ目 (縦方向の暗い線) を検出して分割する。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

TILE_W = 64
TILE_H = 88
TILE_ASPECT = TILE_W / TILE_H  # 牌の面の 幅/高さ。おおよそ 0.72

MAX_DIMENSION = 1400
# 面の検出はモルフォロジーが重いので、さらに縮めた画像で行う。切り出し自体は
# MAX_DIMENSION 側から行うので、牌の解像度は落ちない。
DETECT_DIMENSION = 720
MIN_TILE_SIDE_RATIO = 0.017
MIN_AREA_RATIO = 0.0008
# 牌の列が画面いっぱいに写ることは普通にあるので、面積の上限は緩くとる。
# 「背景そのもの」を拾わないためには、四辺すべてに接しているかどうかで弾く。
MAX_AREA_RATIO = 0.75


@dataclass(frozen=True)
class DetectedTile:
    """切り出した牌 1 枚。"""

    image: np.ndarray  # TILE_H x TILE_W x 3 (BGR) に正規化した面
    quad: np.ndarray  # 元画像座標での四隅 (4x2, float32)
    group: int  # 同じ塊 (副露のかたまりなど) に属する牌は同じ番号
    order: int  # 全体での並び順


class DetectionError(RuntimeError):
    """牌を検出できなかった場合。"""


def _resize(image: np.ndarray, limit: int = MAX_DIMENSION) -> tuple[np.ndarray, float]:
    h, w = image.shape[:2]
    scale = limit / max(h, w)
    if scale >= 1.0:
        return image, 1.0
    resized = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def face_mask(image: np.ndarray) -> np.ndarray:
    """牌の面 (明るく彩度の低い領域) のマスクを作る。"""
    blurred = cv2.bilateralFilter(image, 9, 60, 60)
    hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]

    # 明るさは画像全体の分布から動的に決める (露出のばらつきに対応)。
    v_thresh = max(110, int(np.percentile(value, 70)) - 30)
    s_thresh = max(60, int(np.percentile(saturation, 40)) + 40)

    mask = ((value >= v_thresh) & (saturation <= s_thresh)).astype(np.uint8) * 255

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    # 牌の文字は暗いのでマスクに穴が開く。輪郭を塗り潰して面を一枚板にする。
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    return filled


def _order_quad(points: np.ndarray) -> np.ndarray:
    """四隅を 左上, 右上, 右下, 左下 の順に並べ替える。"""
    points = np.asarray(points, dtype=np.float32)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    order = np.argsort(angles)
    ordered = points[order]
    # 左上を先頭にする (x+y が最小の点)
    start = int(np.argmin(ordered.sum(axis=1)))
    return np.roll(ordered, -start, axis=0)


def _warp(image: np.ndarray, quad: np.ndarray, width: int, height: int) -> np.ndarray:
    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(_order_quad(quad), dst)
    return cv2.warpPerspective(image, matrix, (width, height))


def _seam_positions(strip: np.ndarray) -> list[int]:
    """横長の帯から、牌と牌の継ぎ目 (ほぼ全高が暗い列) の x 座標を返す。"""
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    threshold = max(60, int(np.percentile(gray, 45)) - 15)
    dark_ratio = (gray < threshold).mean(axis=0)

    seams: list[int] = []
    run_start: int | None = None
    for x, ratio in enumerate(dark_ratio):
        if ratio >= 0.65:
            if run_start is None:
                run_start = x
        elif run_start is not None:
            seams.append((run_start + x - 1) // 2)
            run_start = None
    if run_start is not None:
        seams.append((run_start + len(dark_ratio) - 1) // 2)

    margin = strip.shape[0] * TILE_ASPECT * 0.4
    return [s for s in seams if margin < s < strip.shape[1] - margin]


def _split_count(strip_w: int, strip_h: int, seams: list[int]) -> int:
    """帯に含まれる牌の枚数を決める。継ぎ目を優先し、無ければ縦横比から推定。"""
    from_aspect = max(1, int(round((strip_w / strip_h) / TILE_ASPECT)))
    if not seams:
        return from_aspect

    n_from_seams = len(seams) + 1
    expected = strip_w / n_from_seams
    positions = [0] + seams + [strip_w]
    widths = [b - a for a, b in zip(positions, positions[1:])]
    if all(abs(w - expected) <= expected * 0.35 for w in widths):
        return n_from_seams
    return from_aspect


def _quad_from_rect(rect) -> np.ndarray:
    return cv2.boxPoints(rect).astype(np.float32)


def _normalize_row_quad(quad: np.ndarray) -> np.ndarray:
    """帯の四隅を「長辺が横」になるよう並べ替える。"""
    ordered = _order_quad(quad)
    top_len = np.linalg.norm(ordered[1] - ordered[0])
    left_len = np.linalg.norm(ordered[3] - ordered[0])
    if top_len >= left_len:
        return ordered
    return np.roll(ordered, -1, axis=0)


def detect_tiles(image: np.ndarray) -> list[DetectedTile]:
    """写真から牌を検出し、正規化した面の画像を並び順に返す。"""
    if image is None or image.size == 0:
        raise DetectionError("画像を読み込めませんでした")

    work, scale = _resize(image)
    inv_scale = 1.0 / scale

    # 検出用の縮小画像。求めた四隅は work 座標に戻して使う。
    small, detect_scale = _resize(work, DETECT_DIMENSION)
    to_work = 1.0 / detect_scale

    mask = face_mask(small)
    total_area = small.shape[0] * small.shape[1]
    small_h, small_w = small.shape[:2]
    min_side = max(6.0, min(small_w, small_h) * MIN_TILE_SIDE_RATIO)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    blobs: list[tuple[np.ndarray, float]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if not (MIN_AREA_RATIO * total_area <= area <= MAX_AREA_RATIO * total_area):
            continue
        bx, by, bw, bh = cv2.boundingRect(contour)
        if bx == 0 and by == 0 and bx + bw >= small_w and by + bh >= small_h:
            continue  # 四辺すべてに接する塊は背景
        rect = cv2.minAreaRect(contour)
        (_, _), (rw, rh), _ = rect
        if min(rw, rh) < min_side:
            continue
        if area / max(rw * rh, 1e-6) < 0.72:
            continue  # 長方形からかけ離れた形は牌ではない
        long_side, short_side = max(rw, rh), min(rw, rh)
        if long_side / short_side > 24:
            continue
        blobs.append((_quad_from_rect(rect) * to_work, area))

    if not blobs:
        raise DetectionError(
            "牌を検出できませんでした。明るい場所で、牌を正面から大きく写してください"
        )

    # 塊を「上から下、左から右」に並べる。
    def blob_key(item: tuple[np.ndarray, float]) -> tuple[float, float]:
        center = item[0].mean(axis=0)
        return (round(center[1] / 40), center[0])

    blobs.sort(key=blob_key)

    results: list[DetectedTile] = []
    order = 0
    for group_index, (quad, _) in enumerate(blobs):
        ordered = _normalize_row_quad(quad)
        width = float(np.linalg.norm(ordered[1] - ordered[0]))
        height = float(np.linalg.norm(ordered[3] - ordered[0]))
        if height < 8:
            continue

        strip_h = TILE_H
        strip_w = max(TILE_W, int(round(width / height * TILE_H)))
        strip = _warp(work, ordered, strip_w, strip_h)

        count = _split_count(strip_w, strip_h, _seam_positions(strip))
        count = max(1, min(count, 18))

        for i in range(count):
            t0 = i / count
            t1 = (i + 1) / count
            top = ordered[0] + (ordered[1] - ordered[0]) * t0
            top_end = ordered[0] + (ordered[1] - ordered[0]) * t1
            bottom = ordered[3] + (ordered[2] - ordered[3]) * t0
            bottom_end = ordered[3] + (ordered[2] - ordered[3]) * t1
            tile_quad = np.array([top, top_end, bottom_end, bottom], dtype=np.float32)
            face = _warp(work, tile_quad, TILE_W, TILE_H)
            results.append(
                DetectedTile(
                    image=face,
                    quad=tile_quad * inv_scale,
                    group=group_index,
                    order=order,
                )
            )
            order += 1

    if not results:
        raise DetectionError("牌の切り出しに失敗しました")
    return results


__all__ = ["DetectedTile", "DetectionError", "TILE_H", "TILE_W", "detect_tiles", "face_mask"]
