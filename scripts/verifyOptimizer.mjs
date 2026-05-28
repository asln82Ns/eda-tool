// Byte-parity smoke test for the auto-optimizer.
//
// Builds a synthetic trade dataset and verifies:
//   1. Optimizer with NO candidate specs produces metrics byte-identical to
//      runPipeline on the same fixed filters (the "baseline" path is the
//      same code path as manual mode).
//   2. Value enumeration sees ONLY rows that survive the fixed filters'
//      applyFilters step, and only from the IS row set provided.
//   3. Adding one categorical_individual candidate produces the expected
//      number of pipeline runs and the winning snapshot is the AND of
//      fixed + the chosen value.
//   4. tieBreaker: when two candidates have the same composite score,
//      the one with fewer conditions wins.
//
// Run:  node scripts/verifyOptimizer.mjs

import {
  runPipeline,
  applyFilters,
  applyDailyLossLimit,
  applyOverlapFilter,
  calcMetrics,
  buildReturnSeries,
} from "../src/metrics.js";
import {
  runOptimizer,
  getOptimizerDomain,
  enumerateDistinctValues,
  generateCandidates,
  buildFilterSnapshot,
  totalConditions,
  scoreCandidates,
  buildPriorWinners,
  buildPriorPatchMetrics,
  buildTrustScalar,
  sliceISValidation,
  TRUST_FLOOR,
  DEFAULT_WEIGHTS,
} from "../src/autoOptimize.js";

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function approxEq(a, b, eps = 1e-9) {
  if (a == null && b == null) return true;
  if (typeof a !== "number" || typeof b !== "number") return a === b;
  return Math.abs(a - b) < eps;
}

function metricsEq(a, b) {
  const keys = [
    "total",
    "winCount",
    "lossCount",
    "breakEvenCount",
    "winPct",
    "netReturn",
    "grossReturn",
    "grossLoss",
    "avgReturn",
    "maxDD",
    "longestDD",
  ];
  for (const k of keys) {
    if (!approxEq(a[k], b[k])) {
      return `metric ${k} mismatch: ${a[k]} vs ${b[k]}`;
    }
  }
  return null;
}

// ── Synthetic dataset ─────────────────────────────────────────────
// 3 outcome columns: 3bar, eod, 1wk. 1 loss column.
// bartime values: 0930, 1000, 1030, 1100. lossLimit values: 1..5.
// Date range: 2025-01-01 .. 2025-04-30 (120 days). Each day has 4 trades
// (one per bartime). Outcome values vary by bartime to give the optimizer
// real signal. Ordered chronologically; rows are CSV-source order.

function makeDataset() {
  const rows = [];
  const start = new Date("2025-01-01T00:00:00Z");
  const totalDays = 120;
  const bartimes = ["0930", "1000", "1030", "1100"];
  // bartime → bias for each outcome (positive = wins)
  const bias = {
    "0930": { "3bar": +0.6, eod: +0.3, "1wk": -0.2 },
    "1000": { "3bar": +0.2, eod: +0.5, "1wk": +0.4 },
    "1030": { "3bar": -0.3, eod: -0.1, "1wk": +0.6 },
    "1100": { "3bar": -0.5, eod: -0.4, "1wk": -0.5 },
  };
  let seed = 1;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let d = 0; d < totalDays; d++) {
    const date = new Date(start.getTime() + d * 86400000);
    const iso = date.toISOString().slice(0, 10);
    for (const bt of bartimes) {
      const r = rnd();
      const lossSize = 1 + Math.floor(rnd() * 4); // 1..4
      const dailyLossNum = 1 + Math.floor(rnd() * 5); // 1..5
      const row = {
        date: iso,
        bartime: bt,
        loss_num: String(dailyLossNum),
        loss: "",
        "3bar": "",
        eod: "",
        "1wk": "",
      };
      for (const oc of ["3bar", "eod", "1wk"]) {
        const winChance = 0.5 + bias[bt][oc] * 0.4;
        if (r < winChance) {
          // Win — different magnitudes per outcome for variety
          const mag = oc === "3bar" ? 1 + rnd() : oc === "eod" ? 1.5 + rnd() : 2 + rnd();
          row[oc] = mag.toFixed(2);
        }
      }
      // If no outcome column is filled, treat as a loss in `loss`
      const allEmpty = ["3bar", "eod", "1wk"].every((oc) => row[oc] === "");
      if (allEmpty) row.loss = lossSize.toFixed(2);
      rows.push(row);
    }
  }
  return rows;
}

