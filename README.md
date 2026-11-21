[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Kikuk00/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Kikuk00/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Push-optimal Sokoban solver

A solver for [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121): `main.ts` answers all 5 instances of a set in one run, in as few pushes as possible. On the kit's practice set it solves every instance in exactly its push-optimal count P\* — 13, 16, 29, 47 and 60 pushes — for a score of 1,000,000, beating the house baseline (plain-astar 1.0.0, 200,000 on the same set).

## Why it beats the house baseline

The house baseline runs a plain A\* over single steps across the whole level, with a Manhattan-distance estimate and no deadlock knowledge, so it spends its budget on positions no push can save and gives up on every level with more than one room.

This entry uses the structure of the drawn levels instead:

- **Room decomposition.** Every level is a 1-wide hallway with 1–4 rooms off it, and a box pushed out of a room's door can never return — so each room is an independent problem and the level's optimum is the sum of its rooms' optima. The solver cuts the hallway's dead squares out of the floor, finds the rooms, and solves each one on its own, stitching the moves together with walks through the hallway.
- **Push-based A\*.** One step of the search is one push (the player's position only matters as the reachable region it stands in), so the search optimises pushes directly instead of steps.
- **Assignment heuristic.** The estimate is the minimum-cost matching of boxes to goals over shortest-path distances that ignore boxes — admissible, since one push moves a box one square.
- **Deadlock pruning.** Dead squares (a box there can never be pulled onto a goal) and frozen 2×2 blocks of walls and boxes are never entered.
- **Deterministic budgets.** The search budgets by expansions, never by the wall clock, and every tie breaks in a fixed order, so two runs write byte-identical outputs — as the rules require, since the entry is executed twice and the outputs must match. A push-ordered breadth-first search with the same pruning backs up A\* if it ever gives up on a room, and the same search over the whole level backs up a level that does not split into rooms.

## Layout

- `main.ts` — the solver (Node 22, standard library only, no dependencies).
- `.makefun/owner.json` — the payout wallet for this entry.

## Testing

Run the solver on the kit's practice set and score it with the kit's scorer:

```
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=scores node <kit>/program/scorer/score.ts
```

Result: score 1,000,000 — every instance solved in exactly P\* pushes (13, 16, 29, 47, 60), in about 0.3 s for the whole set on this machine, and two runs write byte-identical outputs. Six further sets drawn with the kit's own generator also score 1,000,000 each, in 0.3–0.4 s apiece, including a room with a 20-push optimum.

## Licence

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=wmk9f4s6&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
