"""多数のデザインから作った「初期ライブラリ」を試作・評価する。

登録なしでどこまで当たるかを確かめるためのもの。学習に使っていないデザインで
評価するので、手元の牌に対する見込みの目安になる。

    python tools/build_prior_library.py            # 評価のみ
    python tools/build_prior_library.py --write    # 同梱用に書き出す
"""

from __future__ import annotations

import json
import pathlib
import random
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from eval_generalization import CALIBRATION, CASES, random_style  # noqa: E402
from render_sample import Style, render_hand_photo  # noqa: E402

from mahjong_autocalc.tiles import parse_tiles  # noqa: E402
from mahjong_autocalc.vision import TileLibrary, extract, recognize  # noqa: E402
from mahjong_autocalc.vision.detect import detect_tiles  # noqa: E402

TRAIN_DESIGNS = 40
TEST_DESIGNS = 12
SEEDS = (7, 15, 23)
KEEP_PER_TILE = 8


def photo(notation: str, seed: int, style: Style) -> np.ndarray:
    return cv2.cvtColor(np.array(render_hand_photo(notation, seed, style)), cv2.COLOR_RGB2BGR)


def collect(styles: list[Style]) -> dict[int, list[np.ndarray]]:
    """デザインごとに 34 種を切り出して、牌 ID ごとの特徴ベクトルを集める。"""
    samples: dict[int, list[np.ndarray]] = {}
    for index, style in enumerate(styles):
        for notation in CALIBRATION:
            expected = list(parse_tiles(notation).tiles)
            for seed in SEEDS:
                detected = detect_tiles(photo(notation, seed, style))
                if len(detected) != len(expected):
                    continue
                for tile, crop in zip(expected, detected):
                    samples.setdefault(tile, []).append(extract(crop.image).descriptor)
        print(f"  デザイン {index + 1}/{len(styles)} 収集済み", end="\r", flush=True)
    print()
    return samples


def reduce_samples(vectors: list[np.ndarray], keep: int) -> list[np.ndarray]:
    """似たものを間引いて、ばらつきのある代表だけ残す (貪欲に最遠点を選ぶ)。

    照合は最近傍なので、同じような見た目を何本持っていても効果が薄い。
    互いに離れたものを選んだほうが、未知のデザインを拾いやすい。
    """
    if len(vectors) <= keep:
        return vectors
    chosen = [vectors[0]]
    remaining = vectors[1:]
    while len(chosen) < keep and remaining:
        best_index, best_distance = 0, -1.0
        for i, candidate in enumerate(remaining):
            distance = min(1.0 - float(np.dot(candidate, c)) for c in chosen)
            if distance > best_distance:
                best_index, best_distance = i, distance
        chosen.append(remaining.pop(best_index))
    return chosen


def quantize(vectors: list[np.ndarray]) -> tuple[np.ndarray, float]:
    """記述子を uint8 に落とす。値は非負なのでそのまま尺度を掛けるだけでよい。"""
    stacked = np.asarray(vectors, dtype=np.float32)
    scale = float(stacked.max())
    codes = np.clip(np.round(stacked / scale * 255), 0, 255).astype(np.uint8)
    return codes, scale


def dequantize(codes: np.ndarray, scale: float) -> list[np.ndarray]:
    out = []
    for row in codes.astype(np.float32) * (scale / 255):
        norm = np.linalg.norm(row)
        out.append((row / norm if norm > 1e-6 else row).astype(np.float32))
    return out


def evaluate(library, styles: list[Style]) -> tuple[int, int]:
    correct = total = 0
    for style in styles:
        for notation in CASES:
            expected = list(parse_tiles(notation).tiles)
            got = [g.tile for g in recognize(photo(notation, 3, style), library).guesses]
            total += len(expected)
            if len(got) != len(expected):
                continue
            correct += sum(1 for e, g in zip(expected, got) if e == g)
    return correct, total


def main() -> int:
    rng = random.Random(20260801)
    train_styles = [random_style(rng) for _ in range(TRAIN_DESIGNS)]
    test_styles = [random_style(rng) for _ in range(TEST_DESIGNS)]

    print(f"学習用デザイン {TRAIN_DESIGNS} 種から特徴を集めます")
    samples = collect(train_styles)
    print(f"  集めた総数: {sum(len(v) for v in samples.values())} 本")

    print("\n1 牌あたりの保持数を変えて、未知のデザインでの正解率を見ます")
    print(f"{'保持数':<10}{'総ベクトル数':>14}{'未知デザインでの正解率':>26}")
    print("-" * 52)

    best = None
    for keep in (4, 8, 12, 20, 32):
        library = TileLibrary(pathlib.Path(tempfile.mkdtemp()) / "prior.npz")
        # TileLibrary の内部は _samples。ここを間違えるとライブラリが
        # 使われないまま規則ベースの数字が出るだけになる。
        library._samples = {
            tile: reduce_samples(vectors, keep) for tile, vectors in samples.items()
        }
        correct, total = evaluate(library, test_styles)
        size = library.size
        print(f"{keep:<10}{size:>14}{correct / total:>25.0%}")
        if best is None or correct > best[1]:
            best = (keep, correct, total, library)

    print("-" * 52)
    print(f"(参考) 規則ベースのみ: {evaluate(None, test_styles)[0] / total:.0%}")

    # 同梱するのは量子化した状態なので、その状態で測り直す。
    selected = {tile: reduce_samples(v, KEEP_PER_TILE) for tile, v in samples.items()}
    tiles = sorted(selected)
    codes, scale = quantize([v for t in tiles for v in selected[t]])

    quantized = TileLibrary(pathlib.Path(tempfile.mkdtemp()) / "q.npz")
    offset = 0
    quantized._samples = {}
    for tile in tiles:
        n = len(selected[tile])
        quantized._samples[tile] = dequantize(codes[offset:offset + n], scale)
        offset += n

    q_correct, q_total = evaluate(quantized, test_styles)
    print(f"\n量子化後 (1 牌 {KEEP_PER_TILE} 本): {q_correct}/{q_total} = {q_correct / q_total:.0%}")

    if "--write" in sys.argv:
        # ブラウザ版: 生バイト + 小さなメタ情報
        binary = pathlib.Path("webapp/vision/prior-library.bin")
        binary.write_bytes(codes.tobytes())
        meta = pathlib.Path("webapp/vision/prior-library.json")
        meta.write_text(json.dumps({
            "version": 1,
            "note": "合成デザインから作った初期ライブラリ。利用者が登録した牌はこれより優先される。",
            "dims": int(codes.shape[1]),
            "scale": scale,
            "counts": {str(t): len(selected[t]) for t in tiles},
        }, separators=(",", ":"), ensure_ascii=False))
        print(f"書き出し: {binary} ({binary.stat().st_size / 1024:.0f} KB)")
        print(f"書き出し: {meta} ({meta.stat().st_size / 1024:.1f} KB)")

        # Python 版
        npz = pathlib.Path("mahjong_autocalc/vision/prior_library.npz")
        np.savez_compressed(
            npz, scale=np.float32(scale),
            **{str(t): np.asarray(quantized._samples[t], dtype=np.float32) for t in tiles},
        )
        print(f"書き出し: {npz} ({npz.stat().st_size / 1024:.0f} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