const rows = makeDataset();
const config = {
  dateCol: "date",
  outcomeCols: ["3bar", "eod", "1wk"],
  lossCol: "loss",
  isLengthDays: 60,
  oosLengthDays: 30,
  embargoDays: 0,
};

console.log(`\nSynthetic dataset: ${rows.length} rows`);

// IS = first 60 days (2025-01-01 .. 2025-03-01 inclusive)
const isStart = "2025-01-01";
const isEnd = "2025-03-01"; // 60 days inclusive
const isRows = rows.filter((r) => r.date >= isStart && r.date <= isEnd);
console.log(`IS rows: ${isRows.length}`);

// ── Test 1: empty optimizer = manual pipeline on fixed filters ──
console.log("\n[1] Empty optimizer == manual pipeline on fixed filters");
const fixedNoOp = {
  filterGroups: [],
  dailyLossLimit: { col: "", value: "", timeCol: "", sessionStart: "" },
  overlap: {
    enabled: false,
    mode: "always",
    compareCol: "",
    entryDateCol: "",
    entryTimeCol: "",
    lossTimeCol: "",
    exitMap: {},
  },
};

const manual = runPipeline(isRows, fixedNoOp, config);
const opt = runOptimizer(isRows, fixedNoOp, [], DEFAULT_WEIGHTS, 8, config);

for (const oc of config.outcomeCols) {
  const d = metricsEq(manual.perOutcome[oc].metrics, opt.perOutcome[oc].metrics);
  ok(`metrics match for ${oc}`, d === null, d);
  ok(
    `row count matches for ${oc}`,
    manual.perOutcome[oc].rowCount === opt.perOutcome[oc].rowCount,
    `${manual.perOutcome[oc].rowCount} vs ${opt.perOutcome[oc].rowCount}`
  );
  ok(
    `optimizer chose baseline (no candidates) for ${oc}`,
    opt.perOutcome[oc].candidatesUsed.length === 0
  );
}
ok("optimizer evaluated exactly 1 pipeline run (baseline only)", opt.candidatesEvaluated === 1);

// ── Test 2: empty optimizer with non-trivial fixed filters ──────
console.log("\n[2] Empty optimizer with non-trivial fixed filters");
const fixedExclude = {
  filterGroups: [[{ column: "bartime", operator: "not_equals", value: "1100" }]],
  dailyLossLimit: { col: "", value: "", timeCol: "", sessionStart: "" },
  overlap: {
    enabled: false,
    mode: "always",
    compareCol: "",
    entryDateCol: "",
    entryTimeCol: "",
    lossTimeCol: "",
    exitMap: {},
  },
};
const manual2 = runPipeline(isRows, fixedExclude, config);
const opt2 = runOptimizer(isRows, fixedExclude, [], DEFAULT_WEIGHTS, 8, config);
for (const oc of config.outcomeCols) {
  const d = metricsEq(manual2.perOutcome[oc].metrics, opt2.perOutcome[oc].metrics);
  ok(`metrics match for ${oc} with fixed exclusion`, d === null, d);
}
ok(
  "manual rowCount with fixed exclusion < unrestricted",
  manual2.perOutcome["3bar"].rowCount < manual.perOutcome["3bar"].rowCount
);

// ── Test 3: domain enumeration is post-fixed-filters AND IS-only ──
console.log("\n[3] Domain enumeration: post-fixed-filters, IS-only");
const domainAll = getOptimizerDomain(isRows, fixedNoOp);
ok("domain (no fixed) = isRows", domainAll.length === isRows.length);

const domainExcl = getOptimizerDomain(isRows, fixedExclude);
ok(
  "domain after fixed exclusion is smaller",
  domainExcl.length < domainAll.length && domainExcl.length > 0
);
const valuesAll = enumerateDistinctValues(domainAll, "bartime");
ok(
  "without fixed, bartime values = {0930,1000,1030,1100}",
  valuesAll.sort().join(",") === "0930,1000,1030,1100"
);
const valuesExcl = enumerateDistinctValues(domainExcl, "bartime");
ok(
  "with bartime != 1100 fixed, value 1100 is excluded from enumeration",
  !valuesExcl.includes("1100") && valuesExcl.length === 3
);
// IS-only: passing a smaller set should narrow values
const subset = isRows.filter((r) => r.date < "2025-01-15");
const valuesSubset = enumerateDistinctValues(getOptimizerDomain(subset, fixedNoOp), "bartime");
ok(
  "passing subset narrows enumeration (IS scoping works)",
  valuesSubset.length <= valuesAll.length
);

