"""和了時の状況 (場風・自風・和了方法・ドラなど) とルール設定。"""

from __future__ import annotations

from dataclasses import dataclass, field

from .tiles import EAST, WINDS


@dataclass(frozen=True)
class Rules:
    """卓ごとに揺れるローカルルールをまとめる。既定値は一般的な設定。"""

    kiriage_mangan: bool = False
    """切り上げ満貫 (30符4翻・60符3翻を満貫として扱う)。"""

    double_wind_pair_fu: int = 2
    """連風牌 (場風かつ自風) の雀頭の符。2 符が主流だが 4 符ルールもある。"""

    allow_kuitan: bool = True
    """喰い断 (鳴き断幺九) を認めるか。"""

    multiple_yakuman: bool = True
    """複合役満を認めるか。False なら最も高い役満ひとつだけを採用する。"""

    double_yakuman: bool = True
    """国士十三面・四暗刻単騎・大四喜・純正九蓮をダブル役満として扱うか。"""


@dataclass(frozen=True)
class WinContext:
    """和了の状況。"""

    round_wind: int = EAST
    seat_wind: int = EAST

    is_tsumo: bool = False
    is_riichi: bool = False
    is_double_riichi: bool = False
    is_ippatsu: bool = False
    is_haitei: bool = False       # 海底摸月
    is_houtei: bool = False       # 河底撈魚
    is_rinshan: bool = False      # 嶺上開花
    is_chankan: bool = False      # 搶槓
    is_tenhou: bool = False       # 天和
    is_chiihou: bool = False      # 地和

    dora_indicators: tuple[int, ...] = ()
    ura_indicators: tuple[int, ...] = ()

    honba: int = 0
    riichi_sticks: int = 0

    rules: Rules = field(default_factory=Rules)

    @property
    def is_dealer(self) -> bool:
        return self.seat_wind == EAST

    def validate(self) -> None:
        if self.round_wind not in WINDS:
            raise ValueError("場風は東南西北のいずれかです")
        if self.seat_wind not in WINDS:
            raise ValueError("自風は東南西北のいずれかです")
        if self.is_tsumo and (self.is_houtei or self.is_chankan):
            if self.is_chankan:
                raise ValueError("搶槓はロン和了のみです")
            raise ValueError("河底撈魚はロン和了のみです")
        if not self.is_tsumo and (self.is_haitei or self.is_rinshan):
            raise ValueError("海底摸月・嶺上開花はツモ和了のみです")
        if self.is_haitei and self.is_houtei:
            raise ValueError("海底と河底は同時に成立しません")
        if self.is_ippatsu and not (self.is_riichi or self.is_double_riichi):
            raise ValueError("一発は立直が前提です")
        if self.is_ippatsu and (self.is_haitei or self.is_houtei):
            raise ValueError("一発と海底/河底は同時に成立しません")
        if self.is_tenhou and self.is_chiihou:
            raise ValueError("天和と地和は同時に成立しません")
        if self.is_tenhou and not (self.is_dealer and self.is_tsumo):
            raise ValueError("天和は親のツモ和了のみです")
        if self.is_chiihou and (self.is_dealer or not self.is_tsumo):
            raise ValueError("地和は子のツモ和了のみです")
        if self.honba < 0 or self.riichi_sticks < 0:
            raise ValueError("本場・供託は 0 以上です")
