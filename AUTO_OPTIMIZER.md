# Auto-Optimizer Specification

This document specifies the auto-optimizer exactly as implemented. The goal is that the algorithm could be reconstructed from this document alone. Code lives in `src/autoOptimize.js`; the underlying pipeline lives in `src/metrics.js` (`runPipeline`); the optimizer is invoked from `src/ProcedureMode.jsx` once per Procedure Mode commit. A Node parity test lives at `scripts/verifyOptimizer.mjs`.

## 1. Purpose & invariants

For each commit step in Procedure Mode, the optimizer searches the IS rows of that step for a small set of additional filters that improve metrics over a "do-nothing" baseline, picks one winner per outcome column, and returns those winners. The Procedure Mode caller then replays each winner on OOS rows and persists both alongside the manual version.

The implementation is governed by three invariants:

1. **Single source of truth.** Every candidate evaluation goes through `runPipeline(rows, snapshot, config)`. The optimizer never duplicates filter / DLL / overlap / metric math. Manual mode and the optimizer's baseline are byte-identical.
2. **No OOS leakage.** Distinct-value enumeration is performed only on the IS rows passed in, *after* the fixed filters' `applyFilters` step. The optimizer never sees OOS rows or rows the fixed filters already excluded.
3. **Per-outcome independence.** Each outcome column ranks candidates against its own metrics. Baseline (fixed filters only) is always in the pool, so the winner can be "no extra filters" if nothing beats it.

## 2. Inputs

`runOptimizer(isRows, fixedFilters, candidateSpecs, weights, topK, config)`:

- `isRows` — array of CSV row objects (the IS slice for the current step).
- `fixedFilters` — snapshot shape:
  ```
  { filterGroups, dailyLossLimit, overlap }
  ```
  - `filterGroups`: array of groups; each group is an AND of conditions; groups are OR'd. (Same shape used by Free Mode.)
  - `dailyLossLimit`: `{ col, value, timeCol, sessionStart }`. Per spec, fixed DLL is always disabled in optimizer setup (the optimizer searches DLL itself), but the field is preserved.
  - `overlap`: `{ enabled, mode, compareCol, entryDateCol, entryTimeCol, lossTimeCol, exitMap }`. The optimizer never modifies overlap; winners always inherit fixed overlap as-is.
- `candidateSpecs` — array of spec objects (see §4).
- `weights` — `{ rpt, net, dd }`, non-negative; sum must be > 0 (UI enforces).
- `topK` — integer ≥ 1 (default `DEFAULT_TOP_K = 8`).
- `config` — `{ outcomeCols, lossCol, dateCol, ... }`. The optimizer reads `outcomeCols` and `dateCol`; passes the rest through to `runPipeline`.

Default weights: `{ rpt: 1/3, net: 1/3, dd: 1/3 }` (`DEFAULT_WEIGHTS`).

## 3. The pipeline (recap)

`runPipeline(rows, filters, config)` in `metrics.js`:

1. `applyFilters(rows, activeGroups)` — keep rows matching ANY group's full AND.
2. `applyDailyLossLimit(...)` — uses `filters.dailyLossLimit.col` as the day key, `lossCol` as the loss column, `parseInt(value, 10)` as the limit, optional session-start anchoring. Returns rows unchanged when col is empty or limit ≤ 0.
3. Per outcome:
   - Optional `applyOverlapFilter` per-outcome (only when `overlap.enabled` and required columns are set; uses `overlap.exitMap[oc]` for the per-outcome exit-time column).
   - `buildReturnSeriesDated(ocRows, oc, lossCol, dateCol)` produces `[{ value, type, date }]`. A row contributes a *win* (or breakeven if value = 0) if its outcome cell is non-empty; else it contributes a *loss* equal to `-|loss|` if the loss cell is non-empty; else it contributes nothing.
   - `calcMetrics(series)` produces `{ total, winCount, lossCount, breakEvenCount, winPct, netReturn, grossReturn, grossLoss, avgReturn, sortino, maxDD, longestDD, avgDDLength }`.

