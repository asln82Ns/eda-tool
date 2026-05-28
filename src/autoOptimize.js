// Auto-Optimizer search module.
//
// Pure functions, no React, no side effects. Goes through `runPipeline`
// from metrics.js so optimizer results are byte-identical to running the
// same filter snapshot through Procedure Mode by hand.
//
// ════════════════════════════════════════════════════════════════════
// OOS FIREWALL — non-negotiable invariant
// ════════════════════════════════════════════════════════════════════
// `runOptimizer` MUST receive only:
//   • isRows         — in-sample rows for the current step
//   • fixedFilters   — user-locked filter snapshot
//   • candidateSpecs — patch generation specs
//   • weights, topK  — scoring config
//   • config         — column wiring (dateCol, outcomeCols, lossCol)
//   • history        — summary of FROZEN past committed steps (see shape below)
//
// It MUST NEVER receive raw OOS rows for the current step or any future
// step. The function signature has no parameter that *can* hold OOS rows;
// to introduce a leak, someone would have to add one. The caller
// (ProcedureMode) is the sole gatekeeper.
//
// `history` shape — every field is derived from already-committed prior
// steps that the user has already reviewed. It contains NO raw rows:
//   {
//     priorWinners: {                      // last committed step's winners
//       [outcomeCol]: [patchLabel, ...]    // patch labels chosen previously
//     },
//     priorPatchMetrics: {                 // per-patch IS-metric trajectory
//       [outcomeCol]: {
//         [patchLabel]: [                  // newest first, oldest last
//           { avgReturn, total }, ...
//         ]
//       }
//     },
//     trust: number in [0.3, 1.0]          // calibration scalar from prior
//                                          // (IS metric vs realized OOS)
//                                          // gaps. Optimizer attenuates its
//                                          // score toward baseline by trust.
//   }
//
// Any field the optimizer doesn't recognize is silently ignored — extra
// keys cannot widen the data scope.
//
// CRITICAL accuracy invariants (preserved from original implementation):
//   • Distinct-value enumeration uses ONLY the IS rows passed in AND ONLY
//     rows that survive the fixed filters' applyFilters step.
//   • Test filters are added as additional AND-conditions on top of the
//     fixed `filterGroups`, then run through the SAME pipeline. No
//     duplicated math — single source of truth via runPipeline.
//   • Per-outcome winners are independent.

import { applyFilters, runPipeline, parseDateToISO } from "./metrics.js";

export const DEFAULT_TOP_K = 8;
export const DEFAULT_WEIGHTS = Object.freeze({
  rpt: 1 / 3,
  net: 1 / 3,
  dd: 1 / 3,
});

// ── Tunable defaults (Phase 1–4) ──────────────────────────────────
// These can later be exposed in the UI; for now they're sensible defaults.
export const DEFAULT_BEAM_WIDTH = 6;            // beam width per outcome
export const DEFAULT_BEAM_DEPTH = 3;            // max combo depth
export const VALIDATION_FRACTION = 0.3;         // last 30% of IS = validation slice
export const COMPLEXITY_LAMBDA = 0.02;          // per-condition score cost
export const SHRINKAGE_FRACTION = 0.2;          // N0 = max(10, baseline.total * this)
export const SHRINKAGE_FLOOR = 10;
export const CONTINUITY_BONUS = 0.05;           // per-patch bonus for matching prior winner
export const TRAJECTORY_LAMBDA = 0.05;          // per-candidate slope contribution
export const TRAJECTORY_LOOKBACK = 3;           // steps used for slope
export const TRUST_FLOOR = 0.3;                 // minimum trust scalar
export const STABILITY_FLOOR = 0.3;             // minimum stability multiplier
export const HISTORY_LOOKBACK = 5;              // recommended max prior steps in history

const EPS = 1e-9;

// Candidate spec shapes:
//   { kind: "categorical_individual",   column, minOccurrences }
//   { kind: "categorical_combinations", column, minOccurrences }
//   { kind: "range_gte",                column, max, increment, minOccurrences }
//   { kind: "range_lte",                column, max, increment, minOccurrences }
//   { kind: "daily_loss_limit",         max, minOccurrences }