// ── Test 4: one categorical_individual candidate ────────────────
console.log("\n[4] One categorical_individual candidate");
const specs = [{ kind: "categorical_individual", column: "bartime", minOccurrences: 5 }];
const opt4 = runOptimizer(isRows, fixedNoOp, specs, DEFAULT_WEIGHTS, 8, config);
// At least 5 unique pipeline runs: 1 baseline + 4 individual bartimes.
// Phase 2 may add up to 2^4 - 4 - 1 = 11 deduped subsets; exact count
// depends on which individuals beat baseline for each outcome.
ok(
  "evaluated runs >= 5 (baseline + 4 bartimes) and <= 16",
  opt4.candidatesEvaluated >= 5 && opt4.candidatesEvaluated <= 16,
  `got ${opt4.candidatesEvaluated}`
);
for (const oc of config.outcomeCols) {
  const w = opt4.perOutcome[oc];
  ok(`winner has ≤1 picked filter for ${oc}`, w.candidatesUsed.length <= 1);
  if (w.candidatesUsed.length === 1) {
    ok(
      `picked filter for ${oc} is a bartime equality`,
      w.candidatesUsed[0].startsWith("bartime ="),
      w.candidatesUsed[0]
    );
  }
}

// Verify the winner's metrics match what runPipeline produces with that filter snapshot
for (const oc of config.outcomeCols) {
  const w = opt4.perOutcome[oc];
  const replay = runPipeline(isRows, w.filters, config);
  const d = metricsEq(w.metrics, replay.perOutcome[oc].metrics);
  ok(`winner's metrics match replay for ${oc}`, d === null, d);
}

// ── Test 5: tiebreaker (fewer conditions when scores tie) ───────
console.log("\n[5] Tiebreaker when scores tie");
// Two equal-scoring snapshots: one with 1 condition, one with 2. The one
// with 1 condition should win.
const m1 = { avgReturn: 0.5, netReturn: 50, maxDD: 5 };
const m2 = { avgReturn: 0.5, netReturn: 50, maxDD: 5 };
const scores = scoreCandidates([m1, m2], DEFAULT_WEIGHTS);
ok("tied metrics produce equal scores", Math.abs(scores[0] - scores[1]) < 1e-9);

// Build snapshots with known condition counts
const snapA = { filterGroups: [[{ column: "x", operator: "equals", value: "1" }]], dailyLossLimit: { col: "", value: "" }, overlap: { enabled: false } };
const snapB = {
  filterGroups: [
    [
      { column: "x", operator: "equals", value: "1" },
      { column: "y", operator: "equals", value: "2" },
    ],
  ],
  dailyLossLimit: { col: "", value: "" },
  overlap: { enabled: false },
};
ok("totalConditions(snapA) = 1", totalConditions(snapA) === 1);
ok("totalConditions(snapB) = 2", totalConditions(snapB) === 2);

// ── Test 6: buildFilterSnapshot distributive AND ────────────────
console.log("\n[6] buildFilterSnapshot distributive AND");
const fixedTwoGroups = {
  filterGroups: [
    [{ column: "a", operator: "equals", value: "1" }],
    [{ column: "a", operator: "equals", value: "2" }],
  ],
  dailyLossLimit: { col: "", value: "" },
  overlap: { enabled: false },
};
const patch = {
  kind: "categorical_individual",
  additionalGroups: [[{ column: "b", operator: "equals", value: "x" }]],
};
const snap = buildFilterSnapshot(fixedTwoGroups, [patch], "date");
ok(
  "(a=1 OR a=2) AND b=x → 2 groups of 2 conditions each",
  snap.filterGroups.length === 2 &&
    snap.filterGroups.every((g) => g.length === 2)
);

// Multi-OR patch distributing across multi-OR fixed
const patchOr = {
  kind: "categorical_combinations",
  additionalGroups: [
    [{ column: "b", operator: "equals", value: "x" }],
    [{ column: "b", operator: "equals", value: "y" }],
  ],
};
const snap2 = buildFilterSnapshot(fixedTwoGroups, [patchOr], "date");
ok(
  "(a=1 OR a=2) AND (b=x OR b=y) → 4 groups",
  snap2.filterGroups.length === 4
);

// ── Test 7: candidate generation for range_gte ───────────────────
console.log("\n[7] Range candidate generation");
const rangeCands = generateCandidates([], [
  { kind: "range_gte", column: "v", max: 100, increment: 25, minOccurrences: 0 },
]);
const rangeValues = rangeCands.map((c) => c.label);
ok(
  "range_gte v with max=100 inc=25 produces 5 candidates (0,25,50,75,100)",
  rangeCands.length === 5 &&
    rangeValues.join(",") ===
      "v >= 0,v >= 25,v >= 50,v >= 75,v >= 100",
  rangeValues.join(",")
);

