"""テスト・デモ用に牌を並べた擬似写真を生成する。

本物の写真の代わりにはならないが、検出と切り出し (何枚に分けるか、順番は
合っているか) を機械的に検証するには十分な入力になる。

    python tools/render_sample.py "234567m234567p33s" samples/hand.jpg
"""

from __future__ import annotations

import pathlib
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from mahjong_autocalc.tiles import parse_tiles, rank_of, suit_of  # noqa: E402

TILE_W, TILE_H = 120, 165
FACE_INSET = 7

IVORY = (247, 243, 231)
EDGE = (206, 198, 176)
BLACK = (34, 32, 30)
RED = (183, 40, 36)
GREEN = (24, 112, 62)
BLUE = (36, 74, 148)

FONT_PATHS = [
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
]
KANJI_NUM = "一二三四五六七八九"
HONOR_CHARS = "東南西北白發中"


class FontNotFoundError(RuntimeError):
    """牌を描くための日本語フォントが見つからない。"""


def font_path() -> str | None:
    for path in FONT_PATHS:
        if pathlib.Path(path).exists():
            return path
    return None


def _font(size: int) -> ImageFont.FreeTypeFont:
    path = font_path()
    if path is None:
        raise FontNotFoundError(
            "日本語フォントが見つかりません "
            "(Debian/Ubuntu: apt install fonts-ipafont-gothic)"
        )
    return ImageFont.truetype(path, size)


def _centered(draw: ImageDraw.ImageDraw, box, text, font, fill) -> None:
    x0, y0, x1, y1 = box
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(
        (x0 + (x1 - x0 - (right - left)) / 2 - left,
         y0 + (y1 - y0 - (bottom - top)) / 2 - top),
        text,
        font=font,
        fill=fill,
    )


def _circle_layout(rank: int) -> list[tuple[float, float]]:
    """筒子の丸の配置 (0-1 の相対座標)。"""
    layouts = {
        1: [(0.5, 0.5)],
        2: [(0.5, 0.3), (0.5, 0.7)],
        3: [(0.28, 0.25), (0.5, 0.5), (0.72, 0.75)],
        4: [(0.3, 0.3), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7)],
        5: [(0.28, 0.26), (0.72, 0.26), (0.5, 0.5), (0.28, 0.74), (0.72, 0.74)],
        6: [(0.3, 0.22), (0.7, 0.22), (0.3, 0.5), (0.7, 0.5), (0.3, 0.78), (0.7, 0.78)],
        7: [(0.26, 0.2), (0.5, 0.28), (0.74, 0.36),
            (0.28, 0.62), (0.72, 0.62), (0.28, 0.84), (0.72, 0.84)],
        8: [(0.3, 0.18), (0.7, 0.18), (0.3, 0.4), (0.7, 0.4),
            (0.3, 0.62), (0.7, 0.62), (0.3, 0.84), (0.7, 0.84)],
        9: [(0.24, 0.2), (0.5, 0.2), (0.76, 0.2),
            (0.24, 0.5), (0.5, 0.5), (0.76, 0.5),
            (0.24, 0.8), (0.5, 0.8), (0.76, 0.8)],
    }
    return layouts[rank]


def _stick_layout(rank: int) -> list[tuple[float, float]]:
    """索子の竹の配置。"""
    if rank == 2:
        return [(0.5, 0.3), (0.5, 0.7)]
    if rank == 3:
        return [(0.5, 0.25), (0.32, 0.68), (0.68, 0.68)]
    if rank == 4:
        return [(0.32, 0.3), (0.68, 0.3), (0.32, 0.7), (0.68, 0.7)]
    if rank == 5:
        return [(0.3, 0.25), (0.7, 0.25), (0.5, 0.5), (0.3, 0.75), (0.7, 0.75)]
    if rank == 6:
        return [(0.3, 0.3), (0.5, 0.3), (0.7, 0.3), (0.3, 0.72), (0.5, 0.72), (0.7, 0.72)]
    if rank == 7:
        return [(0.5, 0.18), (0.3, 0.5), (0.5, 0.5), (0.7, 0.5),
                (0.3, 0.82), (0.5, 0.82), (0.7, 0.82)]
    if rank == 8:
        return [(0.35, 0.2), (0.65, 0.2), (0.3, 0.47), (0.5, 0.47), (0.7, 0.47),
                (0.3, 0.8), (0.5, 0.8), (0.7, 0.8)]
    return [(0.3, 0.2), (0.5, 0.2), (0.7, 0.2), (0.3, 0.5), (0.5, 0.5), (0.7, 0.5),
            (0.3, 0.8), (0.5, 0.8), (0.7, 0.8)]