// ── Domain ─────────────────────────────────────────────────────────
// IS rows that survive the fixed filters' applyFilters step. This is the
// ONLY pool used for distinct-value enumeration.
export function getOptimizerDomain(isRows, fixedFilters) {
  const groups = ((fixedFilters && fixedFilters.filterGroups) || []).filter(
    (g) => g.length > 0
  );
  return applyFilters(isRows, groups);
}

export function enumerateDistinctValues(domain, column) {
  const set = new Set();
  for (const row of domain) {
    const v = row[column];
    if (v == null || v === "") continue;
    set.add(String(v));
  }
  // Stable order: numeric ascending if all parse as numbers, else lexicographic.
  const arr = Array.from(set);
  const allNumeric = arr.every((v) => !isNaN(parseFloat(v)) && isFinite(v));
  if (allNumeric) arr.sort((a, b) => parseFloat(a) - parseFloat(b));
  else arr.sort();
  return arr;
}

// ── Candidate generation ──────────────────────────────────────────
export function generateCandidates(domain, specs) {
  const all = [];
  for (const spec of specs) {
    if (spec.kind === "categorical_individual") {
      const values = enumerateDistinctValues(domain, spec.column);
      for (const v of values) {
        all.push({
          label: `${spec.column} = ${v}`,
          kind: spec.kind,
          minOccurrences: spec.minOccurrences | 0,
          additionalGroups: [
            [{ column: spec.column, operator: "equals", value: v }],
          ],
        });
      }
    } else if (spec.kind === "categorical_combinations") {
      const values = enumerateDistinctValues(domain, spec.column);
      const n = values.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        const subset = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(values[i]);
        if (subset.length === n) continue;
        all.push({
          label: `${spec.column} ∈ {${subset.join(", ")}}`,
          kind: spec.kind,
          minOccurrences: spec.minOccurrences | 0,
          additionalGroups: subset.map((v) => [
            { column: spec.column, operator: "equals", value: v },
          ]),
        });
      }
    } else if (spec.kind === "range_gte" || spec.kind === "range_lte") {
      const max = Number(spec.max);
      const inc = Number(spec.increment);
      if (!(max > 0) || !(inc > 0)) continue;
      const op = spec.kind === "range_gte" ? "gte" : "lte";
      const sym = spec.kind === "range_gte" ? ">=" : "<=";
      const steps = Math.floor(max / inc + 1e-9);
      for (let i = 0; i <= steps; i++) {
        const v = i * inc;
        all.push({
          label: `${spec.column} ${sym} ${v}`,
          kind: spec.kind,
          minOccurrences: spec.minOccurrences | 0,
          additionalGroups: [
            [{ column: spec.column, operator: op, value: String(v) }],
          ],
        });
      }
    } else if (spec.kind === "daily_loss_limit") {
      const max = Number(spec.max);
      if (!(max >= 0)) continue;
      for (let v = 0; v <= max; v++) {
        all.push({
          label: `Daily Loss Limit = ${v}`,
          kind: spec.kind,
          minOccurrences: spec.minOccurrences | 0,
          dllValue: v,
        });
      }
    }
  }
  return all;
}

// ── Snapshot construction ──────────────────────────────────────────
export function buildFilterSnapshot(fixedFilters, patches, dateCol) {
  let dllPatch = null;
  const groupPatches = [];
  for (const p of patches) {
    if (p.kind === "daily_loss_limit") dllPatch = p;
    else groupPatches.push(p);
  }

  let groups = ((fixedFilters && fixedFilters.filterGroups) || []).filter(
    (g) => g.length > 0
  );
  if (groups.length === 0) groups = [[]];

  for (const p of groupPatches) {
    const next = [];
    for (const fg of groups) {
      for (const cg of p.additionalGroups) {
        next.push([...fg, ...cg]);
      }
    }
    groups = next;
  }

  const fixedDll = (fixedFilters && fixedFilters.dailyLossLimit) || {
    col: "",
    value: "",
    timeCol: "",
    sessionStart: "",
  };
  const dll = dllPatch
    ? {
        col: dateCol,
        value: String(dllPatch.dllValue),
        timeCol: "",
        sessionStart: "",
      }
    : fixedDll;

  const fixedOv = (fixedFilters && fixedFilters.overlap) || {
    enabled: false,
    mode: "always",
    compareCol: "",
    entryDateCol: "",
    entryTimeCol: "",
    lossTimeCol: "",
    exitMap: {},
  };

  return {
    filterGroups: groups,
    dailyLossLimit: dll,
    overlap: fixedOv,
  };
}

