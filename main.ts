// Sokoban solver: push-optimal, room by room.
//
// The levels this competition draws are a 1-wide hallway (the player starts
// there) with 1-4 rooms off it, each room holding 3-4 boxes and as many goals.
// A box pushed out of a room's door into the hallway can never come back, so
// every box stays in its room and a level's push-optimum is the sum of its
// rooms' optima. This solver therefore detects the rooms, solves each room on
// its own as a push-optimal problem entered from its door, and stitches the
// rooms' move strings together with walks through the hallway.
//
// Each room is solved with push-based A* (one step of the search is one push;
// the player's position only matters as the reachable region it stands in):
//   - heuristic: the minimum-cost assignment (Hungarian, brute-forced for
//     <= 4 boxes) of boxes to goals over shortest-path distances that ignore
//     boxes. One push moves a box one square, so this never overestimates.
//   - deadlock pruning: dead squares (a box there can never be pulled onto a
//     goal, ignoring the other boxes) and frozen 2x2 blocks of walls/boxes.
//   - transposition table keyed on (boxes, lowest square of the player's
//     reachable region).
// If A* gives up on a room, a push-ordered breadth-first search with the same
// pruning takes over; the generator only keeps rooms that search solves, so
// the fallback is a real safety net, not a hope. If a level does not split
// into rooms at all, the same search runs over the whole level.
//
// Determinism: the search budgets by expansions, never by the wall clock;
// every tie breaks in a fixed order, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in state expansions, never in seconds: a run on one
// CPU must finish the whole set inside 60 s, and the same input must always
// give the same output, so the clock is never consulted.
const ASTAR_MAX = 200_000;
const BFS_MAX = 100_000;
const WHOLE_ASTAR_MAX = 60_000;
const WHOLE_BFS_MAX = 60_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse an XSB level; the outermost frame is wall whatever it shows. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can ever reach a goal from: pull back from the goals.
 * From a square x a box can be pulled to x + d when the player can stand at
 * x - d, i.e. both x - d and x - 2d are open floor (boxes ignored).
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Shortest walking distances from one goal over open floor alone (boxes
 * ignored), -1 where unreachable. One BFS per goal.
 */
function distancesFrom(level: Level, from: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Flood-fill the player's reachable region from `from` around walls and the
 * boxes in `occupied`; marks squares in `seen` with `stamp` and returns the
 * region's lowest square, which names the region in a state's key.
 */
function floodLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes with a box among them off its goal.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= wall.length) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower-case LURD. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// A state's key: the region's lowest square and the boxes' squares. As one
// number while size ** (boxes + 1) stays under 2 ** 53 (rooms of <= 5 boxes),
// as a string otherwise (a whole level of up to 16 boxes).
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}:${boxes.join(',')}`;
}

/**
 * Push-optimal solution of `level`: {pushes, moves} (lower letter a step,
 * upper a push), or null when the search gives up. `astar` picks A* with the
 * assignment heuristic; without it the search is push-ordered BFS, which is
 * optimal too and explores in a fixed order. Both prune dead squares and
 * frozen 2x2 blocks, and both stop at `maxExpansions` expansions.
 */
function solvePush(level: Level, maxExpansions: number, astar: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // The assignment heuristic: cheapest way to match boxes to goals over
  // walking distances that ignore boxes. <= 4 boxes, so a branch-and-bound
  // over the matchings (24 at most) is exact and cheap.
  const distFromGoal = goals.map((g) => distancesFrom(level, g));
  const heuristic = (boxes: number[]): number => {
    const n = boxes.length;
    let best = Infinity;
    const used = new Array<boolean>(n).fill(false);
    const rec = (i: number, sum: number): void => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      for (let g = 0; g < n; g++) {
        if (used[g]) continue;
        const d = distFromGoal[g]![boxes[i]!]!;
        if (d < 0) continue;
        used[g] = true;
        rec(i + 1, sum + d);
        used[g] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states, in the order found: boxes, player square, pushes so far,
  // parent, and the push that made them (box from -> to).
  const stBoxes: number[][] = [level.boxes];
  const stPlayer: number[] = [level.player];
  const stG: number[] = [0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, floodLow(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Open list: a heap on (f, -g, insertion order). f = g + h for A*, f = g
  // for BFS. Ties go to the deeper state, then to the earlier found.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let seq = 0;
  const h0 = astar ? heuristic(level.boxes) : 0;
  if (h0 === Infinity) return null;
  heapPush([h0, 0, seq++, 0]);
  let expanded = 0;
  let found = solved(level.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, g, , s] = heapPop();
    // Skip a stale entry: a cheaper way to this state was recorded since it
    // was pushed. The first pop of a state that is not stale has its optimal
    // push count, so a solved state popped here is push-optimal.
    if (g !== stG[s]) continue;
    const boxes = stBoxes[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    expanded++;
    if (expanded > maxExpansions) return null;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    floodLow(level, occupied, stPlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box; the square ahead
        // must be open, empty and live.
        if (seen[b - d] !== here || t < 0 || t >= size || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, floodLow(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const h = astar ? heuristic(next!) : 0;
        if (h === Infinity) continue;
        const known = best.get(key);
        if (known !== undefined) {
          // Same boxes and region reached cheaper: rewrite that state with
          // the cheaper parent. It cannot have been expanded yet: with a
          // consistent heuristic a popped state's push count is optimal.
          if (stG[known]! <= g + 1) continue;
          stG[known] = g + 1;
          stPlayer[known] = b;
          parent[known] = s;
          pushFrom[known] = b;
          pushTo[known] = t;
          heapPush([g + 1 + h, g + 1, seq++, known]);
          continue;
        }
        const tIdx = stBoxes.length;
        best.set(key, tIdx);
        stBoxes.push(next!);
        stPlayer.push(b);
        stG.push(g + 1);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        heapPush([g + 1 + h, g + 1, seq++, tIdx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = stBoxes[s]!;
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when a box starts in the hallway, a goal falls
 * in a cut part, or some part holds more or fewer boxes than goals: then the
 * level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve a whole level without decomposing it, A* then BFS. */
function solveWhole(level: Level): { pushes: number; moves: string } | null {
  return solvePush(level, WHOLE_ASTAR_MAX, true) ?? solvePush(level, WHOLE_BFS_MAX, false);
}

/** Solve one level's text into its move string. */
function solve(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solveWhole(level);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    // The other rooms' boxes stand as walls (on their goals once done), so
    // this room solves on its own; the player walks on from where it stands.
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePush(sub, ASTAR_MAX, true) ?? solvePush(sub, BFS_MAX, false);
    if (solved === null) {
      const whole = solveWhole(level);
      return whole === null ? '' : whole.moves;
    }
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
