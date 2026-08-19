"""写真から牌を認識するモジュール。

    from mahjong_autocalc.vision import TileLibrary, decode_image, recognize

    image = decode_image(open("hand.jpg", "rb").read())
    result = recognize(image, TileLibrary())
"""

from .detect import DetectionError, detect_tiles
from .features import extract
from .library import TileLibrary
from .prior import load_prior_library
from .pipeline import (
    RecognitionResult,
    TileGuess,
    decode_image,
    learn_from_corrections,
    recognize,
)

__all__ = [
    "DetectionError",
    "RecognitionResult",
    "TileGuess",
    "TileLibrary",
    "load_prior_library",
    "decode_image",
    "detect_tiles",
    "extract",
    "learn_from_corrections",
    "recognize",
]