The optimizer reads `metrics.total` (for the `minOccurrences` gate) and `metrics.{avgReturn, netReturn, maxDD}` (for scoring).

## 4. Candidate specs and Phase-1 expansion

A spec is a directive that expands into one or more **patches**. A patch is what the optimizer ANDs onto the fixed filters.

### Domain (used by all categorical specs)

```
domain = applyFilters(isRows, fixedFilters.filterGroups)
```

`enumerateDistinctValues(domain, column)`:
- Collect non-null, non-empty values as strings into a Set.
- If every value parses as a finite number, sort numerically ascending. Otherwise sort lexicographically.

### 4.1 `categorical_individual { column, minOccurrences }`

For each distinct value `v` in `enumerateDistinctValues(domain, column)`, emit one patch:

- `label = "${column} = ${v}"`
- `additionalGroups = [ [ { column, operator: "equals", value: v } ] ]`
- `minOccurrences = spec.minOccurrences | 0`

Count: number of distinct values.

### 4.2 `categorical_combinations { column, minOccurrences }`

For each non-empty subset of distinct values **except the full set**, emit one patch. Subsets are enumerated by bitmask `mask = 1 .. (1<<n)-1`, skipping the case `subset.length === n`.

- `label = "${column} ∈ {v1, v2, ...}"` (subset values joined by `", "`, in enumeration order)
- `additionalGroups = subset.map(v => [ { column, operator: "equals", value: v } ])` (one group per value — these get OR'd via the distributive product in §5)
- `minOccurrences = spec.minOccurrences | 0`

Count: `2^n − 2` for `n` distinct values.

### 4.3 `range_gte { column, max, increment, minOccurrences }`

`steps = floor(max / increment + 1e-9)`. For `i = 0 .. steps`, `v = i * increment`:

- `label = "${column} >= ${v}"`
- `additionalGroups = [ [ { column, operator: "gte", value: String(v) } ] ]`

Skipped entirely if `max ≤ 0` or `increment ≤ 0`. Count: `floor(max / increment) + 1`.

### 4.4 `range_lte { column, max, increment, minOccurrences }`

Same as `range_gte` but operator `"lte"` and label `"${column} <= ${v}"`.

### 4.5 `daily_loss_limit { max, minOccurrences }`

For `v = 0 .. max` (integer step 1), emit:

- `label = "Daily Loss Limit = ${v}"`
- `dllValue = v` (no `additionalGroups`)

Skipped if `max < 0`. Count: `max + 1`. Note that `v = 0` produces a "DLL disabled" candidate (since `applyDailyLossLimit` is a no-op when the limit ≤ 0); it is structurally redundant with baseline but goes through the same gate.

## 5. Snapshot construction

`buildFilterSnapshot(fixedFilters, patches, dateCol)` ANDs a list of patches onto the fixed filters and returns a full snapshot:

1. **Split patches.** `dllPatch` = the DLL patch in the list (if multiple, the last one wins). `groupPatches` = the rest.

2. **Distribute group patches.** Start with `groups = fixedFilters.filterGroups` (filtered to non-empty groups). If empty, start with `[[]]`. For each group patch, replace `groups` with the Cartesian product:

   ```
   next = []
   for fg in groups:
     for cg in patch.additionalGroups:
       next.push(fg ++ cg)
   groups = next
   ```

   This implements `(fixedOR) AND (patchOR)` = OR of all element-wise ANDs. Two patches in the same column collapse: e.g. two `categorical_individual` patches `col=A` and `col=B` produce a group containing both equalities, which matches zero rows.

3. **DLL.** If `dllPatch` is present, the snapshot's DLL is `{ col: dateCol, value: String(dllPatch.dllValue), timeCol: "", sessionStart: "" }`. Otherwise inherit `fixedFilters.dailyLossLimit`.

4. **Overlap.** Always inherit `fixedFilters.overlap` unchanged.

The result is fed verbatim into `runPipeline`.

## 6. Search algorithm

Three phases. Phase 0 and Phase 1 are outcome-agnostic (one pipeline run per snapshot); Phase 2 selection is per-outcome but its pipeline runs are cached across outcomes by patch-label signature.

### Phase 0 — baseline

```
baselineSnapshot = buildFilterSnapshot(fixedFilters, [], dateCol)
baselineRun     = runPipeline(isRows, baselineSnapshot, config)
```

One pipeline run.

### Phase 1 — every patch individually

For every patch produced by §4:

```
snap = buildFilterSnapshot(fixedFilters, [patch], dateCol)
run  = runPipeline(isRows, snap, config)
```

Stored as `phase1Runs = [{ patches: [patch], snapshot, run }, ...]`. One pipeline run per patch.

### Phase 2 — top-K subset combinations (per outcome)

For each outcome `oc`:

1. **Apply minOccurrences gate.** Drop entries where `run.perOutcome[oc].metrics.total < patch.minOccurrences`.

2. **Score initial pool.** `initialPool = [baselineEntry, ...validPhase1]`. Compute `initialScores = scoreCandidates(initialMetrics, weights)` (see §7).

3. **Pick top-K survivors.** A non-baseline entry `i` survives if `initialScores[i] >= baselineScore - EPS` (i.e., tied-or-better than baseline; `EPS = 1e-9`). Sort survivors descending by score; take the first `topK`.

4. **Generate Phase-2 subsets.** Let `k = topKEntries.length`. For each non-singleton bitmask subset of those k entries (i.e. all subsets of size ≥ 2; there are `2^k − k − 1` of them), build a candidate combination. Each "Phase-2 patch list" is the patches from those entries (one patch per entry).

5. **Cache & evaluate.** Phase-2 runs are deduped across outcomes by a signature: the sorted patch labels joined with `" ∧ "`. On cache miss:

   ```
   snap = buildFilterSnapshot(fixedFilters, subsetPatches, dateCol)
   run  = runPipeline(isRows, snap, config)
   ```

6. **Phase-2 minOccurrences gate.** A combination's threshold is `max(p.minOccurrences for p in subsetPatches)`. Combinations failing the gate are dropped from this outcome's pool.

7. **Final pool.** `finalPool = [baselineEntry, ...validPhase1, ...phase2Entries]`. Rescore the entire pool with `scoreCandidates`.

### Selection (per outcome)

`bestIdx` starts at 0 (baseline). Iterate `i = 1 .. n−1`:

- Skip `i` if `finalScores[i] < baselineFinalScore - EPS` (must be tied-or-better than baseline).
- If `finalScores[i] > finalScores[bestIdx] + EPS` → take `i`.
- Else if `|finalScores[i] − finalScores[bestIdx]| ≤ EPS` and `totalConditions(finalPool[i].snapshot) < totalConditions(finalPool[bestIdx].snapshot)` → take `i`.

The winner is `finalPool[bestIdx]`. Baseline always remains a candidate, so a winner exists for every outcome.

`totalConditions(snapshot)` = `Σ |group|` over `filterGroups`, plus 1 if `parseInt(dailyLossLimit.value, 10) > 0`. A 4-value `categorical_combinations` patch contributes 4 conditions (per the distributive expansion), correctly de-prioritizing wide ORs against single equalities at score ties.

## 7. Scoring

Three metrics, all per-outcome:

| Metric | Source field | Direction |
| --- | --- | --- |
| RU/trade | `metrics.avgReturn` | descending (higher = better) |
| Net RU | `metrics.netReturn` | descending |
| Max DD | `metrics.maxDD` | ascending (lower = better) |

`percentileRanks(values, direction)`:

- If `n === 0` return `[]`. If `n === 1` return `[1]`.
- Sort indexed `(v, i)` by `direction`.
- Walk the sorted array; for each run of values equal within `EPS`, assign every index in that run the average rank `(i + j) / 2` (0-indexed; ties get the centroid).
- Convert rank to percentile: `(n − 1 − rank) / (n − 1)`. Best rank = 1.0; worst = 0.0.

`scoreCandidates(metricsList, weights)`:

```
pRpt = percentileRanks([m.avgReturn for m in list], "desc")
pNet = percentileRanks([m.netReturn for m in list], "desc")
pDd  = percentileRanks([m.maxDD     for m in list], "asc")
wsum = (weights.rpt + weights.net + weights.dd) || 1
score[i] = (weights.rpt * pRpt[i] + weights.net * pNet[i] + weights.dd * pDd[i]) / wsum
```

`scoreCandidates` is called twice per outcome: once on the initial pool (to pick top-K survivors) and once on the final pool (to pick the winner). The scores are not comparable across the two pools because the percentile pool changes.

## 8. Outputs

`runOptimizer` returns:

```
{
  perOutcome: {
    [outcome]: {
      filters,         // chosen full snapshot — feed back into runPipeline to reproduce
      metrics,         // IS metrics for the chosen snapshot, this outcome
      returnSeries,    // dated IS series for the chosen snapshot, this outcome
      rowCount,        // post-overlap row count for this outcome
      score,           // composite score in the final pool
      candidatesUsed,  // labels of patches selected; [] when baseline won
    }
  },
  domainSize,            // |IS rows after fixed filters' applyFilters step|
  candidatesEvaluated,   // total pipeline runs across Phase 0 + 1 + 2 (deduped)
}
```

`runOptimizerWinnersOnRows(perOutcomeWinners, rows, config)` replays each winner's locked `filters` snapshot via `runPipeline` against a fresh row set (typically OOS) and returns the same per-outcome shape minus `score`, plus the original `candidatesUsed`.

## 9. Pre-flight estimate

`estimateCandidateCount(domain, specs, topK)` is used by the setup screen to warn before a procedure starts:

```
phase1 = sum over specs:
  categorical_individual    : |distinct(domain, col)|
  categorical_combinations  : max(0, 2^|distinct(domain, col)| - 2)
  range_gte | range_lte     : floor(max / inc) + 1   (when max>0 and inc>0)
  daily_loss_limit          : max + 1                (when max>=0)

k = min(topK, phase1)
phase2 = (k >= 2) ? (2^k - k - 1) : 0
total  = phase1 + phase2 + 1   // +1 for baseline
```

Worst case Phase 2 only: actual run count is bounded above by this value because (a) some Phase-1 candidates fail `minOccurrences` or score below baseline and get cut before Phase 2, and (b) Phase-2 combinations are deduped across outcomes by patch-label signature.

## 10. Setup-screen validation

The Procedure Mode setup screen (`ProcedureMode.jsx`) refuses to start a run unless, when the optimizer is enabled:

- `candidates.length > 0`,
- every categorical / range spec has a non-empty `column`,
- every `range_gte` / `range_lte` spec has `Number(max) > 0` and `Number(increment) > 0`,
- every `daily_loss_limit` spec has `Number(max) >= 0`,
- `weights.rpt + weights.net + weights.dd > 0`,
- `topK >= 1`.

`minOccurrences` is not validated by the setup gate. The UI defaults it to 3 and clamps the input to integers via `parseInt(...) || 0`; the optimizer reads it via `spec.minOccurrences | 0`, which coerces missing/NaN values to 0.

## 11. Determinism

Given the same `(isRows, fixedFilters, candidateSpecs, weights, topK, config)`, `runOptimizer` is deterministic. There is no randomness, no time dependence, and no parallel non-determinism. Floating-point ties are resolved by `EPS = 1e-9` thresholds in scoring and selection, so values within that tolerance are treated as identical.