def render_tile(tile: int, red_five: bool = False) -> Image.Image:
    image = Image.new("RGB", (TILE_W, TILE_H), EDGE)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (2, 2, TILE_W - 3, TILE_H - 3), radius=10, fill=(232, 227, 212)
    )
    face = (FACE_INSET, FACE_INSET, TILE_W - FACE_INSET - 1, TILE_H - FACE_INSET - 1)
    draw.rounded_rectangle(face, radius=7, fill=IVORY)

    suit = suit_of(tile)
    rank = rank_of(tile)
    inner = (FACE_INSET + 6, FACE_INSET + 6, TILE_W - FACE_INSET - 7, TILE_H - FACE_INSET - 7)

    if suit == "z":
        char = HONOR_CHARS[rank - 1]
        if char == "白":
            draw.rectangle(
                (inner[0] + 8, inner[1] + 10, inner[2] - 8, inner[3] - 10),
                outline=(196, 190, 172),
                width=3,
            )
        else:
            color = GREEN if char == "發" else (RED if char == "中" else BLACK)
            _centered(draw, inner, char, _font(78), color)

    elif suit == "m":
        top = (inner[0], inner[1], inner[2], inner[1] + (inner[3] - inner[1]) * 0.48)
        bottom = (inner[0], inner[1] + (inner[3] - inner[1]) * 0.50, inner[2], inner[3])
        numeral_color = RED if red_five else BLACK
        _centered(draw, top, KANJI_NUM[rank - 1], _font(46), numeral_color)
        _centered(draw, bottom, "萬", _font(50), RED)

    elif suit == "p":
        radius = {1: 30, 2: 24, 3: 21, 4: 21, 5: 19, 6: 18, 7: 16, 8: 15, 9: 15}[rank]
        palette = [BLUE, GREEN, RED]
        for i, (fx, fy) in enumerate(_circle_layout(rank)):
            cx = inner[0] + (inner[2] - inner[0]) * fx
            cy = inner[1] + (inner[3] - inner[1]) * fy
            color = RED if (red_five and rank == 5 and i == 2) else palette[i % 3]
            draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius),
                         fill=color, outline=BLACK, width=2)
            draw.ellipse((cx - radius * 0.3, cy - radius * 0.3,
                          cx + radius * 0.3, cy + radius * 0.3), fill=IVORY)

    else:  # 索子
        if rank == 1:
            cx = (inner[0] + inner[2]) / 2
            cy = (inner[1] + inner[3]) / 2
            draw.ellipse((cx - 26, cy - 40, cx + 26, cy + 20), fill=GREEN, outline=BLACK, width=2)
            draw.ellipse((cx - 10, cy - 36, cx + 14, cy - 10), fill=IVORY, outline=BLACK)
            draw.polygon([(cx - 4, cy + 18), (cx + 20, cy + 44), (cx - 18, cy + 44)], fill=RED)
        else:
            for i, (fx, fy) in enumerate(_stick_layout(rank)):
                cx = inner[0] + (inner[2] - inner[0]) * fx
                cy = inner[1] + (inner[3] - inner[1]) * fy
                color = RED if (red_five and rank == 5 and i == 2) else GREEN
                draw.rounded_rectangle((cx - 9, cy - 21, cx + 9, cy + 21),
                                       radius=5, fill=color, outline=BLACK, width=2)
                draw.line((cx - 9, cy, cx + 9, cy), fill=IVORY, width=3)

    return image


def render_row(tiles: list[int], reds: set[int], gap: int = 3) -> Image.Image:
    width = len(tiles) * TILE_W + (len(tiles) - 1) * gap
    strip = Image.new("RGB", (width, TILE_H), (60, 60, 60))
    used_red = set()
    for i, tile in enumerate(tiles):
        red = tile in reds and tile not in used_red
        if red:
            used_red.add(tile)
        strip.paste(render_tile(tile, red), (i * (TILE_W + gap), 0))
    return strip


def photographize(strip: Image.Image, seed: int = 0) -> Image.Image:
    """卓の上に置いて斜めから撮ったような画像に加工する。"""
    rng = random.Random(seed)
    margin_x, margin_y = 90, 130
    canvas = Image.new(
        "RGB",
        (strip.width + margin_x * 2, strip.height + margin_y * 2),
        (28, 92, 66),  # 麻雀マットの緑
    )
    canvas.paste(strip, (margin_x, margin_y))

    # 軽い射影変形
    w, h = canvas.size
    shift = rng.uniform(0.01, 0.03)
    coeffs = _perspective_coeffs(
        [(0, 0), (w, 0), (w, h), (0, h)],
        [(w * shift, h * shift * 0.6), (w * (1 - shift * 0.5), 0),
         (w, h * (1 - shift * 0.3)), (w * shift * 0.4, h)],
    )
    canvas = canvas.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    # 照明のむらとノイズ
    array = np.asarray(canvas).astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    gradient = 0.80 + 0.35 * (1 - ((xx / w - 0.4) ** 2 + (yy / h - 0.35) ** 2))
    array *= gradient[:, :, None]
    array += np.random.default_rng(seed).normal(0, 3.5, array.shape)
    canvas = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
    return canvas.filter(ImageFilter.GaussianBlur(0.6))


def _perspective_coeffs(source, target):
    matrix = []
    for (sx, sy), (tx, ty) in zip(source, target):
        matrix.append([tx, ty, 1, 0, 0, 0, -sx * tx, -sx * ty])
        matrix.append([0, 0, 0, tx, ty, 1, -sy * tx, -sy * ty])
    a = np.array(matrix, dtype=np.float64)
    b = np.array(source, dtype=np.float64).reshape(8)
    return np.linalg.solve(a, b).tolist()


def render_hand_photo(notation: str, seed: int = 0) -> Image.Image:
    parsed = parse_tiles(notation)
    return photographize(render_row(list(parsed.tiles), set(parsed.red_fives)), seed)


def main() -> int:
    notation = sys.argv[1] if len(sys.argv) > 1 else "234567m234567p33s"
    out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "samples/hand.jpg")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        render_hand_photo(notation).save(out, quality=88)
    except FontNotFoundError as exc:
        print(exc, file=sys.stderr)
        return 1
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
