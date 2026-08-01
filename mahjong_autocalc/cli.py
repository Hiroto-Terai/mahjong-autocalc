"""コマンドラインから使うためのインターフェース。

    # 使っている牌をライブラリに覚えさせる (1 回だけ)
    python -m mahjong_autocalc.cli calibrate manzu.jpg 123456789m

    # 写真から認識結果だけ見る
    python -m mahjong_autocalc.cli recognize hand.jpg

    # 写真から点数まで出す
    python -m mahjong_autocalc.cli score hand.jpg --win 7m --tsumo --riichi --seat 南
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from .calculator import NoYakuError, NotWinningHandError, calculate
from .context import Rules, WinContext
from .tiles import (
    EAST,
    HandTiles,
    InvalidHandError,
    WIND_NAMES_JA,
    parse_tiles,
    tile_name,
    tiles_to_str,
)
from .vision import (
    DetectionError,
    TileLibrary,
    decode_image,
    detect_tiles,
    extract,
    recognize,
)

_WIND_BY_NAME = {name: tile for tile, name in WIND_NAMES_JA.items()}


def _read(path: str):
    data = pathlib.Path(path).read_bytes()
    return decode_image(data)


def _wind(value: str) -> int:
    if value in _WIND_BY_NAME:
        return _WIND_BY_NAME[value]
    parsed = parse_tiles(value)
    if len(parsed.tiles) != 1 or parsed.tiles[0] not in WIND_NAMES_JA:
        raise argparse.ArgumentTypeError(f"風牌として解釈できません: {value}")
    return parsed.tiles[0]


def _one_tile(value: str) -> int:
    parsed = parse_tiles(value)
    if len(parsed.tiles) != 1:
        raise argparse.ArgumentTypeError(f"牌 1 枚で指定してください: {value}")
    return parsed.tiles[0]


def cmd_calibrate(args: argparse.Namespace) -> int:
    library = TileLibrary()
    expected = list(parse_tiles(args.tiles).tiles)
    detected = detect_tiles(_read(args.image))

    if len(detected) != len(expected):
        print(
            f"検出したのは {len(detected)} 枚ですが、指定は {len(expected)} 枚です。"
            "牌を一列に並べ直して撮り直してください。",
            file=sys.stderr,
        )
        return 1

    for tile, crop in zip(expected, detected):
        library.add(tile, extract(crop.image))
    library.save()

    missing = library.missing()
    print(f"{len(expected)} 枚を登録しました (合計 {library.size} 件)")
    if missing:
        print("未登録: " + " ".join(tile_name(t) for t in missing))
    else:
        print("34 種すべて登録済みです")
    return 0


def cmd_recognize(args: argparse.Namespace) -> int:
    library = TileLibrary()
    result = recognize(_read(args.image), library if library.size else None)

    for guess in result.guesses:
        name = tile_name(guess.tile) if guess.tile is not None else "?"
        mark = " ⚠" if guess.is_uncertain else ""
        print(f"[{guess.index:2}] {name:4} {guess.confidence:.2f} ({guess.source}){mark}")

    tiles = [g.tile for g in result.guesses if g.tile is not None]
    print(f"\n{tiles_to_str(tiles)}")
    if result.uncertain_count:
        print(f"{result.uncertain_count} 枚は自信がありません。")
    if not library.size:
        print("ヒント: calibrate で牌を登録すると精度が上がります。")
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    library = TileLibrary()
    result = recognize(_read(args.image), library if library.size else None)
    tiles = [g.tile for g in result.guesses if g.tile is not None]

    if len(tiles) != len(result.guesses):
        print("認識できない牌があります。calibrate を試してください。", file=sys.stderr)
        return 1

    print(f"認識: {tiles_to_str(tiles)}")
    if result.uncertain_count:
        print(f"（うち {result.uncertain_count} 枚は自信なし）")

    hand = HandTiles(tuple(sorted(tiles)))
    context = WinContext(
        round_wind=args.round,
        seat_wind=args.seat,
        is_tsumo=args.tsumo,
        is_riichi=args.riichi,
        is_ippatsu=args.ippatsu,
        dora_indicators=tuple(args.dora or ()),
        ura_indicators=tuple(args.ura or ()),
        honba=args.honba,
        riichi_sticks=args.sticks,
        rules=Rules(kiriage_mangan=args.kiriage, allow_kuitan=not args.no_kuitan),
    )

    win_tile = args.win if args.win is not None else tiles[-1]
    try:
        calc = calculate(hand, win_tile, context)
    except (NotWinningHandError, NoYakuError, InvalidHandError, ValueError) as exc:
        print(f"計算できません: {exc}", file=sys.stderr)
        return 1

    print(f"\n和了牌: {tile_name(win_tile)}")
    print(f"形: {calc.describe_hand_shape()}")
    print()
    for yaku in calc.yaku:
        label = "役満" if yaku.yakuman == 1 else ("ダブル役満" if yaku.yakuman > 1 else f"{yaku.han}翻")
        print(f"  {yaku.name:<16}{label}")
    for dora in calc.dora:
        print(f"  {dora.name:<16}{dora.han}翻")

    limit = f" ({calc.score.limit_name})" if calc.score.limit_name else ""
    print(f"\n{calc.fu}符 {calc.han}翻{limit}")

    payments = calc.score.payments
    if context.is_tsumo:
        if context.is_dealer:
            print(f"子 各 {payments.from_each_non_dealer}点")
        else:
            print(f"親 {payments.from_dealer}点 / 子 各 {payments.from_each_non_dealer}点")
    else:
        print(f"放銃者から {payments.from_discarder}点")
    print(f"合計 {payments.total}点")
    return 0


def cmd_library(args: argparse.Namespace) -> int:
    library = TileLibrary()
    print(f"保存先: {library.path}")
    print(f"登録数: {library.size}")
    missing = library.missing()
    if missing:
        print("未登録: " + " ".join(tile_name(t) for t in missing))
    else:
        print("34 種すべて登録済みです")
    if args.reset:
        library.clear()
        library.save()
        print("登録を削除しました")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mahjong_autocalc", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    calibrate = sub.add_parser("calibrate", help="写真に写っている牌をライブラリに登録する")
    calibrate.add_argument("image")
    calibrate.add_argument("tiles", help="写真に並んでいる牌 (例: 123456789m)")
    calibrate.set_defaults(func=cmd_calibrate)

    recognize_cmd = sub.add_parser("recognize", help="写真から牌を認識する")
    recognize_cmd.add_argument("image")
    recognize_cmd.set_defaults(func=cmd_recognize)

    score = sub.add_parser("score", help="写真から点数を計算する")
    score.add_argument("image")
    score.add_argument("--win", type=_one_tile, help="和了牌 (省略時は一番右の牌)")
    score.add_argument("--round", type=_wind, default=EAST, help="場風 (既定: 東)")
    score.add_argument("--seat", type=_wind, default=EAST, help="自風 (既定: 東)")
    score.add_argument("--tsumo", action="store_true")
    score.add_argument("--riichi", action="store_true")
    score.add_argument("--ippatsu", action="store_true")
    score.add_argument("--dora", type=_one_tile, action="append", help="ドラ表示牌")
    score.add_argument("--ura", type=_one_tile, action="append", help="裏ドラ表示牌")
    score.add_argument("--honba", type=int, default=0)
    score.add_argument("--sticks", type=int, default=0, help="供託の本数")
    score.add_argument("--kiriage", action="store_true", help="切り上げ満貫あり")
    score.add_argument("--no-kuitan", action="store_true", help="喰い断なし")
    score.set_defaults(func=cmd_score)

    lib = sub.add_parser("library", help="登録状況を見る")
    lib.add_argument("--reset", action="store_true", help="登録をすべて削除する")
    lib.set_defaults(func=cmd_library)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (DetectionError, InvalidHandError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
