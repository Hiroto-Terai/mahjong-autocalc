"""認識精度を測る。合成画像に対して 34 種すべてを検証する。

    python tools/eval_vision.py            # 規則ベースのみ
    python tools/eval_vision.py --library  # 1 枚校正したライブラリを併用
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from render_sample import render_hand_photo  # noqa: E402

from mahjong_autocalc.tiles import parse_tiles, tile_name  # noqa: E402
from mahjong_autocalc.vision import TileLibrary, extract, recognize  # noqa: E402
from mahjong_autocalc.vision.detect import detect_tiles  # noqa: E402

CASES = [
    "123456789m",
    "123456789p",
    "123456789s",
    "1234567z",
    "234567m234567p33s",
    "111222333444p5s",
    "19m19p19s1234567z",
    "1133m5588p224477s",
    "555z666z777z234m11p",
]

CALIBRATION = ["123456789m", "123456789p", "123456789s", "1234567z"]


def photo(notation: str, seed: int = 0) -> np.ndarray:
    return cv2.cvtColor(np.array(render_hand_photo(notation, seed)), cv2.COLOR_RGB2BGR)


def calibrate(library: TileLibrary, seeds=(7,)) -> None:
    for notation in CALIBRATION:
      for seed in seeds:
        expected = list(parse_tiles(notation).tiles)
        image = photo(notation, seed=seed)
        detected = detect_tiles(image)
        if len(detected) != len(expected):
            print(f"  ! 校正スキップ {notation}: {len(detected)} != {len(expected)}")
            continue
        for tile, crop in zip(expected, detected):
            library.add(tile, extract(crop.image))
    library.save()


def main() -> int:
    use_library = "--library" in sys.argv
    library = None
    if use_library:
        tmp = pathlib.Path(tempfile.mkdtemp()) / "lib.npz"
        library = TileLibrary(tmp)
        print("校正中...")
        calibrate(library, seeds=(7, 11, 23))
        print(f"  ライブラリ登録数: {library.size}, 未登録: {len(library.missing())}")

    total = correct = 0
    detect_ok = 0
    for notation in CASES:
        expected = list(parse_tiles(notation).tiles)
        result = recognize(photo(notation, seed=3), library)
        got = [g.tile for g in result.guesses]
        if len(got) != len(expected):
            print(f"{notation}: 検出数ずれ {len(got)} != {len(expected)}")
            continue
        detect_ok += 1
        errors = []
        for e, g in zip(expected, got):
            total += 1
            if e == g:
                correct += 1
            else:
                errors.append(f"{tile_name(e)}→{tile_name(g) if g is not None else '?'}")
        status = "OK" if not errors else " ".join(errors)
        print(f"{notation}: {status}")

    print(f"\n検出成功ケース {detect_ok}/{len(CASES)}")
    print(f"牌の正解率 {correct}/{total} = {correct / max(total, 1):.1%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
