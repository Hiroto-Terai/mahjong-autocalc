"""字牌・萬子の漢字テンプレートを生成して ``glyphs.npz`` に書き出す。

実行にはシステムの日本語フォントが必要だが、生成物 (npz) をリポジトリに
同梱するため、ツール利用時にフォントは不要。

    python tools/build_glyph_templates.py
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

GLYPH_SIZE = 32
RENDER_SIZE = 256

# キーは牌 ID ではなく用途ごとのラベル。
GLYPHS = {
    # 字牌
    "z1": "東", "z2": "南", "z3": "西", "z4": "北",
    "z6": "發", "z7": "中",
    # 萬子の数字 (上半分の刻印)
    "m1": "一", "m2": "二", "m3": "三", "m4": "四", "m5": "五",
    "m6": "六", "m7": "七", "m8": "八", "m9": "九",
    # 萬子の下半分
    "man": "萬",
}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    raise SystemExit(
        "日本語フォントが見つかりません。FONT_CANDIDATES にパスを追加してください。"
    )


def render(character: str, font_path: str) -> np.ndarray:
    font = ImageFont.truetype(font_path, int(RENDER_SIZE * 0.82))
    image = Image.new("L", (RENDER_SIZE, RENDER_SIZE), 0)
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = draw.textbbox((0, 0), character, font=font)
    draw.text(
        ((RENDER_SIZE - (right - left)) / 2 - left,
         (RENDER_SIZE - (bottom - top)) / 2 - top),
        character,
        fill=255,
        font=font,
    )

    array = np.array(image)
    ys, xs = np.nonzero(array > 96)
    if len(xs) == 0:
        raise RuntimeError(f"グリフを描画できませんでした: {character}")
    cropped = array[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]

    # 縦横比を保ったまま正方形に収める (実際の刻印も字ごとに縦横比が違うため)。
    h, w = cropped.shape
    side = max(h, w)
    canvas = np.zeros((side, side), dtype=np.uint8)
    canvas[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = cropped

    small = np.array(
        Image.fromarray(canvas).resize((GLYPH_SIZE, GLYPH_SIZE), Image.LANCZOS)
    )
    return (small > 110).astype(np.uint8)


def main() -> int:
    font_path = find_font()
    print(f"font: {font_path}")
    data = {key: render(char, font_path) for key, char in GLYPHS.items()}

    out = pathlib.Path(__file__).resolve().parents[1] / "mahjong_autocalc/vision/glyphs.npz"
    np.savez_compressed(out, **data)
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(data)} glyphs)")

    for key, char in GLYPHS.items():
        art = "\n".join(
            "".join("#" if v else "." for v in row[::2]) for row in data[key][::2]
        )
        print(f"\n--- {key} ({char}) ---\n{art}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
