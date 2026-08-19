"""牌のデザインを変えたときに、認識がどれだけ通用するかを測る。

これまでの精度測定は 1 種類のデザインだけで行っていた。実際にはセットごとに
下地の色も刻印の描き方も違うので、「デザインをまたいで通用するか」を見ないと
実用の目安にならない。

    python tools/eval_generalization.py [デザイン数]
"""

from __future__ import annotations

import pathlib
import random
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from render_sample import Style, render_hand_photo  # noqa: E402

from mahjong_autocalc.tiles import parse_tiles  # noqa: E402
from mahjong_autocalc.vision import TileLibrary, extract, recognize  # noqa: E402
from mahjong_autocalc.vision.detect import detect_tiles  # noqa: E402

CASES = ["123456789m", "123456789p", "123456789s", "1234567z", "234567m234567p33s"]
CALIBRATION = ["123456789m", "123456789p", "123456789s", "1234567z"]


def random_style(rng: random.Random) -> Style:
    """メーカー違いに相当するばらつきを作る。"""
    def jitter(color, amount=26):
        return tuple(int(max(0, min(255, c + rng.uniform(-amount, amount)))) for c in color)

    return Style(
        ivory=jitter((247, 243, 231), 18),
        edge=jitter((206, 198, 176), 24),
        black=jitter((34, 32, 30), 22),
        red=jitter((183, 40, 36), 32),
        green=jitter((24, 112, 62), 32),
        blue=jitter((36, 74, 148), 32),
        honor_scale=rng.uniform(0.80, 1.10),
        numeral_scale=rng.uniform(0.80, 1.15),
        man_scale=rng.uniform(0.85, 1.10),
        man_is_red=rng.random() < 0.85,
        numeral_gap=rng.uniform(0.0, 0.06),
        circle_scale=rng.uniform(0.80, 1.15),
        circle_ring=rng.random() < 0.6,
        circle_outline=rng.choice([1, 2, 3]),
        circle_monochrome=rng.random() < 0.25,
        stick_w=rng.uniform(0.75, 1.25),
        stick_h=rng.uniform(0.80, 1.20),
        stick_band=rng.random() < 0.6,
    )


def photo(notation: str, seed: int, style: Style) -> np.ndarray:
    return cv2.cvtColor(np.array(render_hand_photo(notation, seed, style)), cv2.COLOR_RGB2BGR)


def calibrate(library: TileLibrary, style: Style) -> None:
    for notation in CALIBRATION:
        expected = list(parse_tiles(notation).tiles)
        detected = detect_tiles(photo(notation, 7, style))
        if len(detected) != len(expected):
            continue
        for tile, crop in zip(expected, detected):
            library.add(tile, extract(crop.image))


def score(library, style) -> tuple[int, int]:
    correct = total = 0
    for notation in CASES:
        expected = list(parse_tiles(notation).tiles)
        got = [g.tile for g in recognize(photo(notation, 3, style), library).guesses]
        if len(got) != len(expected):
            total += len(expected)
            continue
        total += len(expected)
        correct += sum(1 for e, g in zip(expected, got) if e == g)
    return correct, total


def main() -> int:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    rng = random.Random(20260801)

    print(f"{count} 種類のデザインで測定します\n")
    print(f"{'デザイン':<10}{'規則ベースのみ':>16}{'同じデザインで登録':>20}{'別デザインで登録':>20}")
    print("-" * 68)

    # 「別デザインで登録」= あるデザインで登録したライブラリを、別のデザインに使う。
    # 集めた画像を混ぜて学習させたときに起きることの縮図。
    base_style = random_style(rng)
    foreign = TileLibrary(pathlib.Path(tempfile.mkdtemp()) / "foreign.npz")
    calibrate(foreign, base_style)

    totals = [0, 0, 0]
    grand = 0
    for i in range(count):
        style = random_style(rng)

        plain_c, plain_t = score(None, style)

        own = TileLibrary(pathlib.Path(tempfile.mkdtemp()) / f"own{i}.npz")
        calibrate(own, style)
        own_c, _ = score(own, style)

        foreign_c, _ = score(foreign, style)

        totals[0] += plain_c
        totals[1] += own_c
        totals[2] += foreign_c
        grand += plain_t
        print(f"{i + 1:<10}{plain_c / plain_t:>15.0%}{own_c / plain_t:>20.0%}{foreign_c / plain_t:>20.0%}")

    print("-" * 68)
    print(f"{'平均':<10}{totals[0] / grand:>15.0%}{totals[1] / grand:>20.0%}{totals[2] / grand:>20.0%}")
    print()
    print("規則ベースのみ      : 何も登録していない状態 (写真を撮っただけ)")
    print("同じデザインで登録  : そのセットを自分で登録した状態")
    print("別デザインで登録    : 他のセットで作ったライブラリを流用した状態")
    return 0


if __name__ == "__main__":
    sys.exit(main())
