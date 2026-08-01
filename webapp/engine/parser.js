// 手牌を面子構成に分解する。Python 版 mahjong_autocalc/parser.py の移植。

import { HONOR, MeldType, YAOCHU, countTiles } from "./tiles.js";

export const Wait = {
  RYANMEN: "ryanmen",
  PENCHAN: "penchan",
  KANCHAN: "kanchan",
  SHANPON: "shanpon",
  TANKI: "tanki",
};

export function waitFu(wait) {
  return wait === Wait.PENCHAN || wait === Wait.KANCHAN || wait === Wait.TANKI ? 2 : 0;
}

export const HandForm = {
  STANDARD: "standard",
  CHIITOITSU: "chiitoitsu",
  KOKUSHI: "kokushi",
};

export class Group {
  constructor({ isRun, tile, concealed, isKan = false, fromMeld = false }) {
    this.isRun = isRun;
    this.tile = tile;
    this.concealed = concealed;
    this.isKan = isKan;
    this.fromMeld = fromMeld;
  }

  get tiles() {
    if (this.isRun) return [this.tile, this.tile + 1, this.tile + 2];
    return new Array(this.isKan ? 4 : 3).fill(this.tile);
  }

  get isTriplet() {
    return !this.isRun;
  }

  /** この面子が持つ符。 */
  fu() {
    if (this.isRun) return 0;
    const base = this.isKan ? 8 : 2;
    if (!this.concealed) return YAOCHU.has(this.tile) ? base * 2 : base;
    return YAOCHU.has(this.tile) ? base * 4 : base * 2;
  }
}

export class Decomposition {
  constructor(form, pair, groups, wait) {
    this.form = form;
    this.pair = pair;
    this.groups = groups;
    this.wait = wait;
  }

  get allTiles() {
    const out = [];
    if (this.pair !== null && this.pair !== undefined) out.push(this.pair, this.pair);
    for (const group of this.groups) out.push(...group.tiles);
    return out;
  }
}

function meldToGroup(meld) {
  return new Group({
    isRun: meld.type === MeldType.CHII,
    tile: meld.baseTile,
    concealed: meld.type === MeldType.CLOSED_KAN,
    isKan: meld.isKan,
    fromMeld: true,
  });
}

/** 残り牌をすべて面子に分解する。戻り値は [isRun, tile] の組の配列の配列。 */
function extractSets(counts) {
  const index = counts.findIndex((n) => n > 0);
  if (index === -1) return [[]];

  const results = [];

  if (counts[index] >= 3) {
    counts[index] -= 3;
    for (const rest of extractSets(counts)) results.push([[false, index], ...rest]);
    counts[index] += 3;
  }

  if (index < HONOR && index % 9 <= 6 && counts[index + 1] > 0 && counts[index + 2] > 0) {
    counts[index] -= 1; counts[index + 1] -= 1; counts[index + 2] -= 1;
    for (const rest of extractSets(counts)) results.push([[true, index], ...rest]);
    counts[index] += 1; counts[index + 1] += 1; counts[index + 2] += 1;
  }

  return results;
}

function waitForRun(base, winTile) {
  const offset = winTile - base;
  if (offset === 1) return Wait.KANCHAN;
  if (base % 9 === 0 && offset === 2) return Wait.PENCHAN;
  if (base % 9 === 6 && offset === 0) return Wait.PENCHAN;
  return Wait.RYANMEN;
}

/**
 * 和了牌をどの面子の一部と見なすかで場合分けする。
 * ロンの場合、和了牌を含む刻子は明刻扱いになり符が下がる。
 */
function winTilePlacements(pair, concealedGroups, meldGroups, winTile, isTsumo) {
  const out = [];
  const placements = new Set();

  if (pair === winTile) {
    out.push(new Decomposition(HandForm.STANDARD, pair, [...concealedGroups, ...meldGroups], Wait.TANKI));
  }

  concealedGroups.forEach((group, i) => {
    if (!group.tiles.includes(winTile)) return;
    const signature = `${group.isRun}:${group.tile}`;
    if (placements.has(signature)) return;
    placements.add(signature);

    let wait;
    const groups = [...concealedGroups];
    if (group.isRun) {
      wait = waitForRun(group.tile, winTile);
    } else {
      wait = Wait.SHANPON;
      // ロン和了では、和了牌で完成した刻子は明刻として数える。
      if (!isTsumo) {
        groups[i] = new Group({ isRun: false, tile: group.tile, concealed: false });
      }
    }
    out.push(new Decomposition(HandForm.STANDARD, pair, [...groups, ...meldGroups], wait));
  });

  return out;
}

function standardDecompositions(hand, winTile, isTsumo) {
  const counts = countTiles(hand.concealed);
  const meldGroups = hand.melds.map(meldToGroup);
  const seen = new Set();
  const results = [];

  for (let pair = 0; pair < counts.length; pair += 1) {
    if (counts[pair] < 2) continue;
    counts[pair] -= 2;
    for (const combo of extractSets([...counts])) {
      const concealedGroups = combo.map(
        ([isRun, tile]) => new Group({ isRun, tile, concealed: true })
      );
      for (const candidate of winTilePlacements(pair, concealedGroups, meldGroups, winTile, isTsumo)) {
        const key = [
          candidate.pair,
          candidate.groups
            .map((g) => `${g.isRun}|${g.tile}|${g.concealed}|${g.isKan}`)
            .sort()
            .join(","),
          candidate.wait,
        ].join("#");
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(candidate);
      }
    }
    counts[pair] += 2;
  }

  return results;
}

function chiitoitsu(hand) {
  if (hand.melds.length) return [];
  const counts = countTiles(hand.concealed);
  if (counts.filter((n) => n === 2).length !== 7) return [];
  return [new Decomposition(HandForm.CHIITOITSU, null, [], Wait.TANKI)];
}

function kokushi(hand) {
  if (hand.melds.length) return [];
  const counts = countTiles(hand.concealed);
  for (let t = 0; t < 34; t += 1) {
    if (!YAOCHU.has(t) && counts[t]) return [];
  }
  for (const t of YAOCHU) {
    if (counts[t] === 0) return [];
  }
  if (counts.reduce((a, b) => a + b, 0) !== 14) return [];
  const pair = [...YAOCHU].find((t) => counts[t] === 2);
  return [new Decomposition(HandForm.KOKUSHI, pair, [], Wait.TANKI)];
}

/** 和了形として成立するすべての解釈を返す。和了形でなければ空配列。 */
export function decompose(hand, winTile, isTsumo) {
  hand.validate();
  if (!hand.concealed.includes(winTile)) {
    throw new Error("和了牌が手の内に含まれていません");
  }
  return [
    ...kokushi(hand),
    ...chiitoitsu(hand),
    ...standardDecompositions(hand, winTile, isTsumo),
  ];
}
