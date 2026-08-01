"""特徴量から牌を推定する規則ベースの分類器。

学習データなしで動かすため、牌の見た目の「構造」をそのまま規則にしている。

    白      : 刻印がほとんど無い
    萬子    : 刻印が上下 2 帯に割れ、下の帯が赤い「萬」→ 上の帯の漢数字を照合
    字牌    : 刻印がひとつの大きな字。緑=發 / 赤=中 / 黒=東南西北 (テンプレート照合)
    筒子    : 丸い刻印が並ぶ (円形度が高い) → 個数が数字
    索子    : 縦長で緑の刻印が並ぶ → 個数が数字 (一索は鳥)

書体も配色も牌のセットごとに違うので、これはあくまで初期推定。実運用の精度は
``library`` (ユーザー自身の牌を登録した参照データ) が担保する。
"""

from __future__ import annotations

import cv2
import numpy as np

from ..tiles import CHUN, HAKU, HATSU, HONOR, MAN, PIN, SOU
from . import glyphs
from .features import TileFeatures

Candidate = tuple[int, float]

_WIND_KEYS = {"z1": HONOR + 0, "z2": HONOR + 1, "z3": HONOR + 2, "z4": HONOR + 3}
_MAN_KEYS = {f"m{i}": MAN + i - 1 for i in range(1, 10)}

BLANK_INK = 0.020


def _glyph_candidates(
    mask: np.ndarray, keys: dict[str, int], floor: float, span: float
) -> list[Candidate]:
    """テンプレート照合の結果を確信度に変換する。2 位との差を確信度に効かせる。"""
    matches = glyphs.match(mask, list(keys))
    if not matches:
        return []
    best_key, best = matches[0]
    runner_up = matches[1][1] if len(matches) > 1 else 0.0
    margin = max(0.0, best - runner_up)

    out: list[Candidate] = []
    for key, score in matches:
        confidence = floor + score * span
        if key == best_key:
            confidence += min(margin * 2.0, 0.25)
        out.append((keys[key], min(confidence, 0.94)))
    return out


def _solidify(mask: np.ndarray) -> np.ndarray:
    """刻印を「中身の詰まった塊」にする。

    筒子の丸は中央が下地色に抜けたドーナツ、索子の竹は中央に明るい帯が入る。
    そのままだと 1 個の刻印が 2 つに割れて数を数えられないので、囲まれた穴を
    埋め、縦方向のクローズで竹の上下を繋いでおく。
    """
    filled = mask.copy()
    h, w = filled.shape
    flood = np.zeros((h + 2, w + 2), np.uint8)
    background = filled.copy()
    cv2.floodFill(background, flood, (0, 0), 255)
    filled |= cv2.bitwise_not(background)

    vertical = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 9))
    return cv2.morphologyEx(filled, cv2.MORPH_CLOSE, vertical)


def _count_marks(features: TileFeatures) -> int:
    """並んだ刻印の個数 (筒子・索子の数字) を数える。

    隣り合う丸や竹はくっついて 1 つの連結成分に見えることが多い。距離変換の
    極大点を数えれば、くっついていても元の個数を復元できる。
    """
    if not features.blobs:
        return 0

    mask = _solidify(features.ink)
    distance = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    peak = float(distance.max())
    if peak <= 0:
        return len(features.blobs)

    # 局所最大 (膨張しても値が変わらない点) のうち、十分に太いものだけ残す。
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    dilated = cv2.dilate(distance, kernel)
    peaks = ((distance >= dilated - 1e-3) & (distance > peak * 0.45)).astype(np.uint8)
    count, _, _, _ = cv2.connectedComponentsWithStats(peaks, connectivity=8)
    from_peaks = count - 1

    if 1 <= from_peaks <= 9:
        return from_peaks
    return min(max(len(features.blobs), 1), 9)


def _aspect_stats(features: TileFeatures) -> tuple[float, float]:
    if not features.blobs:
        return 1.0, 0.0
    ratios = [h / max(w, 1) for _, _, w, h, _ in features.blobs]
    fills = [a / max(w * h, 1) for _, _, w, h, a in features.blobs]
    return float(np.median(ratios)), float(np.median(fills))


def _manzu_split(features: TileFeatures) -> int | None:
    """萬子の「漢数字 / 萬」の境目 (y 座標) を返す。萬子でなければ None。

    二萬・三萬のように漢数字自体が複数の帯に割れることがあるので、帯の数では
    なく「中央付近にある一番大きな隙間」で上下を分ける。
    """
    bands = features.bands
    if len(bands) < 2:
        return None
    height = features.ink.shape[0]

    best_gap = 0
    split: int | None = None
    for (_, end), (start, _) in zip(bands, bands[1:]):
        gap = start - end
        center = (start + end) / 2
        if not (height * 0.35 <= center <= height * 0.68):
            continue
        if gap > best_gap:
            best_gap, split = gap, (start + end) // 2

    if split is None or best_gap < height * 0.06:
        return None
    # 下側 (萬の字) が赤いことが萬子の決め手。
    if features.bottom_red_ratio < 0.45:
        return None
    return split


