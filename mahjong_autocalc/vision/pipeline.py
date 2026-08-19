"""画像 → 牌の並び、までを通す。"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import cv2
import numpy as np

from ..tiles import tile_name, tile_to_str
from . import heuristic
from .detect import DetectedTile, DetectionError, detect_tiles
from .features import TileFeatures, extract
from .library import TileLibrary
from .prior import load_prior_library

# 照合スコアがこの値を超えたら採用する。順に「自分で登録した牌 → 同梱の初期
# ライブラリ → 規則ベース」と落とす。
#
# しきい値を下げて弱い一致まで拾うと、規則ベースなら当たっていた牌を潰して
# しまい、かえって正解率が下がる (実測で 100% → 93%)。低い一致度は採用せず、
# 次の段に譲る。
LIBRARY_TRUST_THRESHOLD = 0.86
PRIOR_TRUST_THRESHOLD = 0.80
LOW_CONFIDENCE = 0.55


@dataclass(frozen=True)
class TileGuess:
    index: int
    tile: int | None
    confidence: float
    source: str  # "library" | "heuristic" | "unknown"
    group: int
    alternatives: tuple[tuple[int, float], ...]
    crop_png: bytes

    @property
    def is_uncertain(self) -> bool:
        return self.tile is None or self.confidence < LOW_CONFIDENCE

    def to_json(self) -> dict:
        return {
            "index": self.index,
            "tile": self.tile,
            "name": tile_name(self.tile) if self.tile is not None else None,
            "code": tile_to_str(self.tile) if self.tile is not None else None,
            "confidence": round(self.confidence, 3),
            "source": self.source,
            "group": self.group,
            "uncertain": self.is_uncertain,
            "alternatives": [
                {"tile": t, "name": tile_name(t), "score": round(s, 3)}
                for t, s in self.alternatives
            ],
            "crop": "data:image/png;base64," + base64.b64encode(self.crop_png).decode(),
        }


@dataclass(frozen=True)
class RecognitionResult:
    guesses: tuple[TileGuess, ...]
    library_size: int

    @property
    def tiles(self) -> list[int | None]:
        return [g.tile for g in self.guesses]

    @property
    def uncertain_count(self) -> int:
        return sum(1 for g in self.guesses if g.is_uncertain)

    def to_json(self) -> dict:
        return {
            "tiles": [g.to_json() for g in self.guesses],
            "count": len(self.guesses),
            "uncertain_count": self.uncertain_count,
            "library_size": self.library_size,
        }


def _encode_png(image: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".png", image)
    if not ok:
        return b""
    return buffer.tobytes()


def decode_image(data: bytes) -> np.ndarray:
    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise DetectionError("画像を読み込めませんでした (対応形式: JPEG / PNG / WebP)")
    return image


def classify_one(
    features: TileFeatures,
    library: TileLibrary | None,
    prior: TileLibrary | None = None,
) -> tuple[int | None, float, str, list[tuple[int, float]]]:
    """1 枚ぶんの判定。

    優先順位は「自分で登録した牌 → 同梱の初期ライブラリ → 規則ベース」。
    """
    own = library.match(features) if library is not None else None
    base = prior.match(features) if prior is not None else None
    rules = heuristic.classify(features)

    def accept(match, source):
        # 一致度が高くても 2 位と僅差なら確信度を下げる。
        confidence = min(0.99, match.score * (0.75 + min(match.margin, 0.2)))
        return match.tile, confidence, source, [(match.tile, match.score)] + rules[:3]

    if own is not None and own.score >= LIBRARY_TRUST_THRESHOLD:
        return accept(own, "library")
    if base is not None and base.score >= PRIOR_TRUST_THRESHOLD:
        return accept(base, "prior")

    if rules:
        tile, score = rules[0]
        return tile, score, "heuristic", rules[:4]

    fallback = own or base
    if fallback is not None:
        source = "library" if own is not None else "prior"
        return fallback.tile, fallback.score * 0.5, source, [(fallback.tile, fallback.score)]

    return None, 0.0, "unknown", []


def recognize(
    image: np.ndarray,
    library: TileLibrary | None = None,
    prior: TileLibrary | None | str = "default",
) -> RecognitionResult:
    """写真から牌を認識する。

    ``prior`` を省略すると同梱の初期ライブラリを使う。``None`` を渡すと使わない。
    """
    if prior == "default":
        prior = load_prior_library()
    detected: list[DetectedTile] = detect_tiles(image)

    guesses: list[TileGuess] = []
    for tile_image in detected:
        features = extract(tile_image.image)
        tile, confidence, source, alternatives = classify_one(features, library, prior)
        guesses.append(
            TileGuess(
                index=tile_image.order,
                tile=tile,
                confidence=float(confidence),
                source=source,
                group=tile_image.group,
                alternatives=tuple(alternatives),
                crop_png=_encode_png(tile_image.image),
            )
        )

    return RecognitionResult(
        tuple(guesses), library.size if library is not None else 0
    )


def learn_from_corrections(
    image: np.ndarray, assignments: dict[int, int], library: TileLibrary
) -> int:
    """認識結果の手直しをライブラリに反映する。

    Args:
        image: 認識に使ったのと同じ画像。
        assignments: 検出インデックス → 正しい牌 ID。
        library: 追記先。

    Returns:
        実際に登録した枚数。すでに覚えている見た目と区別がつかないものは
        数えない (同じ写真を繰り返し登録してもライブラリが太らないため)。
    """
    detected = detect_tiles(image)
    by_index = {t.order: t for t in detected}
    learned = 0
    for index, tile in assignments.items():
        source = by_index.get(index)
        if source is None:
            continue
        if library.add(tile, extract(source.image)):
            learned += 1
    if learned:
        library.save()
    return learned


__all__ = [
    "LOW_CONFIDENCE",
    "RecognitionResult",
    "TileGuess",
    "decode_image",
    "learn_from_corrections",
    "recognize",
]