// ── Tiebreaker / complexity ────────────────────────────────────────
export function totalConditions(snapshot) {
  let n = 0;
  for (const g of snapshot.filterGroups || []) n += g.length;
  const dll = snapshot.dailyLossLimit;
  if (dll && parseInt(dll.value, 10) > 0) n += 1;
  return n;
}

// ── Percentile-rank (legacy export, used by tests) ─────────────────
function percentileRanks(values, direction) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (direction === "desc" ? b.v - a.v : a.v - b.v));
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(indexed[j + 1].v - indexed[i].v) < EPS) j++;
    const avgRank = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks.map((r) => (n - 1 - r) / (n - 1));
}

// Legacy 3-metric scorer (kept for backward compat / tests). The new
// optimizer uses computeFinalScores below.
export function scoreCandidates(metricsList, weights) {
  const n = metricsList.length;
  if (n === 0) return [];
  const rpts = metricsList.map((m) => m.avgReturn);
  const nets = metricsList.map((m) => m.netReturn);
  const dds = metricsList.map((m) => m.maxDD);
  const pRpt = percentileRanks(rpts, "desc");
  const pNet = percentileRanks(nets, "desc");
  const pDd = percentileRanks(dds, "asc");
  const wsum = weights.rpt + weights.net + weights.dd || 1;
  return rpts.map(
    (_, i) =>
      (weights.rpt * pRpt[i] + weights.net * pNet[i] + weights.dd * pDd[i]) /
      wsum
  );
}

// ── Pre-flight estimate ───────────────────────────────────────────
// Worst-case estimate for the setup-screen warning. With beam search the
// realized count is much smaller, but we keep the upper bound conservative.
export function estimateCandidateCount(domain, specs, topK) {
  let phase1 = 0;
  for (const spec of specs) {
    if (spec.kind === "categorical_individual") {
      phase1 += enumerateDistinctValues(domain, spec.column).length;
    } else if (spec.kind === "categorical_combinations") {
      const v = enumerateDistinctValues(domain, spec.column).length;
      phase1 += Math.max(0, (1 << v) - 2);
    } else if (spec.kind === "range_gte" || spec.kind === "range_lte") {
      const max = Number(spec.max);
      const inc = Number(spec.increment);
      if (max > 0 && inc > 0) phase1 += Math.floor(max / inc) + 1;
    } else if (spec.kind === "daily_loss_limit") {
      const max = Number(spec.max);
      if (max >= 0) phase1 += max + 1;
    }
  }
  // Beam: at each depth, beam_width members each extend by up to phase1
  // patches. Rough upper bound across (DEPTH-1) extension layers.
  const beam = Math.min(DEFAULT_BEAM_WIDTH, topK | 0 || DEFAULT_BEAM_WIDTH);
  const beamPhase2 = beam * phase1 * Math.max(0, DEFAULT_BEAM_DEPTH - 1);
  return { phase1, phase2: beamPhase2, total: phase1 + beamPhase2 + 1 };
}

// ── Walk-forward validation slice (Q3-A) ──────────────────────────
// Returns the rows from the LAST `fraction` of unique dates in isRows.
// Used to detect candidates whose performance falls apart on the most
// recent slice — a classic time-series overfitting symptom.
export function sliceISValidation(isRows, dateCol, fraction) {
  if (!dateCol || !isRows || isRows.length === 0) return [];
  const dates = new Set();
  for (const r of isRows) {
    const d = parseDateToISO(r[dateCol]);
    if (d) dates.add(d);
  }
  const sorted = Array.from(dates).sort();
  // Need a meaningful split — skip if too small.
  if (sorted.length < 5) return [];
  const splitIdx = Math.floor(sorted.length * (1 - fraction));
  if (splitIdx >= sorted.length) return [];
  const splitDate = sorted[splitIdx];
  return isRows.filter((r) => {
    const d = parseDateToISO(r[dateCol]);
    return d !== null && d >= splitDate;
  });
}

