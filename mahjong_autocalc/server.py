"""ローカルで動かす Web API。

    uvicorn mahjong_autocalc.server:app --reload

画像はサーバー内のメモリに一時的に置くだけで、外部には一切送信しない。
"""

from __future__ import annotations

import pathlib
import uuid
from collections import OrderedDict

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .calculator import Calculation, NoYakuError, NotWinningHandError, calculate
from .context import Rules, WinContext
from .tiles import (
    HandTiles,
    InvalidHandError,
    Meld,
    MeldType,
    NUM_TILE_KINDS,
    dora_indicator_to_dora,
    tile_name,
    tile_to_str,
)
from .vision import DetectionError, TileLibrary, decode_image, learn_from_corrections, recognize

WEB_DIR = pathlib.Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
IMAGE_CACHE_SIZE = 8

app = FastAPI(title="麻雀 点数自動計算", version=__version__)

_library = TileLibrary()
_images: OrderedDict[str, bytes] = OrderedDict()


def _remember_image(data: bytes) -> str:
    key = uuid.uuid4().hex
    _images[key] = data
    while len(_images) > IMAGE_CACHE_SIZE:
        _images.popitem(last=False)
    return key


# ---------------------------------------------------------------------------
# リクエスト定義
# ---------------------------------------------------------------------------


class MeldInput(BaseModel):
    type: str
    tiles: list[int]
    red_fives: list[int] = Field(default_factory=list)


class RulesInput(BaseModel):
    kiriage_mangan: bool = False
    double_wind_pair_fu: int = 2
    allow_kuitan: bool = True
    multiple_yakuman: bool = True
    double_yakuman: bool = True


class CalculateRequest(BaseModel):
    concealed: list[int]
    win_tile: int
    melds: list[MeldInput] = Field(default_factory=list)
    red_fives: list[int] = Field(default_factory=list)

    round_wind: int = 27
    seat_wind: int = 27
    is_tsumo: bool = False
    is_riichi: bool = False
    is_double_riichi: bool = False
    is_ippatsu: bool = False
    is_haitei: bool = False
    is_houtei: bool = False
    is_rinshan: bool = False
    is_chankan: bool = False
    is_tenhou: bool = False
    is_chiihou: bool = False

    dora_indicators: list[int] = Field(default_factory=list)
    ura_indicators: list[int] = Field(default_factory=list)
    honba: int = 0
    riichi_sticks: int = 0
    rules: RulesInput = Field(default_factory=RulesInput)


class LearnRequest(BaseModel):
    image_id: str
    assignments: dict[int, int]


# ---------------------------------------------------------------------------
# 変換
# ---------------------------------------------------------------------------


def _build_hand(request: CalculateRequest) -> HandTiles:
    melds = []
    for meld in request.melds:
        try:
            melds.append(
                Meld(MeldType(meld.type), tuple(sorted(meld.tiles)), tuple(meld.red_fives))
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"副露が不正です: {exc}") from exc
    return HandTiles(
        tuple(sorted(request.concealed)), tuple(melds), tuple(request.red_fives)
    )


def _build_context(request: CalculateRequest) -> WinContext:
    return WinContext(
        round_wind=request.round_wind,
        seat_wind=request.seat_wind,
        is_tsumo=request.is_tsumo,
        is_riichi=request.is_riichi,
        is_double_riichi=request.is_double_riichi,
        is_ippatsu=request.is_ippatsu,
        is_haitei=request.is_haitei,
        is_houtei=request.is_houtei,
        is_rinshan=request.is_rinshan,
        is_chankan=request.is_chankan,
        is_tenhou=request.is_tenhou,
        is_chiihou=request.is_chiihou,
        dora_indicators=tuple(request.dora_indicators),
        ura_indicators=tuple(request.ura_indicators),
        honba=request.honba,
        riichi_sticks=request.riichi_sticks,
        rules=Rules(**request.rules.model_dump()),
    )


def _calculation_to_json(calc: Calculation) -> dict:
    payments = calc.score.payments
    return {
        "han": calc.han,
        "fu": calc.fu,
        "yakuman": calc.score.yakuman,
        "limit_name": calc.score.limit_name,
        "hand_shape": calc.describe_hand_shape(),
        "is_dealer": calc.context.is_dealer,
        "is_tsumo": calc.context.is_tsumo,
        "yaku": [
            {"name": y.name, "han": y.han, "yakuman": y.yakuman} for y in calc.yaku
        ],
        "dora": [{"name": d.name, "han": d.han} for d in calc.dora],
        "fu_details": [{"label": d.label, "fu": d.fu} for d in calc.fu_result.details],
        "fu_raw": calc.fu_result.raw_fu,
        "payments": {
            "from_discarder": payments.from_discarder,
            "from_dealer": payments.from_dealer,
            "from_each_non_dealer": payments.from_each_non_dealer,
            "riichi_sticks": payments.riichi_sticks,
            "total": payments.total,
        },
    }


# ---------------------------------------------------------------------------
# エンドポイント
# ---------------------------------------------------------------------------


@app.get("/api/tiles")
def list_tiles() -> dict:
    return {
        "tiles": [
            {"tile": t, "name": tile_name(t), "code": tile_to_str(t)}
            for t in range(NUM_TILE_KINDS)
        ]
    }


@app.post("/api/recognize")
async def api_recognize(image: UploadFile = File(...)) -> dict:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="画像が空です")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="画像が大きすぎます (上限 20MB)")

    try:
        decoded = decode_image(data)
        result = recognize(decoded, _library)
    except DetectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    payload = result.to_json()
    payload["image_id"] = _remember_image(data)
    return payload


@app.post("/api/calculate")
def api_calculate(request: CalculateRequest) -> dict:
    hand = _build_hand(request)
    context = _build_context(request)
    try:
        calc = calculate(hand, request.win_tile, context)
    except (NotWinningHandError, NoYakuError, InvalidHandError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _calculation_to_json(calc)


@app.post("/api/learn")
def api_learn(request: LearnRequest) -> dict:
    data = _images.get(request.image_id)
    if data is None:
        raise HTTPException(
            status_code=404, detail="元の画像が見つかりません。もう一度読み込んでください"
        )
    for tile in request.assignments.values():
        if not 0 <= tile < NUM_TILE_KINDS:
            raise HTTPException(status_code=400, detail=f"牌 ID が不正です: {tile}")

    try:
        learned = learn_from_corrections(decode_image(data), request.assignments, _library)
    except DetectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"learned": learned, "library_size": _library.size, "missing": _library.missing()}


@app.get("/api/library")
def api_library() -> dict:
    return {
        "size": _library.size,
        "path": str(_library.path),
        "coverage": _library.coverage(),
        "missing": [
            {"tile": t, "name": tile_name(t)} for t in _library.missing()
        ],
    }


@app.delete("/api/library")
def api_library_reset() -> dict:
    _library.clear()
    _library.save()
    return {"size": _library.size}


@app.get("/api/dora")
def api_dora(indicator: int) -> dict:
    if not 0 <= indicator < NUM_TILE_KINDS:
        raise HTTPException(status_code=400, detail="牌 ID が不正です")
    tile = dora_indicator_to_dora(indicator)
    return {"tile": tile, "name": tile_name(tile)}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
