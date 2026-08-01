"""画像認識のテスト。

合成した擬似写真を入力にして、検出 → 分類 → 学習の流れが壊れていないことを
確認する。実写ではないので分類の絶対精度は問わず、「切り出しが正しいか」と
「登録した牌を引き当てられるか」を見る。
"""

from __future__ import annotations

import pathlib
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))

from render_sample import font_path, render_hand_photo  # noqa: E402

# 擬似写真の生成に日本語フォントが要る。無い環境では検証できないので飛ばす。
if font_path() is None:
    pytest.skip(
        "日本語フォントが無いため画像認識のテストを飛ばします "
        "(Debian/Ubuntu: apt install fonts-ipafont-gothic)",
        allow_module_level=True,
    )

from mahjong_autocalc.tiles import parse_tiles, tile_name  # noqa: E402
from mahjong_autocalc.vision import TileLibrary, extract, recognize  # noqa: E402
from mahjong_autocalc.vision.detect import DetectionError, detect_tiles  # noqa: E402
from mahjong_autocalc.vision.features import TILE_H, TILE_W  # noqa: E402


def photo(notation: str, seed: int = 0) -> np.ndarray:
    return cv2.cvtColor(np.array(render_hand_photo(notation, seed)), cv2.COLOR_RGB2BGR)


# ---------------------------------------------------------------------------
# 検出
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "notation",
    [
        "123456789m",
        "1234567z",
        "234567m234567p33s",
        "19m19p19s1234567z",
        "1133m5588p224477s",
    ],
)
def test_detects_expected_tile_count(notation):
    expected = len(parse_tiles(notation).tiles)
    detected = detect_tiles(photo(notation, seed=3))
    assert len(detected) == expected


def test_detected_tiles_are_normalized_and_ordered():
    detected = detect_tiles(photo("123456789m", seed=1))
    assert [t.order for t in detected] == list(range(9))
    for tile in detected:
        assert tile.image.shape == (TILE_H, TILE_W, 3)
        assert tile.quad.shape == (4, 2)


def test_blank_image_raises():
    blank = np.full((400, 600, 3), 30, dtype=np.uint8)
    with pytest.raises(DetectionError):
        detect_tiles(blank)


# ---------------------------------------------------------------------------
# 特徴量
# ---------------------------------------------------------------------------


def test_features_separate_colors():
    detected = detect_tiles(photo("1234567z", seed=3))
    features = [extract(t.image) for t in detected]
    hatsu = features[5]  # 發
    chun = features[6]   # 中
    assert hatsu.green_ratio > 0.4
    assert chun.red_ratio > 0.4


def test_manzu_ink_splits_into_two_bands():
    """萬子は「漢数字」と「萬」で刻印が上下に割れる。"""
    detected = detect_tiles(photo("123456789m", seed=3))
    for tile in detected:
        features = extract(tile.image)
        assert len(features.bands) >= 2


# ---------------------------------------------------------------------------
# ライブラリ (学習)
# ---------------------------------------------------------------------------


def _calibrate(library: TileLibrary, notation: str, seed: int) -> None:
    expected = list(parse_tiles(notation).tiles)
    detected = detect_tiles(photo(notation, seed))
    assert len(detected) == len(expected)
    for tile, crop in zip(expected, detected):
        library.add(tile, extract(crop.image))


def test_library_round_trip(tmp_path):
    library = TileLibrary(tmp_path / "lib.npz")
    for notation in ("123456789m", "123456789p", "123456789s", "1234567z"):
        _calibrate(library, notation, seed=7)

    assert library.missing() == []
    library.save()

    reloaded = TileLibrary(tmp_path / "lib.npz")
    assert reloaded.size == library.size
    assert reloaded.missing() == []


def test_library_recognition_beats_heuristic(tmp_path):
    """34 種を登録すれば、規則ベースだけのときより明確に当たるようになる。"""
    library = TileLibrary(tmp_path / "lib.npz")
    for notation in ("123456789m", "123456789p", "123456789s", "1234567z"):
        _calibrate(library, notation, seed=7)

    cases = ["234567m234567p33s", "1133m5588p224477s", "19m19p19s1234567z"]
    without = with_ = total = 0
    for notation in cases:
        expected = list(parse_tiles(notation).tiles)
        image = photo(notation, seed=3)
        plain = [g.tile for g in recognize(image, None).guesses]
        learned = [g.tile for g in recognize(image, library).guesses]
        assert len(plain) == len(expected)
        total += len(expected)
        without += sum(1 for e, g in zip(expected, plain) if e == g)
        with_ += sum(1 for e, g in zip(expected, learned) if e == g)

    assert with_ > without
    assert with_ / total >= 0.95, f"登録後の正解率が低い: {with_}/{total}"


def test_library_marks_results_as_confident(tmp_path):
    library = TileLibrary(tmp_path / "lib.npz")
    for notation in ("123456789m", "123456789p", "123456789s", "1234567z"):
        _calibrate(library, notation, seed=7)

    result = recognize(photo("123456789p", seed=3), library)
    assert result.uncertain_count == 0
    assert all(g.source == "library" for g in result.guesses)


def test_unknown_tiles_are_flagged_not_guessed_confidently():
    """未登録の状態では、数の判別は自信なしとして扱われる。"""
    result = recognize(photo("123456789s", seed=3), None)
    assert result.uncertain_count > 0


def test_result_json_is_serializable():
    import json

    result = recognize(photo("1234567z", seed=3), None)
    payload = result.to_json()
    assert json.dumps(payload)
    assert payload["count"] == 7
    assert payload["tiles"][0]["crop"].startswith("data:image/png;base64,")


def test_learn_from_corrections_updates_library(tmp_path):
    from mahjong_autocalc.vision import learn_from_corrections

    library = TileLibrary(tmp_path / "lib.npz")
    notation = "1234567z"
    image = photo(notation, seed=3)
    expected = list(parse_tiles(notation).tiles)

    learned = learn_from_corrections(
        image, {i: tile for i, tile in enumerate(expected)}, library
    )
    assert learned == len(expected)
    assert library.size == len(expected)

    result = recognize(image, library)
    names = [tile_name(g.tile) for g in result.guesses]
    assert names == [tile_name(t) for t in expected]