// Stability multiplier: 1.0 when the validation slice agrees with full IS
// or is better; falls toward STABILITY_FLOOR when val degrades. Guards
// against penalizing twice when full IS is already losing.
function stabilityMult(fullAvg, valAvg) {
  if (!isFinite(valAvg) || !isFinite(fullAvg)) return 1;
  if (fullAvg <= 0) return 1;
  if (valAvg >= fullAvg) return 1;
  if (valAvg <= 0) return STABILITY_FLOOR;
  return Math.max(STABILITY_FLOOR, valAvg / fullAvg);
}

// Slope of a per-patch metric trajectory across recent committed steps.
// `series` is newest-first. Returns roughly [-1, 1]: positive = improving,
// negative = degrading.
function trajectorySlope(series) {
  if (!series || series.length < 2) return 0;
  const recent = series.slice(0, TRAJECTORY_LOOKBACK);
  const newestAvg = Number(recent[0]?.avgReturn || 0);
  const oldestAvg = Number(recent[recent.length - 1]?.avgReturn || 0);
  const denom = Math.max(Math.abs(newestAvg), Math.abs(oldestAvg), 0.1);
  const change = newestAvg - oldestAvg;
  return Math.max(-1, Math.min(1, change / denom));
}

// Sanitize the history object — only fields the optimizer recognizes pass
// through. Extra fields are dropped. trust is clamped to [TRUST_FLOOR, 1].
//
// Reads OWN properties only (Object.hasOwn). This blocks prototype-chain
// injection and ensures a literal `{}` history really does mean "no
// history" regardless of how the object was constructed.
function normalizeHistory(history) {
  const h = history || {};
  const trustRaw = Object.hasOwn(h, "trust") ? h.trust : undefined;
  const trust =
    trustRaw != null && isFinite(trustRaw)
      ? Math.max(TRUST_FLOOR, Math.min(1, Number(trustRaw)))
      : 1.0;
  const priorWinners =
    Object.hasOwn(h, "priorWinners") && h.priorWinners && typeof h.priorWinners === "object"
      ? h.priorWinners
      : {};
  const priorPatchMetrics =
    Object.hasOwn(h, "priorPatchMetrics") &&
    h.priorPatchMetrics &&
    typeof h.priorPatchMetrics === "object"
      ? h.priorPatchMetrics
      : {};
  return { priorWinners, priorPatchMetrics, trust };
}