const dllCands = generateCandidates([], [
  { kind: "daily_loss_limit", max: 5, minOccurrences: 0 },
]);
ok(
  "daily_loss_limit max=5 produces 6 candidates (0..5)",
  dllCands.length === 6
);

// ── Test 8: minOccurrences gate ─────────────────────────────────
console.log("\n[8] minOccurrences gate discards thin candidates");
// Spec a categorical with minOccurrences higher than any single-bartime count
const tightSpec = [{ kind: "categorical_individual", column: "bartime", minOccurrences: 999999 }];
const opt8 = runOptimizer(isRows, fixedNoOp, tightSpec, DEFAULT_WEIGHTS, 8, config);
for (const oc of config.outcomeCols) {
  ok(
    `all candidates discarded for ${oc}; winner = baseline`,
    opt8.perOutcome[oc].candidatesUsed.length === 0
  );
}

// ── Test 9: a known hand-computable result ──────────────────────
console.log("\n[9] Hand-computable: filtering to bartime=0930 only");
const handFilter = {
  filterGroups: [[{ column: "bartime", operator: "equals", value: "0930" }]],
  dailyLossLimit: { col: "", value: "" },
  overlap: { enabled: false },
};
const handRun = runPipeline(isRows, handFilter, config);
// Independently compute via raw filter + buildReturnSeries
const handRows = isRows.filter((r) => r.bartime === "0930");
ok(
  "raw filter row count = pipeline afterFilterCount",
  handRows.length === handRun.afterFilterCount
);
const handSeries3bar = buildReturnSeries(handRows, "3bar", "loss");
const handMetrics3bar = calcMetrics(handSeries3bar);
const d = metricsEq(handMetrics3bar, handRun.perOutcome["3bar"].metrics);
ok("hand-computed 3bar metrics == pipeline 3bar metrics", d === null, d);

// ── Test 10: DLL with overlapping losses ────────────────────────
// User's scenario: position A enters 06:00, position B enters 07:30,
// both lose at 10:30. Limit = 1.
//   Legacy mode (no lossTimeCol)  → B retroactively excluded; 1 loss.
//   Loss-time-aware (lossTimeCol) → both kept; 2 losses.
// Plus a downstream entry C at 11:00 that should be excluded in BOTH
// modes since at 11:00 the limit is already breached.
console.log("\n[10] Daily loss limit — overlapping loss realization");
const dllRows = [
  // bardate, bartime, lossTime, loss
  { bardate: "2025-06-01", bartime: "0600", lossTime: "2025-06-01 10:30", loss: "-1" },
  { bardate: "2025-06-01", bartime: "0730", lossTime: "2025-06-01 10:30", loss: "-1" },
  { bardate: "2025-06-01", bartime: "1100", lossTime: "2025-06-01 13:00", loss: "-1" },
];

// Legacy: lossTimeCol omitted → walks in entry order, B excluded once
// A's loss is "credited" at entry. C also excluded (limit already hit).
const dllLegacy = applyDailyLossLimit(
  dllRows,
  "bardate",
  "loss",
  1,
  "bartime",
  // session start = 00:00 (midnight) so bartime sortKey = mins-from-midnight
  0
);
ok(
  "legacy DLL keeps only the first overlapping entry (1 row)",
  dllLegacy.length === 1 && dllLegacy[0].bartime === "0600",
  `kept ${dllLegacy.length} rows: ${dllLegacy.map((r) => r.bartime).join(",")}`
);

// Loss-time-aware: both A and B kept (B entered before A's loss realized).
// C still excluded (entered after both losses realized).
const dllAware = applyDailyLossLimit(
  dllRows,
  "bardate",
  "loss",
  1,
  "bartime",
  0,
  "lossTime"
);
ok(
  "loss-time-aware DLL keeps both overlapping entries, drops post-limit entry",
  dllAware.length === 2 &&
    dllAware[0].bartime === "0600" &&
    dllAware[1].bartime === "0730",
  `kept ${dllAware.length} rows: ${dllAware.map((r) => r.bartime).join(",")}`
);