def _manzu(features: TileFeatures) -> list[Candidate]:
    split = _manzu_split(features)
    if split is None:
        return []
    return _glyph_candidates(features.ink[:split], _MAN_KEYS, floor=0.42, span=0.50)


def _honor(features: TileFeatures) -> list[Candidate]:
    """字牌: 大きな一文字。"""
    if not features.blobs:
        return []

    # 白は無地か、色の付いていない薄い枠。刻印はあるのに赤も緑も黒も無い。
    colorfulness = (
        features.red_ratio + features.green_ratio
        + features.blue_ratio + features.dark_ratio
    )
    if colorfulness < 0.25:
        return [(HAKU, 0.80)]
    # 一文字なので刻印は中央に大きく広がり、丸ではない。
    if features.coverage < 0.22 or features.circularity > 0.55:
        return []

    largest = features.blobs[0][4]
    total = sum(b[4] for b in features.blobs) or 1
    dominant = largest / total

    out: list[Candidate] = []
    if features.green_ratio >= 0.40 and dominant > 0.45:
        out.append((HATSU, 0.50 + min(features.green_ratio, 0.7) * 0.55))
    if features.red_ratio >= 0.40 and dominant > 0.45:
        out.append((CHUN, 0.50 + min(features.red_ratio, 0.7) * 0.55))

    if features.dark_ratio >= 0.55:
        # 北は 2 つの部品に分かれるので、ブロブが 1 つでなくても許す。
        out.extend(_glyph_candidates(features.ink, _WIND_KEYS, floor=0.34, span=0.55))
    return out


def _numbered(features: TileFeatures) -> list[Candidate]:
    """筒子・索子: 同じ刻印が数のぶんだけ並ぶ。"""
    if not features.blobs:
        return []
    aspect, fill = _aspect_stats(features)
    count = _count_marks(features)
    if not 1 <= count <= 9:
        return []

    out: list[Candidate] = []

    # 一索だけは鳥の絵で、数を数える対象にならない。
    if (
        len(features.blobs) <= 3
        and features.green_ratio >= 0.25
        and features.coverage >= 0.28
        and features.circularity < 0.55
        and count <= 2
    ):
        out.append((SOU + 0, 0.52))

    souzu = 0.0
    pinzu = 0.0
    if features.green_ratio >= 0.45:
        souzu += 0.34
    elif features.green_ratio >= 0.25:
        souzu += 0.16
    if aspect >= 1.5:
        souzu += 0.26
    elif aspect >= 1.25:
        souzu += 0.12

    if features.circularity >= 0.62:
        pinzu += 0.34
    elif features.circularity >= 0.45:
        pinzu += 0.16
    if 0.75 <= aspect <= 1.25:
        pinzu += 0.22
    if features.blue_ratio >= 0.10:
        pinzu += 0.18
    # 筒子の刻印は輪郭が丸いので外接矩形を埋めきらない。
    if 0.55 <= fill <= 0.85:
        pinzu += 0.08

    # 刻印の大きさが揃っているほど「数を並べた牌」らしい。
    regular = 0.12 if features.area_cv < 0.45 else 0.0
    souzu += regular
    pinzu += regular

    # 刻印の「個数」は牌のセットによって崩れ方が大きく、規則だけでは当てにならない。
    # 種類 (筒子か索子か) の判断より数の判断のほうが外れやすいので、確信度は
    # 意図的に低く抑え、UI 側で必ず確認を促す。ライブラリに登録済みならそちらが
    # 優先されるため、この上限が効くのは校正前だけ。
    ceiling = 0.54
    if souzu > 0:
        out.append((SOU + count - 1, min(0.28 + souzu, ceiling)))
    if pinzu > 0:
        out.append((PIN + count - 1, min(0.28 + pinzu, ceiling)))
    if souzu == 0 and pinzu == 0:
        out.append((PIN + count - 1, 0.22))
        out.append((SOU + count - 1, 0.22))
    return out


def classify(features: TileFeatures) -> list[Candidate]:
    """候補を (牌 ID, 確信度) の降順リストで返す。"""
    if features.ink_ratio < BLANK_INK:
        return [(HAKU, 0.90)]

    candidates: list[Candidate] = []
    candidates.extend(_manzu(features))
    if not candidates:
        # 萬子の構造がはっきり出ていれば字牌・数牌の判定は不要。
        candidates.extend(_honor(features))
        candidates.extend(_numbered(features))

    merged: dict[int, float] = {}
    for tile, score in candidates:
        merged[tile] = max(merged.get(tile, 0.0), score)
    return sorted(merged.items(), key=lambda item: -item[1])


__all__ = ["classify"]