// ── Per-outcome final scoring (Phase 1 + 3 + 4 combined) ──────────
// pool[0] MUST be the baseline entry. Returns one score per pool entry.
//
// Score components (in order applied):
//   1. Composite percentile-rank of (shrunk RU/trade, NetRU, combined risk)
//   2. Stability multiplier from val slice (Q3-A)
//   3. Complexity cost (- LAMBDA × conditions)
//   4. Continuity bonus from prior winner (#6)
//   5. Trajectory adjustment from prior IS metrics (Q3-B)
//   6. Trust attenuation toward baseline (Q3-C)
//
// Combined risk = average percentile of (asc maxDD, desc Sortino, desc
// recovery factor). Replaces the previous maxDD-only term so the user's
// "dd" weight now controls a more complete risk picture.
function computeFinalScores(pool, history, oc, weights) {
  const n = pool.length;
  if (n === 0) return [];

  const baselineMetrics = pool[0].run.perOutcome[oc].metrics;
  const baselineN = Math.max(1, baselineMetrics.total);
  const baselineAvg = Number(baselineMetrics.avgReturn) || 0;

  const totals = pool.map((e) => e.run.perOutcome[oc].metrics.total);
  const rawAvgs = pool.map((e) => Number(e.run.perOutcome[oc].metrics.avgReturn) || 0);
  const nets = pool.map((e) => Number(e.run.perOutcome[oc].metrics.netReturn) || 0);
  const dds = pool.map((e) => Number(e.run.perOutcome[oc].metrics.maxDD) || 0);
  const sortinos = pool.map((e) => {
    const s = e.run.perOutcome[oc].metrics.sortino;
    return s == null || !isFinite(s) ? 0 : Number(s);
  });
  // Recovery factor: net return per unit of max drawdown.
  // When maxDD ≈ 0 and net > 0, treat as very good (large constant);
  // when both are 0, treat as 0.
  const recoveries = pool.map((e) => {
    const m = e.run.perOutcome[oc].metrics;
    if (m.maxDD > EPS) return m.netReturn / m.maxDD;
    return m.netReturn > 0 ? 1e6 : 0;
  });

  // Sample-size shrinkage on RU/trade (#2): pull small-N candidates'
  // averages toward the baseline mean so a 12-trade fluke can't dominate
  // a 200-trade signal.
  const N0 = Math.max(SHRINKAGE_FLOOR, baselineN * SHRINKAGE_FRACTION);
  const shrunkAvgs = rawAvgs.map(
    (a, i) => (totals[i] * a + N0 * baselineAvg) / (totals[i] + N0)
  );

  // Percentile ranks within this pool.
  const pAvg = percentileRanks(shrunkAvgs, "desc");
  const pNet = percentileRanks(nets, "desc");
  const pDd = percentileRanks(dds, "asc");
  const pSor = percentileRanks(sortinos, "desc");
  const pRec = percentileRanks(recoveries, "desc");
  const pRisk = pDd.map((v, i) => (v + pSor[i] + pRec[i]) / 3);

  // Weighted composite (#3).
  const wsum = weights.rpt + weights.net + weights.dd || 1;
  const composite = pool.map(
    (_, i) =>
      (weights.rpt * pAvg[i] + weights.net * pNet[i] + weights.dd * pRisk[i]) /
      wsum
  );

  // Stability multiplier from val slice (Q3-A). Falls back to 1 when
  // valRun is identical to run (small IS or no date column).
  const stab = pool.map((e) =>
    stabilityMult(
      e.run.perOutcome[oc].metrics.avgReturn,
      e.valRun.perOutcome[oc].metrics.avgReturn
    )
  );

  // Complexity cost (#4): per-condition deduction. Tiebreaker still
  // applies later for exact ties.
  const complexityCosts = pool.map((e) => totalConditions(e.snapshot));

  // Continuity bonus (#6): per-patch reward for matching the labels
  // present in the previous step's chosen winner.
  const priorWinnerLabels = (history.priorWinners && history.priorWinners[oc]) || [];
  const priorSet = new Set(priorWinnerLabels);
  const continuityBonuses = pool.map((e) => {
    let count = 0;
    for (const p of e.patches) if (priorSet.has(p.label)) count++;
    return count * CONTINUITY_BONUS;
  });

  // Trajectory adjustment (Q3-B): per-patch slope of recent IS metrics.
  const priorMetrics = (history.priorPatchMetrics && history.priorPatchMetrics[oc]) || {};
  const trajectoryAdjustments = pool.map((e) => {
    let sum = 0;
    let count = 0;
    for (const p of e.patches) {
      const series = priorMetrics[p.label];
      if (!series || series.length < 2) continue;
      sum += trajectorySlope(series);
      count++;
    }
    return count > 0 ? (sum / count) * TRAJECTORY_LAMBDA : 0;
  });

  const rawFinal = pool.map(
    (_, i) =>
      composite[i] * stab[i] -
      COMPLEXITY_LAMBDA * complexityCosts[i] +
      continuityBonuses[i] +
      trajectoryAdjustments[i]
  );

  // Trust attenuation toward baseline (Q3-C). Baseline keeps its raw
  // score; every other entry is pulled toward baseline by (1 - trust).
  const trust = history.trust;
  const baselineFinal = rawFinal[0];
  return rawFinal.map((s, i) =>
    i === 0 ? s : baselineFinal + trust * (s - baselineFinal)
  );
}

// Sort+slice helper: returns top-K entries by score (descending).
function topKEntries(entries, scores, k) {
  const indexed = entries.map((e, i) => ({ e, s: scores[i] }));
  indexed.sort((a, b) => b.s - a.s);
  return indexed.slice(0, Math.max(0, k)).map((x) => x.e);
}

// Stable signature for a patch list — order-independent, dedupe-safe.
function patchSig(patches) {
  return patches
    .map((p) => p.label)
    .slice()
    .sort()
    .join(" ∧ ");
}