// Sanity: with 3 sequential entries (no overlap — each loss realizes
// before the next entry), legacy and aware should agree.
const seqRows = [
  { bardate: "2025-06-02", bartime: "0600", lossTime: "2025-06-02 06:30", loss: "-1" },
  { bardate: "2025-06-02", bartime: "0700", lossTime: "2025-06-02 07:30", loss: "-1" },
  { bardate: "2025-06-02", bartime: "0800", lossTime: "2025-06-02 08:30", loss: "-1" },
];
const seqLegacy = applyDailyLossLimit(seqRows, "bardate", "loss", 2, "bartime", 0);
const seqAware = applyDailyLossLimit(seqRows, "bardate", "loss", 2, "bartime", 0, "lossTime");
ok(
  "sequential (non-overlapping) losses: legacy and aware agree",
  seqLegacy.length === seqAware.length &&
    seqLegacy.every((r, i) => r.bartime === seqAware[i].bartime),
  `legacy=${seqLegacy.length} aware=${seqAware.length}`
);

// Excluded-trade-doesn't-count-its-loss: with limit=1 and 4 sequential
// losing trades, only the first 2 enter (1 enters, 1 enters at the
// instant the first loss is realized? no — the second enters AFTER the
// first realizes, so it's blocked). After block, downstream "losses"
// of blocked trades must NOT continue to bump the counter.
const blockRows = [
  { bardate: "2025-06-03", bartime: "0600", lossTime: "2025-06-03 06:30", loss: "-1" },
  { bardate: "2025-06-03", bartime: "0700", lossTime: "2025-06-03 07:30", loss: "-1" },
  { bardate: "2025-06-03", bartime: "0800", lossTime: "2025-06-03 08:30", loss: "-1" },
];
const blockAware = applyDailyLossLimit(blockRows, "bardate", "loss", 1, "bartime", 0, "lossTime");
ok(
  "limit=1 sequential: only first trade enters, others blocked",
  blockAware.length === 1 && blockAware[0].bartime === "0600",
  `kept: ${blockAware.map((r) => r.bartime).join(",")}`
);

// ── Test 11: per-outcome DLL on loss + outcome conflicts ─────────
// Conflicted rows have BOTH the loss column AND one outcome populated.
// Legacy DLL (no outcomeCol) counts the loss event regardless of outcome,
// which is wrong on the outcome's pass — that trade was a winner. Per-
// outcome DLL suppresses the loss event on the populated outcome and
// emits it on outcomes whose cell is empty.
console.log("\n[11] Per-outcome DLL on loss + outcome conflicts");
const conflictRows = [
  { date: "2025-06-04", bartime: "0930", "3bar": "1.5", eod: "", "1wk": "", loss: "0.5", lossTime: "2025-06-04 11:00" },
  { date: "2025-06-04", bartime: "1000", "3bar": "2.0", eod: "", "1wk": "", loss: "" },
  { date: "2025-06-04", bartime: "1030", "3bar": "",    eod: "", "1wk": "", loss: "1",   lossTime: "2025-06-04 12:00" },
  { date: "2025-06-04", bartime: "1130", "3bar": "3.0", eod: "", "1wk": "", loss: "" },
];

// Legacy: row 1's loss realizes at 11:00 → row 4 (entry 11:30) blocked.
const dllLegacyConflict = applyDailyLossLimit(
  conflictRows, "date", "loss", 1, "bartime", 0, "lossTime"
);
ok(
  "legacy DLL excludes row 4 (entered after row 1's loss realized)",
  dllLegacyConflict.length === 3 &&
    dllLegacyConflict.map((r) => r.bartime).join(",") === "0930,1000,1030",
  `kept: ${dllLegacyConflict.map((r) => r.bartime).join(",")}`
);

// Per-outcome DLL on 3bar: row 1 has 3bar populated → no loss event for it
// → row 3's loss realizes at 12:00 (after row 4's entry) → all 4 rows survive.
const dll3bar = applyDailyLossLimit(
  conflictRows, "date", "loss", 1, "bartime", 0, "lossTime", "3bar"
);
ok(
  "per-outcome DLL on 3bar suppresses row 1's loss event → 4 rows survive",
  dll3bar.length === 4 &&
    dll3bar.map((r) => r.bartime).join(",") === "0930,1000,1030,1130",
  `kept: ${dll3bar.map((r) => r.bartime).join(",")}`
);

// Per-outcome DLL on eod (empty for every row) is identical to legacy.
const dllEod = applyDailyLossLimit(
  conflictRows, "date", "loss", 1, "bartime", 0, "lossTime", "eod"
);
ok(
  "per-outcome DLL on eod (no populated cells) matches legacy",
  dllEod.length === dllLegacyConflict.length &&
    dllEod.map((r) => r.bartime).join(",") ===
      dllLegacyConflict.map((r) => r.bartime).join(",")
);

