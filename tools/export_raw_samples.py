"""JS 版の検証用に、合成写真を生の RGB データとして書き出す。

Node 側に JPEG デコーダを持ち込まずに、Python と完全に同じ画素で比較するため。

    python tools/export_raw_samples.py <出力先ディレクトリ>
"""

from __future__ import annotations

import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from render_sample import render_hand_photo  # noqa: E402

from mahjong_autocalc.tiles import parse_tiles  # noqa: E402

CASES = [
    ("123456789m", 3), ("123456789p", 3), ("123456789s", 3), ("1234567z", 3),
    ("234567m234567p33s", 3), ("111222333444p5s", 3), ("19m19p19s1234567z", 3),
    ("1133m5588p224477s", 3), ("555z666z777z234m11p", 3),
    # 校正用 (別のシード)
    ("123456789m", 7), ("123456789p", 7), ("123456789s", 7), ("1234567z", 7),
]


def main() -> int:
    out_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "samples/raw")
    out_dir.mkdir(parents=True, exist_ok=True)

    index = []
    for notation, seed in CASES:
        rgb = np.array(render_hand_photo(notation, seed))  # PIL は RGB
        name = f"{notation}_{seed}"
        (out_dir / f"{name}.bin").write_bytes(rgb.astype(np.uint8).tobytes())
        index.append({
            "name": name,
            "notation": notation,
            "seed": seed,
            "width": int(rgb.shape[1]),
            "height": int(rgb.shape[0]),
            "tiles": list(parse_tiles(notation).tiles),
        })

    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print(f"wrote {len(index)} images to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