// ── The optimizer ──────────────────────────────────────────────────
// Returns one winner per outcome, plus phase1Metrics (per-patch IS
// metrics keyed by label) so the caller can persist them for use as
// `history.priorPatchMetrics` on future steps.
//
// Output:
//   {
//     perOutcome: {
//       [outcome]: {
//         filters, metrics, returnSeries, rowCount, score, candidatesUsed
//       }
//     },
//     domainSize,
//     candidatesEvaluated,
//     phase1Metrics,           // { [label]: { [oc]: { avgReturn, total } } }
//   }
export function runOptimizer(
  isRows,
  fixedFilters,
  candidateSpecs,
  weights,
  topK,
  config,
  history = {}
) {
  const { outcomeCols, dateCol } = config;
  const safeHistory = normalizeHistory(history);
  const beamWidth = Math.max(2, Math.min(topK | 0 || DEFAULT_BEAM_WIDTH, DEFAULT_BEAM_WIDTH * 2));
  const beamDepth = DEFAULT_BEAM_DEPTH;

  const domain = getOptimizerDomain(isRows, fixedFilters);

  // Walk-forward validation slice (Q3-A). Falls back to full IS when too
  // small to be meaningful; in that case stability multipliers are all 1.
  const valRows = sliceISValidation(isRows, dateCol, VALIDATION_FRACTION);
  const useVal = valRows.length > 0;

  // Phase 0: baseline (fixed filters only).
  const baselineSnapshot = buildFilterSnapshot(fixedFilters, [], dateCol);
  const baselineRun = runPipeline(isRows, baselineSnapshot, config);
  const baselineValRun = useVal ? runPipeline(valRows, baselineSnapshot, config) : baselineRun;
  let evaluated = 1;

  const baselineEntry = {
    patches: [],
    snapshot: baselineSnapshot,
    run: baselineRun,
    valRun: baselineValRun,
    sig: "",
  };

  // Phase 1: every singleton patch. Cached by signature so beam-extension
  // can reuse them at depth 2+.
  const patches = generateCandidates(domain, candidateSpecs);
  const cache = new Map(); // sig → entry
  const phase1Entries = [];
  for (const patch of patches) {
    const sig = patchSig([patch]);
    if (cache.has(sig)) {
      phase1Entries.push(cache.get(sig));
      continue;
    }
    const snap = buildFilterSnapshot(fixedFilters, [patch], dateCol);
    const run = runPipeline(isRows, snap, config);
    const valRun = useVal ? runPipeline(valRows, snap, config) : run;
    const entry = { patches: [patch], snapshot: snap, run, valRun, sig };
    cache.set(sig, entry);
    phase1Entries.push(entry);
    evaluated++;
  }

  // Capture per-patch IS metrics now (used for storage; downstream
  // procedure mode persists this so future steps can read trajectory).
  const phase1Metrics = {};
  for (const e of phase1Entries) {
    const label = e.patches[0].label;
    phase1Metrics[label] = {};
    for (const oc of outcomeCols) {
      const m = e.run.perOutcome[oc].metrics;
      phase1Metrics[label][oc] = {
        avgReturn: m.avgReturn,
        total: m.total,
      };
    }
  }

  const perOutcome = {};

  for (const oc of outcomeCols) {
    // Phase-1 minOcc gate per outcome.
    const validPhase1 = phase1Entries.filter(
      (e) => e.run.perOutcome[oc].metrics.total >= (e.patches[0].minOccurrences || 0)
    );

    // Seed pool: baseline + valid singletons. Score together (so
    // percentile ranks span the same field) and pick the beam.
    let evaluatedThisOutcome = [...validPhase1];
    let pool = [baselineEntry, ...validPhase1];
    let scores = computeFinalScores(pool, safeHistory, oc, weights);
    const baselineSeedScore = scores[0];

    // Beam = top-B singletons whose score >= baseline (so we never extend
    // strictly-worse-than-baseline starts).
    const eligibleSeeds = [];
    for (let i = 1; i < pool.length; i++) {
      if (scores[i] >= baselineSeedScore - EPS) {
        eligibleSeeds.push({ entry: pool[i], score: scores[i] });
      }
    }
    eligibleSeeds.sort((a, b) => b.score - a.score);
    let beam = eligibleSeeds.slice(0, beamWidth).map((x) => x.entry);

    // Beam-search depths 2..D. At each depth, extend each beam member
    // by every patch (subject to dedupe + DLL exclusivity), score the
    // new entries against the running pool, and keep top-B as the
    // next beam.
    for (let depth = 2; depth <= beamDepth; depth++) {
      if (beam.length === 0) break;
      const seenAtDepth = new Set();
      const newEntries = [];

      for (const member of beam) {
        const memberLabels = new Set(member.patches.map((p) => p.label));
        const memberHasDLL = member.patches.some((p) => p.kind === "daily_loss_limit");

        for (const patch of patches) {
          if (memberLabels.has(patch.label)) continue;
          if (patch.kind === "daily_loss_limit" && memberHasDLL) continue;
          const newPatches = [...member.patches, patch];
          const sig = patchSig(newPatches);
          if (seenAtDepth.has(sig)) continue;
          seenAtDepth.add(sig);

          let entry = cache.get(sig);
          if (!entry) {
            const snap = buildFilterSnapshot(fixedFilters, newPatches, dateCol);
            const run = runPipeline(isRows, snap, config);
            const valRun = useVal ? runPipeline(valRows, snap, config) : run;
            entry = { patches: newPatches, snapshot: snap, run, valRun, sig };
            cache.set(sig, entry);
            evaluated++;
          }
          // minOcc gate: combination requires the strictest member's threshold.
          const minOcc = newPatches.reduce(
            (m, p) => Math.max(m, p.minOccurrences || 0),
            0
          );
          if (entry.run.perOutcome[oc].metrics.total < minOcc) continue;
          newEntries.push(entry);
        }
      }

      if (newEntries.length === 0) break;

      // Score the expanded pool together so percentile ranks are
      // consistent with what'll be used for final winner selection.
      const expandedPool = [baselineEntry, ...evaluatedThisOutcome, ...newEntries];
      const expandedScores = computeFinalScores(expandedPool, safeHistory, oc, weights);
      const newStart = 1 + evaluatedThisOutcome.length;
      const newScores = newEntries.map((_, i) => expandedScores[newStart + i]);
      beam = topKEntries(newEntries, newScores, beamWidth);
      evaluatedThisOutcome.push(...newEntries);
    }

    // Final pool: baseline + everything evaluated for this outcome.
    pool = [baselineEntry, ...evaluatedThisOutcome];
    scores = computeFinalScores(pool, safeHistory, oc, weights);
    const conditionCounts = pool.map((e) => totalConditions(e.snapshot));
    const baselineFinalScore = scores[0];

    // Pick winner: must score >= baseline (so doing-nothing-extra is the
    // fallback). Highest score wins; tie → fewer conditions wins.
    let bestIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      if (scores[i] < baselineFinalScore - EPS) continue;
      const sBest = scores[bestIdx];
      const sCand = scores[i];
      if (sCand > sBest + EPS) {
        bestIdx = i;
      } else if (Math.abs(sCand - sBest) <= EPS) {
        if (conditionCounts[i] < conditionCounts[bestIdx]) bestIdx = i;
      }
    }

    const winner = pool[bestIdx];
    perOutcome[oc] = {
      filters: winner.snapshot,
      metrics: winner.run.perOutcome[oc].metrics,
      returnSeries: winner.run.perOutcome[oc].returnSeries,
      rowCount: winner.run.perOutcome[oc].rowCount,
      score: scores[bestIdx],
      candidatesUsed: winner.patches.map((p) => p.label),
    };
  }

  return {
    perOutcome,
    domainSize: domain.length,
    candidatesEvaluated: evaluated,
    phase1Metrics,
  };
}