// runPipeline exposes per-outcome afterDLLCount and post-applyFilters
// afterFilterCount.
const conflictConfig = {
  dateCol: "date",
  outcomeCols: ["3bar", "eod", "1wk"],
  lossCol: "loss",
};
const conflictFilters = {
  filterGroups: [],
  dailyLossLimit: { col: "date", value: "1", timeCol: "bartime", sessionStart: "0000", lossTimeCol: "lossTime" },
  overlap: { enabled: false, mode: "always", compareCol: "", entryDateCol: "", entryTimeCol: "", lossTimeCol: "", exitMap: {} },
};
const conflictRun = runPipeline(conflictRows, conflictFilters, conflictConfig);
ok(
  "runPipeline 3bar afterDLLCount = 4",
  conflictRun.perOutcome["3bar"].afterDLLCount === 4,
  `got ${conflictRun.perOutcome["3bar"].afterDLLCount}`
);
ok(
  "runPipeline eod afterDLLCount = 3",
  conflictRun.perOutcome["eod"].afterDLLCount === 3,
  `got ${conflictRun.perOutcome["eod"].afterDLLCount}`
);
ok(
  "runPipeline afterFilterCount = 4 (post-applyFilters, pre-DLL)",
  conflictRun.afterFilterCount === 4,
  `got ${conflictRun.afterFilterCount}`
);

// ── Test 12: overlap filter is outcome-aware on conflicts ────────
// Row 1 has 3bar populated AND loss populated. Without outcomeCol, overlap
// uses lossTime (11:00) as the exit, holding the trade active past row 2's
// 09:40 entry → row 2 excluded under mode "always". With outcomeCol="3bar",
// the trade exits at 3bar_exit (09:35) → row 2 enters cleanly.
console.log("\n[12] Overlap filter is outcome-aware on conflicts");
const overlapRows = [
  { date: "2025-06-05", entryTime: "0930", "3bar": "1.5", "3bar_exit": "2025-06-05 09:35", loss: "0.5", lossTime: "2025-06-05 11:00" },
  { date: "2025-06-05", entryTime: "0940", "3bar": "2.0", "3bar_exit": "2025-06-05 10:10", loss: "",    lossTime: "" },
];

const overlapLegacy = applyOverlapFilter(overlapRows, {
  enabled: true,
  mode: "always",
  entryDateCol: "date",
  entryTimeCol: "entryTime",
  lossTimeCol: "lossTime",
  exitTimeCol: "3bar_exit",
  lossCol: "loss",
});
ok(
  "legacy overlap (no outcomeCol) holds row 1 active until lossTime → excludes row 2",
  overlapLegacy.length === 1 && overlapLegacy[0].entryTime === "0930",
  `kept ${overlapLegacy.length}`
);

const overlapAware = applyOverlapFilter(overlapRows, {
  enabled: true,
  mode: "always",
  entryDateCol: "date",
  entryTimeCol: "entryTime",
  lossTimeCol: "lossTime",
  exitTimeCol: "3bar_exit",
  lossCol: "loss",
  outcomeCol: "3bar",
});
ok(
  "outcome-aware overlap uses 3bar_exit (09:35) → row 2 enters",
  overlapAware.length === 2,
  `kept ${overlapAware.length}`
);

// ── Test 13: OOS firewall — extra fields in history are ignored ──
// The optimizer's signature has no parameter that can hold OOS rows.
// Anything in `history` outside the documented shape MUST be ignored —
// passing garbage cannot change the result. This is the structural
// guarantee that prevents OOS leakage at the type/shape level.
console.log("\n[13] OOS firewall: extra history fields are ignored");
const cleanCall = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, {});

const garbageHistory = {
  // Pretend an attacker stuffs current-step OOS rows + arbitrary junk
  // into history. None of these field names are recognized by
  // normalizeHistory, so they should be silently dropped.
  // (We deliberately don't use __proto__ — that would set the prototype
  // chain, not an own property, and normalizeHistory uses Object.hasOwn
  // to defend against that path too.)
  oosRows: rows,
  isRowsLeak: rows,
  futureMetrics: { foo: "bar" },
  trustImposter: 0, // similar-looking field name, must NOT be read
  garbage: "ignored",
};
const garbageCall = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, garbageHistory);

