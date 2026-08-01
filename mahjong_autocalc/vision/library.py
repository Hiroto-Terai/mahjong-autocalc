"""ユーザー自身の牌を覚える参照ライブラリ。

牌のデザインはセットごとに違うため、汎用の規則だけでは限界がある。実際に
使っている牌の写真を登録しておけば、以降は最近傍照合でほぼ確実に判別できる。
UI 上で認識結果を手直しすると、その牌が自動的にライブラリへ追加される。

保存先は ``MAHJONG_AUTOCALC_HOME`` (既定: ``~/.mahjong-autocalc``)。
"""

from __future__ import annotations

import os
import pathlib
import threading
from dataclasses import dataclass

import numpy as np

from ..tiles import NUM_TILE_KINDS, tile_name
from .features import TileFeatures, similarity

MAX_SAMPLES_PER_TILE = 12


def default_path() -> pathlib.Path:
    home = os.environ.get("MAHJONG_AUTOCALC_HOME")
    base = pathlib.Path(home) if home else pathlib.Path.home() / ".mahjong-autocalc"
    return base / "tile_library.npz"


@dataclass(frozen=True)
class Match:
    tile: int
    score: float
    margin: float
    """2 位の牌とのスコア差。小さいほど紛らわしい。"""


class TileLibrary:
    """牌 ID ごとに特徴ベクトルを保持する。"""

    def __init__(self, path: pathlib.Path | None = None) -> None:
        self.path = path or default_path()
        self._samples: dict[int, list[np.ndarray]] = {}
        self._lock = threading.Lock()
        self.load()

    # -- 永続化 ---------------------------------------------------------
    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            with np.load(self.path) as data:
                loaded = {
                    int(key): [row.astype(np.float32) for row in data[key]]
                    for key in data.files
                }
        except Exception:
            return
        with self._lock:
            self._samples = loaded

    def save(self) -> None:
        with self._lock:
            payload = {
                str(tile): np.asarray(vectors, dtype=np.float32)
                for tile, vectors in self._samples.items()
                if vectors
            }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp.npz")
        np.savez_compressed(tmp, **payload)
        tmp.replace(self.path)

    # -- 登録 -----------------------------------------------------------
    def add(self, tile: int, features: TileFeatures) -> bool:
        """特徴を登録する。既存とほぼ同じで登録しなかった場合は False。"""
        if not 0 <= tile < NUM_TILE_KINDS:
            raise ValueError(f"牌 ID が範囲外です: {tile}")
        vector = np.asarray(features.descriptor, dtype=np.float32)
        with self._lock:
            samples = self._samples.setdefault(tile, [])
            # ほぼ同じベクトルは足さない (同じ写真を何度も登録しても太らせない)。
            if any(similarity(vector, existing) > 0.995 for existing in samples):
                return False
            samples.append(vector)
            if len(samples) > MAX_SAMPLES_PER_TILE:
                del samples[0]
            return True

    def clear(self) -> None:
        with self._lock:
            self._samples = {}

    # -- 照合 -----------------------------------------------------------
    def match(self, features: TileFeatures) -> Match | None:
        vector = np.asarray(features.descriptor, dtype=np.float32)
        with self._lock:
            if not self._samples:
                return None
            best_per_tile: list[tuple[int, float]] = []
            for tile, samples in self._samples.items():
                if not samples:
                    continue
                score = max(similarity(vector, s) for s in samples)
                best_per_tile.append((tile, score))

        if not best_per_tile:
            return None
        best_per_tile.sort(key=lambda item: -item[1])
        tile, score = best_per_tile[0]
        runner_up = best_per_tile[1][1] if len(best_per_tile) > 1 else 0.0
        return Match(tile=tile, score=float(score), margin=float(score - runner_up))

    # -- 情報 -----------------------------------------------------------
    @property
    def size(self) -> int:
        with self._lock:
            return sum(len(v) for v in self._samples.values())

    def coverage(self) -> dict[str, int]:
        """牌の名前 → 登録枚数。"""
        with self._lock:
            return {
                tile_name(tile): len(vectors)
                for tile, vectors in sorted(self._samples.items())
                if vectors
            }

    def missing(self) -> list[int]:
        """まだ 1 枚も登録されていない牌。"""
        with self._lock:
            return [t for t in range(NUM_TILE_KINDS) if not self._samples.get(t)]


__all__ = ["Match", "MAX_SAMPLES_PER_TILE", "TileLibrary", "default_path"]