// ── OOS scoring ───────────────────────────────────────────────────
// Replay each per-outcome winner's locked filters on a fresh row set
// (typically OOS rows). Returns the same shape as runOptimizer's
// perOutcome but with metrics computed against the new rows.
export function runOptimizerWinnersOnRows(perOutcomeWinners, rows, config) {
  const out = {};
  for (const oc of config.outcomeCols) {
    const w = perOutcomeWinners[oc];
    if (!w) continue;
    const run = runPipeline(rows, w.filters, config);
    out[oc] = {
      filters: w.filters,
      metrics: run.perOutcome[oc].metrics,
      returnSeries: run.perOutcome[oc].returnSeries,
      rowCount: run.perOutcome[oc].rowCount,
      candidatesUsed: w.candidatesUsed,
    };
  }
  return out;
}

// ── History builders (helper functions for ProcedureMode) ─────────
// These are PURE functions that take frozen committed-step data and
// produce the `history` payload runOptimizer expects. Centralized here
// so the OOS firewall is enforced in one place: any field that doesn't
// fit into the documented history shape will be dropped by the consumer.

// Build priorWinners from the most recent committed optimizer step.
// Returns: { [outcomeCol]: [patchLabel, ...] }
export function buildPriorWinners(priorStepResult, outcomeCols) {
  const out = {};
  if (!priorStepResult || !priorStepResult.perOutcome) return out;
  for (const oc of outcomeCols) {
    const w = priorStepResult.perOutcome[oc];
    out[oc] = (w && Array.isArray(w.candidatesUsed)) ? w.candidatesUsed.slice() : [];
  }
  return out;
}