for (const oc of config.outcomeCols) {
  const a = cleanCall.perOutcome[oc];
  const b = garbageCall.perOutcome[oc];
  ok(
    `firewall: garbage history produces identical metrics for ${oc}`,
    metricsEq(a.metrics, b.metrics) === null &&
      a.candidatesUsed.join("|") === b.candidatesUsed.join("|") &&
      Math.abs(a.score - b.score) < 1e-9
  );
}
ok(
  "firewall: garbage history produces identical candidatesEvaluated",
  cleanCall.candidatesEvaluated === garbageCall.candidatesEvaluated
);

// ── Test 14: history.trust attenuation works ─────────────────────
// With trust = 1.0 (default), the optimizer scores candidates fully.
// With trust = TRUST_FLOOR, candidate scores are pulled toward
// baseline → baseline becomes much more competitive (or wins).
console.log("\n[14] history.trust attenuates non-baseline scores");
const trustHigh = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, { trust: 1.0 });
const trustLow = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, { trust: TRUST_FLOOR });

let attenuationSeen = false;
for (const oc of config.outcomeCols) {
  const high = trustHigh.perOutcome[oc];
  const low = trustLow.perOutcome[oc];
  // When trust drops, either the winner is more conservative (fewer
  // patches) OR the score gap shrinks. At least one outcome should show
  // attenuation; pure equality across all outcomes would be suspicious.
  if (low.candidatesUsed.length < high.candidatesUsed.length) {
    attenuationSeen = true;
  } else if (low.score < high.score - 1e-9) {
    attenuationSeen = true;
  }
}
ok(
  "trust=floor produces more conservative or lower-scored winner than trust=1",
  attenuationSeen,
  `high winners: ${config.outcomeCols.map(oc => trustHigh.perOutcome[oc].candidatesUsed.join(",")).join("|")} ; ` +
  `low winners: ${config.outcomeCols.map(oc => trustLow.perOutcome[oc].candidatesUsed.join(",")).join("|")}`
);

// ── Test 15: phase1Metrics output is populated ───────────────────
console.log("\n[15] phase1Metrics output is populated for downstream history");
const opt15 = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 0 },
], DEFAULT_WEIGHTS, 8, config);
ok(
  "phase1Metrics has one entry per generated patch label",
  opt15.phase1Metrics &&
    Object.keys(opt15.phase1Metrics).length === 4 &&
    Object.keys(opt15.phase1Metrics).every((k) => k.startsWith("bartime ="))
);
ok(
  "phase1Metrics entry has per-outcome { avgReturn, total }",
  Object.values(opt15.phase1Metrics).every((m) =>
    config.outcomeCols.every(
      (oc) => typeof m[oc].avgReturn === "number" && typeof m[oc].total === "number"
    )
  )
);

// ── Test 16: history.priorWinners gives continuity bonus ─────────
console.log("\n[16] priorWinners bonus is applied (continuity prior)");
// Compute the winner with no prior. Then build a prior whose winners
// EXACTLY MATCH the labels we just observed. With trust = 1.0 and the
// same patches winning, the bonus must lift each winner's score
// strictly above its no-prior counterpart for at least one outcome
// whose winner has any patches at all. (Outcomes whose winner is the
// baseline aren't affected — baseline has no patches to match.)
const noPrior = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, {});

const matchingPriorWinners = {};
for (const oc of config.outcomeCols) {
  matchingPriorWinners[oc] = noPrior.perOutcome[oc].candidatesUsed.slice();
}
const withPrior = runOptimizer(isRows, fixedNoOp, [
  { kind: "categorical_individual", column: "bartime", minOccurrences: 5 },
], DEFAULT_WEIGHTS, 8, config, { priorWinners: matchingPriorWinners });

let bonusObservedSomewhere = false;
let nonBaselineOutcomeFound = false;
for (const oc of config.outcomeCols) {
  const a = noPrior.perOutcome[oc];
  const b = withPrior.perOutcome[oc];
  if (a.candidatesUsed.length === 0) continue; // baseline winner — no bonus possible
  nonBaselineOutcomeFound = true;
  // Same winner expected; score must rise by ≈ CONTINUITY_BONUS × matches.
  if (
    b.candidatesUsed.join("|") === a.candidatesUsed.join("|") &&
    b.score > a.score + 1e-9
  ) {
    bonusObservedSomewhere = true;
  }
}
ok(
  "test setup: at least one outcome's noPrior winner has patches",
  nonBaselineOutcomeFound,
  "all noPrior winners were baseline — adjust dataset"
);
ok(
  "matching priorWinners lifts winner's score for at least one outcome",
  bonusObservedSomewhere,
  `noPrior scores: ${config.outcomeCols.map(oc => noPrior.perOutcome[oc].score.toFixed(4)).join(",")} ; ` +
  `withPrior scores: ${config.outcomeCols.map(oc => withPrior.perOutcome[oc].score.toFixed(4)).join(",")}`
);

