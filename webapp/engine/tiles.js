// 牌の表現と MPSZ 記法のパース。Python 版 mahjong_autocalc/tiles.py の移植。
//
//   0-8   : 一萬 - 九萬
//   9-17  : 一筒 - 九筒
//   18-26 : 一索 - 九索
//   27-30 : 東 南 西 北
//   31-33 : 白 發 中

export const NUM_TILE_KINDS = 34;

export const MAN = 0;
export const PIN = 9;
export const SOU = 18;
export const HONOR = 27;

export const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
export const HAKU = 31, HATSU = 32, CHUN = 33;

export const WINDS = [EAST, SOUTH, WEST, NORTH];
export const DRAGONS = [HAKU, HATSU, CHUN];

const TERMINALS = [MAN, MAN + 8, PIN, PIN + 8, SOU, SOU + 8];
export const YAOCHU = new Set([...TERMINALS, ...WINDS, ...DRAGONS]);
export const GREEN_TILES = new Set([SOU + 1, SOU + 2, SOU + 3, SOU + 5, SOU + 7, HATSU]);

export const TILE_NAMES_JA = [
  "一萬", "二萬", "三萬", "四萬", "五萬", "六萬", "七萬", "八萬", "九萬",
  "一筒", "二筒", "三筒", "四筒", "五筒", "六筒", "七筒", "八筒", "九筒",
  "一索", "二索", "三索", "四索", "五索", "六索", "七索", "八索", "九索",
  "東", "南", "西", "北", "白", "發", "中",
];

export const WIND_NAMES_JA = { 27: "東", 28: "南", 29: "西", 30: "北" };

const SUIT_ORDER = "mpsz";
const SUIT_BASE = { m: MAN, p: PIN, s: SOU, z: HONOR };

export class InvalidHandError extends Error {}

export const isHonor = (tile) => tile >= HONOR;
export const isTerminal = (tile) => !isHonor(tile) && (tile % 9 === 0 || tile % 9 === 8);
export const isYaochu = (tile) => YAOCHU.has(tile);

export function suitOf(tile) {
  return tile >= HONOR ? "z" : SUIT_ORDER[Math.floor(tile / 9)];
}

export function rankOf(tile) {
  return tile >= HONOR ? tile - HONOR + 1 : (tile % 9) + 1;
}

export const tileName = (tile) => TILE_NAMES_JA[tile];
export const tileToStr = (tile) => `${rankOf(tile)}${suitOf(tile)}`;

export function tilesToStr(tiles) {
  const buckets = { m: [], p: [], s: [], z: [] };
  [...tiles].sort((a, b) => a - b).forEach((t) => buckets[suitOf(t)].push(rankOf(t)));
  let out = "";
  for (const suit of SUIT_ORDER) {
    if (buckets[suit].length) out += buckets[suit].join("") + suit;
  }
  return out;
}

/** ドラ表示牌から実際のドラ牌を求める。 */
export function doraIndicatorToDora(indicator) {
  if (indicator >= HONOR) {
    if (indicator <= NORTH) return EAST + ((indicator - EAST + 1) % 4);
    return HAKU + ((indicator - HAKU + 1) % 3);
  }
  const base = Math.floor(indicator / 9) * 9;
  return base + (((indicator % 9) + 1) % 9);
}

/**
 * "123m456p11z" 形式をパースする。"0" は赤五。
 * @returns {{tiles: number[], redFives: number[]}}
 */
export function parseTiles(notation) {
  const tiles = [];
  const redFives = [];
  let pending = [];

  for (const char of notation) {
    if (/\s|[,\-_]/.test(char)) continue;
    if (/\d/.test(char)) { pending.push(char); continue; }
    if (!(char in SUIT_BASE)) throw new InvalidHandError(`不明な文字です: ${char}`);
    if (!pending.length) throw new InvalidHandError(`'${char}' の前に数字がありません`);

    const base = SUIT_BASE[char];
    for (const digit of pending) {
      const value = Number(digit);
      if (char === "z") {
        if (value < 1 || value > 7) throw new InvalidHandError(`字牌は 1-7 で指定します: ${value}${char}`);
        tiles.push(HONOR + value - 1);
      } else if (value === 0) {
        tiles.push(base + 4);
        redFives.push(base + 4);
      } else if (value >= 1 && value <= 9) {
        tiles.push(base + value - 1);
      } else {
        throw new InvalidHandError(`数牌は 0-9 で指定します: ${value}${char}`);
      }
    }
    pending = [];
  }
  if (pending.length) throw new InvalidHandError("末尾の数字に対応する種類 (m/p/s/z) がありません");
  return { tiles, redFives };
}

export const MeldType = {
  CHII: "chii",
  PON: "pon",
  OPEN_KAN: "open_kan",
  CLOSED_KAN: "closed_kan",
};

export class Meld {
  constructor(type, tiles, redFives = []) {
    this.type = type;
    this.tiles = [...tiles].sort((a, b) => a - b);
    this.redFives = redFives;

    const expected = this.isKan ? 4 : 3;
    if (this.tiles.length !== expected) {
      throw new InvalidHandError(`${type} は ${expected} 枚である必要があります`);
    }
    if (type === MeldType.CHII) {
      const [a, b, c] = this.tiles;
      if (isHonor(a) || b !== a + 1 || c !== a + 2 || a % 9 > 6) {
        throw new InvalidHandError("順子として不正です");
      }
    } else if (new Set(this.tiles).size !== 1) {
      throw new InvalidHandError("刻子/槓子として不正です");
    }
  }

  get isKan() {
    return this.type === MeldType.OPEN_KAN || this.type === MeldType.CLOSED_KAN;
  }

  /** 門前性を保つ副露か。暗槓のみ true。 */
  get isConcealed() {
    return this.type === MeldType.CLOSED_KAN;
  }

  get baseTile() {
    return this.tiles[0];
  }
}

export function countTiles(tiles) {
  const counts = new Array(NUM_TILE_KINDS).fill(0);
  for (const tile of tiles) counts[tile] += 1;
  return counts;
}

export class HandTiles {
  constructor(concealed, melds = [], redFives = []) {
    this.concealed = [...concealed].sort((a, b) => a - b);
    this.melds = melds;
    this.redFives = redFives;
  }

  get allTiles() {
    const out = [...this.concealed];
    for (const meld of this.melds) out.push(...meld.tiles);
    return out;
  }

  get allRedFives() {
    const out = [...this.redFives];
    for (const meld of this.melds) out.push(...meld.redFives);
    return out;
  }

  /** 門前かどうか。暗槓は門前を崩さない。 */
  get isMenzen() {
    return this.melds.every((m) => m.isConcealed);
  }

  validate() {
    const expected = 14 - 3 * this.melds.length;
    if (this.concealed.length !== expected) {
      throw new InvalidHandError(
        `手の内は ${expected} 枚である必要があります ` +
        `(副露 ${this.melds.length} 個 / 実際 ${this.concealed.length} 枚)`
      );
    }
    const counts = countTiles(this.allTiles);
    counts.forEach((n, tile) => {
      if (n > 4) throw new InvalidHandError(`${tileName(tile)} が ${n} 枚あります (上限 4 枚)`);
    });
    for (const tile of this.allRedFives) {
      if (rankOf(tile) !== 5 || isHonor(tile)) {
        throw new InvalidHandError(`赤ドラに指定できない牌です: ${tileName(tile)}`);
      }
    }
  }
}