// Build priorPatchMetrics from up to HISTORY_LOOKBACK most recent
// committed steps' phase1Metrics. Newest first, oldest last.
// Returns: { [outcomeCol]: { [patchLabel]: [{avgReturn, total}, ...] } }
export function buildPriorPatchMetrics(priorPhase1MetricsList, outcomeCols) {
  const out = {};
  for (const oc of outcomeCols) out[oc] = {};
  if (!priorPhase1MetricsList || priorPhase1MetricsList.length === 0) return out;

  // priorPhase1MetricsList is ALREADY newest-first per caller convention.
  const recent = priorPhase1MetricsList.slice(0, HISTORY_LOOKBACK);
  for (const stepMetrics of recent) {
    if (!stepMetrics) continue;
    for (const label of Object.keys(stepMetrics)) {
      const perOutcome = stepMetrics[label];
      if (!perOutcome) continue;
      for (const oc of outcomeCols) {
        const m = perOutcome[oc];
        if (!m) continue;
        if (!out[oc][label]) out[oc][label] = [];
        out[oc][label].push({
          avgReturn: Number(m.avgReturn) || 0,
          total: Number(m.total) || 0,
        });
      }
    }
  }
  return out;
}

// Build trust scalar from prior committed steps' (IS, OOS) gaps.
// `priorOptimizerResults` is an array (newest first) of past optimizer
// step results, each containing perOutcome[oc].{isMetrics, oosMetrics}.
//
// trust = clamp([TRUST_FLOOR, 1.0]) of (1 - normalized_optimism), where
// normalized_optimism is the average of (isAvg - oosAvg) / max(|isAvg|, eps)
// across the last HISTORY_LOOKBACK steps and all outcomes that have BOTH
// IS and OOS metrics. Positive optimism (IS predicted better than OOS
// realized) reduces trust; negative optimism (OOS beat IS) leaves trust
// at 1.
export function buildTrustScalar(priorOptimizerResults) {
  if (!priorOptimizerResults || priorOptimizerResults.length === 0) return 1.0;
  const recent = priorOptimizerResults.slice(0, HISTORY_LOOKBACK);
  let sum = 0;
  let count = 0;
  for (const step of recent) {
    if (!step || !step.perOutcome) continue;
    for (const oc of Object.keys(step.perOutcome)) {
      const w = step.perOutcome[oc];
      if (!w) continue;
      const isAvg = w.isMetrics ? Number(w.isMetrics.avgReturn) : null;
      const oosAvg = w.oosMetrics ? Number(w.oosMetrics.avgReturn) : null;
      const oosTotal = w.oosMetrics ? Number(w.oosMetrics.total) : 0;
      if (isAvg == null || oosAvg == null || !isFinite(isAvg) || !isFinite(oosAvg)) continue;
      // Skip outcomes whose OOS sample is too thin to give a meaningful gap.
      if (oosTotal < 5) continue;
      const denom = Math.max(Math.abs(isAvg), 0.1);
      sum += (isAvg - oosAvg) / denom;
      count++;
    }
  }
  if (count === 0) return 1.0;
  const optimism = Math.max(0, sum / count);
  // 0 optimism → trust 1.0; optimism of 1 → trust 0.0 (clamped to floor).
  const trust = Math.max(TRUST_FLOOR, Math.min(1.0, 1.0 - optimism));
  return trust;
}