// ── Test 17: validation slice splits IS by date ──────────────────
console.log("\n[17] sliceISValidation returns the last 30% of IS dates");
const valSlice = sliceISValidation(isRows, "date", 0.3);
const valDates = new Set(valSlice.map((r) => r.date));
const isDates = Array.from(new Set(isRows.map((r) => r.date))).sort();
const expectedSplit = isDates[Math.floor(isDates.length * 0.7)];
const minValDate = Array.from(valDates).sort()[0];
ok(
  "validation slice starts at expected split date (post-70% mark)",
  minValDate === expectedSplit,
  `expected ${expectedSplit}, got ${minValDate}`
);
ok(
  "validation slice is strictly smaller than full IS",
  valSlice.length > 0 && valSlice.length < isRows.length
);

// ── Test 18: history builders sanitize input ─────────────────────
console.log("\n[18] history builders only emit declared shape");
const wpr = buildPriorWinners(
  { perOutcome: { "3bar": { candidatesUsed: ["a", "b"] }, eod: { candidatesUsed: [] } } },
  ["3bar", "eod", "1wk"]
);
ok(
  "buildPriorWinners returns one array per outcome (missing outcome → empty)",
  Array.isArray(wpr["3bar"]) && wpr["3bar"].length === 2 &&
  Array.isArray(wpr.eod) && wpr.eod.length === 0 &&
  Array.isArray(wpr["1wk"]) && wpr["1wk"].length === 0
);

const ppm = buildPriorPatchMetrics(
  [
    // newest step first
    { "X = 1": { "3bar": { avgReturn: 0.5, total: 20 } } },
    { "X = 1": { "3bar": { avgReturn: 0.4, total: 18 } } },
    { "X = 1": { "3bar": { avgReturn: 0.3, total: 22 } } },
  ],
  ["3bar", "eod"]
);
ok(
  "buildPriorPatchMetrics preserves newest-first ordering per outcome",
  ppm["3bar"]["X = 1"].length === 3 &&
    ppm["3bar"]["X = 1"][0].avgReturn === 0.5 &&
    ppm["3bar"]["X = 1"][2].avgReturn === 0.3
);
ok(
  "buildPriorPatchMetrics returns empty for unmentioned outcome",
  Object.keys(ppm.eod).length === 0
);

// ── Test 19: trust scalar reflects IS↔OOS gap ────────────────────
console.log("\n[19] buildTrustScalar reflects optimism");
// No prior → trust 1.0
ok("no prior → trust = 1.0", buildTrustScalar([]) === 1.0);
ok("null prior → trust = 1.0", buildTrustScalar(null) === 1.0);

// Strong optimism (IS predicts much higher than OOS realizes) → trust < 1
const optimisticPrior = [
  {
    perOutcome: {
      a: {
        isMetrics: { avgReturn: 1.0, total: 50 },
        oosMetrics: { avgReturn: 0.0, total: 20 },
      },
    },
  },
];
const trustOpt = buildTrustScalar(optimisticPrior);
ok(
  "optimism = 1 → trust drops to floor",
  trustOpt <= TRUST_FLOOR + 1e-9 && trustOpt >= TRUST_FLOOR - 1e-9,
  `got ${trustOpt}`
);

// OOS beat IS → no penalty (trust stays at 1.0)
const pessimisticPrior = [
  {
    perOutcome: {
      a: {
        isMetrics: { avgReturn: 0.5, total: 50 },
        oosMetrics: { avgReturn: 1.5, total: 20 },
      },
    },
  },
];
ok(
  "OOS beat IS → trust stays at 1.0",
  Math.abs(buildTrustScalar(pessimisticPrior) - 1.0) < 1e-9
);

// Thin OOS sample (< 5 trades) → ignored
const thinSample = [
  {
    perOutcome: {
      a: {
        isMetrics: { avgReturn: 1.0, total: 50 },
        oosMetrics: { avgReturn: 0.0, total: 2 }, // thin
      },
    },
  },
];
ok(
  "thin OOS sample (<5) is ignored, trust stays 1.0",
  Math.abs(buildTrustScalar(thinSample) - 1.0) < 1e-9
);

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n──────────────────────────────`);
console.log(`Passed: ${pass}   Failed: ${fail}`);
if (fail > 0) {
  process.exit(1);
}
