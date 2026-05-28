// Procedure Mode — walk-forward validation with immutable version history
// and shadow-tracking of deprecated versions.
//
// Flow per step:
//   1. User sees the current in-sample window and explores filters.
//   2. Commit → filters are frozen as either the leading version (if same
//      as prior) or a new version (if different; previous leading becomes
//      deprecated at this step).
//   3. OOS for this step is revealed, computed against the leading version
//      AND every deprecated version (shadow tracking).
//   4. Next step advances the window by one OOS length; IS is fixed length,
//      so the oldest OOS-length's worth of data rolls out of IS.
//
// Procedure is persisted to localStorage and resumed on reload provided
// the re-uploaded CSV's signature matches what was recorded at start.

import { useState, useEffect, useMemo, useCallback } from "react";
import Papa from "papaparse";
import {
  buildReturnSeries,
  calcMetrics,
  applyFilters,
  parseTimeToMinutes,
  applyDailyLossLimit,
  applyOverlapFilter,
  groupRows,
  getGroupKeyFn,
  sortGroupKeys,
  DOW_LABELS,
  parseDateToISO,
  addDays,
  fmt,
  fmtPct,
  runPipeline,
} from "./metrics.js";
import { theme, s, OPERATORS, DOW_OPERATORS } from "./theme.js";
import {
  DEFAULT_TOP_K,
  DEFAULT_WEIGHTS,
  runOptimizer,
  runOptimizerWinnersOnRows,
  getOptimizerDomain,
  buildPriorWinners,
  buildPriorPatchMetrics,
  buildTrustScalar,
  HISTORY_LOOKBACK,
} from "./autoOptimize.js";
import FiltersPasteModal from "./FiltersPasteModal.jsx";

const STORAGE_KEY = "eda-procedure-v1";
// v4 adds the overlap entry-offset (bar timestamps name the open of the
// bar, not the entry; offset shifts by bar duration). v4 also flips the
// per-outcome pipeline order from DLL → overlap to overlap → DLL so that
// trades excluded by overlap don't consume daily-loss budget. v3 → v4
// migration only needs to default the new field to 0; previously
// committed isMetrics/oosMetrics are stored verbatim and remain unchanged.
// v3 adds optimizer step memory: each optimizerResults[idx] now carries
// `phase1Metrics` (per-patch IS metrics) so future steps can compute
// per-patch trajectory. v2 → v3 migration treats the field as empty.
const SCHEMA_VERSION = 4;

// Empty optimizer config used when the user disables auto-optimizer or
// when migrating a v1 procedure forward.
function emptyOptimizerConfig() {
  return {
    enabled: false,
    fixedFilters: emptyFilters(),
    candidates: [],
    weights: { ...DEFAULT_WEIGHTS },
    topK: DEFAULT_TOP_K,
  };
}

// ── Canonical filter hash ──────────────────────────────────────────
// Produces a deterministic JSON string for equality comparison between
// two filter snapshots. Rules:
//   - strip `id` from conditions
//   - trim value strings (don't parse numbers)
//   - sort conditions within each group (commutative AND)
//   - sort groups (commutative OR)
//   - drop empty groups
//   - collapse disabled daily-loss / overlap state to a single "off" form
function canonicalFilters(filters) {
  const fg = filters.filterGroups || [];
  const groups = fg
    .map((g) =>
      g
        .map((f) => ({
          column: f.column || "",
          operator: f.operator || "",
          value: String(f.value ?? "").trim(),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    )
    .filter((g) => g.length > 0)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const dll = filters.dailyLossLimit;
  // lossTimeCol is added conditionally so old saved procedure hashes (which
  // were computed before the field existed) remain stable when restored —
  // a DLL with empty lossTimeCol canonicalizes the same as it did pre-fix.
  // Only when the user explicitly opts into a loss time column does the
  // hash diverge, which is the correct behavior (different filter behavior
  // → different version).
  const lim =
    dll && dll.col && String(dll.value).trim() && parseInt(dll.value, 10) > 0
      ? {
          col: dll.col,
          value: String(dll.value).trim(),
          timeCol: dll.timeCol || "",
          sessionStart: String(dll.sessionStart || "").trim(),
          ...(dll.lossTimeCol ? { lossTimeCol: dll.lossTimeCol } : {}),
        }
      : null;

  const ov = filters.overlap;
  let overlap = null;
  if (ov && ov.enabled && ov.entryDateCol && ov.entryTimeCol) {
    const exitMap = {};
    const rawMap = ov.exitMap || {};
    Object.keys(rawMap)
      .sort()
      .forEach((k) => {
        if (rawMap[k]) exitMap[k] = rawMap[k];
      });
    // entryOffsetMinutes is added conditionally so old saved procedure
    // hashes (computed before the field existed) remain stable when
    // restored with offset=0. A non-zero offset produces a different hash,
    // which is correct (different overlap behavior → different version).
    const offset = Number(ov.entryOffsetMinutes) || 0;
    overlap = {
      mode: ov.mode,
      compareCol: ov.mode === "always" ? "" : ov.compareCol || "",
      entryDateCol: ov.entryDateCol,
      entryTimeCol: ov.entryTimeCol,
      lossTimeCol: ov.lossTimeCol || "",
      exitMap,
      ...(offset ? { entryOffsetMinutes: offset } : {}),
    };
  }

  return JSON.stringify({ groups, lim, overlap });
}

// ── CSV signature ──────────────────────────────────────────────────
// Cheap content hash: row count + DJB2 hash of first/last 10 rows. Enough
// to detect that the user uploaded the same file; not cryptographic.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}
function computeCsvSignature(rows) {
  const n = rows.length;
  if (n === 0) return `0:empty`;
  const sample = [...rows.slice(0, 10), ...rows.slice(-10)]
    .map((r) => JSON.stringify(r))
    .join("|");
  return `${n}:${djb2(sample)}`;
}

// ── Storage ────────────────────────────────────────────────────────
function loadProcedure() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p) return null;
    // v1 → v2: bolt on a disabled optimizer block so old runs keep loading.
    if (p.schemaVersion === 1) {
      p.schemaVersion = 2;
      p.optimizer = emptyOptimizerConfig();
      p.optimizerResults = {};
    }
    // v2 → v3: optimizer step results gain phase1Metrics for cross-step
    // trajectory. Missing field is treated as empty — old steps simply
    // don't contribute trajectory signal until they're re-run.
    if (p.schemaVersion === 2) {
      p.schemaVersion = 3;
      const oRes = p.optimizerResults || {};
      for (const k of Object.keys(oRes)) {
        if (oRes[k] && oRes[k].phase1Metrics == null) oRes[k].phase1Metrics = {};
      }
    }
    // v3 → v4: overlap config gains entryOffsetMinutes. Default to 0 (no
    // offset) for any version's filter snapshot that predates the field.
    if (p.schemaVersion === 3) {
      p.schemaVersion = 4;
      for (const v of p.versions || []) {
        if (v && v.filters && v.filters.overlap &&
            v.filters.overlap.entryOffsetMinutes === undefined) {
          v.filters.overlap.entryOffsetMinutes = 0;
        }
      }
      if (p.optimizer && p.optimizer.fixedFilters &&
          p.optimizer.fixedFilters.overlap &&
          p.optimizer.fixedFilters.overlap.entryOffsetMinutes === undefined) {
        p.optimizer.fixedFilters.overlap.entryOffsetMinutes = 0;
      }
    }
    if (p.schemaVersion !== SCHEMA_VERSION) return null;
    if (!p.optimizer) p.optimizer = emptyOptimizerConfig();
    if (!p.optimizerResults) p.optimizerResults = {};
    return p;
  } catch {
    return null;
  }
}
function saveProcedure(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // localStorage quota exceeded — accept that refresh won't resume this run
  }
}
function clearProcedure() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // noop
  }
}

// Grouped variant of runPipeline for the IS exploration view. Mirrors the
// free-mode grouped branch: pre-overlap rows are grouped by `groupByCol`
// (with an optional key transform — hour, day-of-week, or week-of-month),
// keys are shared across all outcomes so columns line up, and per-outcome
// overlap runs independently within each group.
function runGroupedPipeline(rows, filters, config, groupByCol, groupKeyMode) {
  const { outcomeCols, lossCol } = config;
  const activeGroups = (filters.filterGroups || []).filter((g) => g.length > 0);
  const afterFilters = applyFilters(rows, activeGroups);

  const dll = filters.dailyLossLimit;
  const limNum = dll ? parseInt(dll.value, 10) : 0;
  const sessMins = dll ? parseTimeToMinutes(dll.sessionStart) : null;
  const dllCol = dll ? dll.col || "" : "";
  const dllTimeCol = dll ? dll.timeCol || "" : "";
  const dllLossTimeCol = dll ? dll.lossTimeCol || "" : "";

  const ov = filters.overlap;
  const overlapReady =
    !!(ov && ov.enabled && ov.entryDateCol && ov.entryTimeCol &&
      (ov.mode === "always" || ov.compareCol));

  // Group keys come from the post-applyFilters (pre-DLL) set so columns line
  // up across outcomes. Per-outcome DLL+overlap then reshape row counts
  // inside each group. `_count` is the shared pre-DLL group size, the same
  // stable denominator every outcome's metrics are computed against.
  const keyFn = getGroupKeyFn(groupKeyMode);
  const preGroups = groupRows(afterFilters, groupByCol, keyFn);
  const sortedKeys = sortGroupKeys(Object.keys(preGroups), groupKeyMode);

  const grouped = {};
  for (const key of sortedKeys) {
    grouped[key] = { _count: preGroups[key].length };
  }
  for (const oc of outcomeCols) {
    const afterOverlap = overlapReady
      ? applyOverlapFilter(afterFilters, {
          enabled: true,
          mode: ov.mode,
          compareCol: ov.compareCol,
          entryDateCol: ov.entryDateCol,
          entryTimeCol: ov.entryTimeCol,
          lossTimeCol: ov.lossTimeCol || "",
          exitTimeCol: (ov.exitMap || {})[oc] || "",
          lossCol,
          outcomeCol: oc,
          entryOffsetMinutes: ov.entryOffsetMinutes || 0,
        })
      : afterFilters;
    const ocRows = applyDailyLossLimit(
      afterOverlap,
      dllCol,
      lossCol,
      limNum,
      dllTimeCol,
      sessMins,
      dllLossTimeCol,
      oc
    );
    const ocGroups = groupRows(ocRows, groupByCol, keyFn);
    for (const key of sortedKeys) {
      const rowsForGroup = ocGroups[key] ?? [];
      grouped[key][oc] = calcMetrics(
        buildReturnSeries(rowsForGroup, oc, lossCol)
      );
    }
  }
  return {
    grouped,
    keys: sortedKeys,
    afterFilterCount: afterFilters.length,
    overlapActive: overlapReady,
  };
}

// ── Row filtering by date range ────────────────────────────────────
function rowsInDateRange(rows, dateCol, loIso, hiIso) {
  if (!loIso || !hiIso || loIso > hiIso) return [];
  return rows.filter((r) => {
    const d = parseDateToISO(r[dateCol]);
    return d !== null && d >= loIso && d <= hiIso;
  });
}

// ── Step window math ───────────────────────────────────────────────
// Inclusive date ranges. IS and OOS are strictly ordered (oosStart =
// isEnd + 1). Embargo shrinks each window inward by N days per edge,
// creating a 2N-day gap between effective IS end and effective OOS start.
function computeStepWindows(dataMinDate, stepIdx, config) {
  const { isLengthDays, oosLengthDays, embargoDays } = config;
  const isStart = addDays(dataMinDate, stepIdx * oosLengthDays);
  const isEnd = addDays(isStart, isLengthDays - 1);
  const oosStart = addDays(isEnd, 1);
  const oosEnd = addDays(oosStart, oosLengthDays - 1);
  const emb = embargoDays;
  return {
    idx: stepIdx,
    isStart,
    isEnd,
    oosStart,
    oosEnd,
    effIsStart: emb > 0 ? addDays(isStart, emb) : isStart,
    effIsEnd: emb > 0 ? addDays(isEnd, -emb) : isEnd,
    effOosStart: emb > 0 ? addDays(oosStart, emb) : oosStart,
    effOosEnd: emb > 0 ? addDays(oosEnd, -emb) : oosEnd,
  };
}

// ── Dataset min/max dates ──────────────────────────────────────────
function computeDataDateRange(rows, dateCol) {
  let mn = null,
    mx = null,
    unparseable = 0;
  for (const r of rows) {
    const d = parseDateToISO(r[dateCol]);
    if (d === null) {
      unparseable++;
      continue;
    }
    if (mn === null || d < mn) mn = d;
    if (mx === null || d > mx) mx = d;
  }
  return { min: mn, max: mx, unparseable };
}

// ── Empty filter draft ────────────────────────────────────────────
function emptyFilters() {
  return {
    filterGroups: [[]],
    dailyLossLimit: { col: "", value: "", timeCol: "", sessionStart: "", lossTimeCol: "" },
    overlap: {
      enabled: false,
      mode: "always",
      compareCol: "",
      entryDateCol: "",
      entryTimeCol: "",
      lossTimeCol: "",
      exitMap: {},
      entryOffsetMinutes: 0,
    },
  };
}

// Deep clone a version's filter snapshot for use as an editable draft.
// Re-assigns fresh condition ids so React keys don't collide.
function cloneFiltersForDraft(filters) {
  const f = JSON.parse(JSON.stringify(filters || emptyFilters()));
  let nextId = Date.now();
  (f.filterGroups || [[]]).forEach((g) => g.forEach((c) => (c.id = ++nextId)));
  if (!f.filterGroups || f.filterGroups.length === 0) f.filterGroups = [[]];
  if (!f.dailyLossLimit) {
    f.dailyLossLimit = { col: "", value: "", timeCol: "", sessionStart: "", lossTimeCol: "" };
  } else if (f.dailyLossLimit.lossTimeCol === undefined) {
    // Pre-loss-time-col DLL snapshot — fill in the new field so the rest
    // of the code can read it unconditionally.
    f.dailyLossLimit.lossTimeCol = "";
  }
  if (!f.overlap)
    f.overlap = {
      enabled: false,
      mode: "always",
      compareCol: "",
      entryDateCol: "",
      entryTimeCol: "",
      lossTimeCol: "",
      exitMap: {},
      entryOffsetMinutes: 0,
    };
  else if (f.overlap.entryOffsetMinutes === undefined) {
    // Pre-offset overlap snapshot — fill in the new field so the rest
    // of the code can read it unconditionally.
    f.overlap.entryOffsetMinutes = 0;
  }
  return f;
}

// ── Top-level component ───────────────────────────────────────────
export default function ProcedureMode({ rows, columns, csvName }) {
  const [procedure, setProcedureState] = useState(() => loadProcedure());

  // Persist on every change
  const setProcedure = useCallback((next) => {
    setProcedureState(next);
    if (next) saveProcedure(next);
    else clearProcedure();
  }, []);

  // CSV signature for the currently-uploaded file. Null if none uploaded.
  const csvSignature = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    return computeCsvSignature(rows);
  }, [rows]);

  // ── No CSV uploaded yet ─────────────────────────────────────────
  if (!rows || rows.length === 0) {
    return (
      <div style={s.card}>
        <div style={s.h2}>Procedure Mode</div>
        <p style={{ color: theme.textMuted, fontSize: 12 }}>
          Upload a CSV above to begin.
          {procedure && (
            <>
              {" "}
              An in-progress procedure for <strong>{procedure.csvName}</strong>{" "}
              ({procedure.csvRowCount} rows) is saved — re-upload that file to
              resume.
            </>
          )}
        </p>
        {procedure && (
          <DiscardButton
            onDiscard={() => setProcedure(null)}
            label="Discard saved procedure"
          />
        )}
      </div>
    );
  }

  // ── CSV uploaded but procedure in storage doesn't match ─────────
  if (procedure && procedure.csvSignature !== csvSignature) {
    return (
      <div style={s.card}>
        <div style={s.h2}>Procedure Mode</div>
        <div
          style={{
            background: theme.surfaceAlt,
            border: `1px solid ${theme.gold}`,
            borderRadius: 6,
            padding: 14,
            fontSize: 12,
          }}
        >
          <div style={{ color: theme.gold, fontWeight: 700, marginBottom: 6 }}>
            CSV mismatch
          </div>
          <div style={{ marginBottom: 8 }}>
            An in-progress procedure exists for{" "}
            <strong>{procedure.csvName}</strong> (
            {procedure.csvRowCount} rows, signature{" "}
            <code style={{ color: theme.textMuted }}>
              {procedure.csvSignature}
            </code>
            ). The current CSV <strong>{csvName}</strong> ({rows.length} rows,{" "}
            <code style={{ color: theme.textMuted }}>{csvSignature}</code>) is
            different.
          </div>
          <div style={{ color: theme.textMuted, marginBottom: 8 }}>
            Re-upload the matching file to resume, or discard to start a new
            procedure on this CSV.
          </div>
          <DiscardButton
            onDiscard={() => setProcedure(null)}
            label="Discard saved procedure"
          />
        </div>
      </div>
    );
  }

  // ── No procedure yet → show setup screen ────────────────────────
  if (!procedure) {
    return (
      <SetupScreen
        rows={rows}
        columns={columns}
        csvName={csvName}
        csvSignature={csvSignature}
        onStart={(p) => setProcedure(p)}
      />
    );
  }

  // ── Procedure running → step or complete view ───────────────────
  if (procedure.phase === "complete") {
    return (
      <CompleteScreen
        rows={rows}
        procedure={procedure}
        onDiscard={() => setProcedure(null)}
      />
    );
  }

  return (
    <StepScreen
      rows={rows}
      procedure={procedure}
      onUpdate={(next) => setProcedure(next)}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════
function SetupScreen({ rows, columns, csvName, csvSignature, onStart }) {
  const [dateCol, setDateCol] = useState("");
  const [outcomeCols, setOutcomeCols] = useState([]);
  const [lossCol, setLossCol] = useState("");
  const [isLengthDays, setIsLengthDays] = useState("365");
  const [oosLengthDays, setOosLengthDays] = useState("30");
  const [embargoDays, setEmbargoDays] = useState("0");
  // Optimizer configuration (only persisted into the procedure if enabled).
  const [optimizerEnabled, setOptimizerEnabled] = useState(false);
  const [optimizerFixed, setOptimizerFixed] = useState(() => emptyFilters());
  const [optimizerCandidates, setOptimizerCandidates] = useState([]);
  const [optimizerWeights, setOptimizerWeights] = useState({
    rpt: DEFAULT_WEIGHTS.rpt,
    net: DEFAULT_WEIGHTS.net,
    dd: DEFAULT_WEIGHTS.dd,
  });
  const [optimizerTopK, setOptimizerTopK] = useState(DEFAULT_TOP_K);

  const dataRange = useMemo(() => {
    if (!dateCol) return null;
    return computeDataDateRange(rows, dateCol);
  }, [rows, dateCol]);

  const validation = useMemo(() => {
    const errs = [];
    if (!dateCol) errs.push("Pick a date column.");
    if (outcomeCols.length === 0) errs.push("Select at least one outcome column.");
    if (!lossCol) errs.push("Pick a loss column.");
    if (lossCol && outcomeCols.includes(lossCol))
      errs.push("Loss column cannot also be an outcome column.");
    const isLen = parseInt(isLengthDays, 10);
    const oosLen = parseInt(oosLengthDays, 10);
    const emb = parseInt(embargoDays, 10);
    if (!(isLen > 0)) errs.push("In-sample length must be a positive integer.");
    if (!(oosLen > 0)) errs.push("OOS step length must be a positive integer.");
    if (!(emb >= 0)) errs.push("Embargo must be ≥ 0.");
    if (isLen > 0 && oosLen > 0 && emb >= 0) {
      if (emb * 2 >= oosLen)
        errs.push(
          `Embargo (${emb} per edge) would consume the entire OOS window (${oosLen} days).`
        );
      if (emb * 2 >= isLen)
        errs.push(
          `Embargo (${emb} per edge) would consume the entire IS window (${isLen} days).`
        );
    }
    if (dataRange && dataRange.min && dataRange.max) {
      const totalDays = (new Date(dataRange.max + "T00:00:00Z").getTime() -
        new Date(dataRange.min + "T00:00:00Z").getTime()) /
        86400000 + 1;
      if (isLen + oosLen > totalDays)
        errs.push(
          `CSV only spans ${Math.round(totalDays)} days — IS + OOS (${
            isLen + oosLen
          } days) exceeds available data.`
        );
    }
    if (dataRange && dataRange.unparseable > 0)
      errs.push(
        `${dataRange.unparseable} rows have unparseable dates — procedure will skip them.`
      );
    if (optimizerEnabled) {
      if (optimizerCandidates.length === 0) {
        errs.push("Auto-optimizer is on but no candidate parameters defined.");
      }
      for (const c of optimizerCandidates) {
        if (
          (c.kind === "categorical_individual" ||
            c.kind === "categorical_combinations" ||
            c.kind === "range_gte" ||
            c.kind === "range_lte") &&
          !c.column
        ) {
          errs.push(`Candidate (${c.kind}) is missing a column.`);
        }
        if (
          (c.kind === "range_gte" || c.kind === "range_lte") &&
          (!(Number(c.max) > 0) || !(Number(c.increment) > 0))
        ) {
          errs.push(
            `Candidate (${c.kind}) on ${c.column || "?"} needs max>0 and increment>0.`
          );
        }
        if (c.kind === "daily_loss_limit" && !(Number(c.max) >= 0)) {
          errs.push("Daily-loss-limit candidate needs max ≥ 0.");
        }
      }
      const wsum = optimizerWeights.rpt + optimizerWeights.net + optimizerWeights.dd;
      if (!(wsum > 0)) errs.push("Optimizer weights must sum > 0.");
      if (!(optimizerTopK >= 1)) errs.push("Top-K must be ≥ 1.");
    }
    return errs;
  }, [
    dateCol, outcomeCols, lossCol, isLengthDays, oosLengthDays, embargoDays,
    dataRange, optimizerEnabled, optimizerCandidates, optimizerWeights, optimizerTopK,
  ]);

  // Fatal errors block Start. Warnings (unparseable dates) do not.
  const optimizerValid =
    !optimizerEnabled ||
    (optimizerCandidates.length > 0 &&
      optimizerCandidates.every((c) => {
        if (c.kind === "daily_loss_limit") return Number(c.max) >= 0;
        if (c.kind === "range_gte" || c.kind === "range_lte")
          return c.column && Number(c.max) > 0 && Number(c.increment) > 0;
        return !!c.column;
      }) &&
      optimizerWeights.rpt + optimizerWeights.net + optimizerWeights.dd > 0 &&
      optimizerTopK >= 1);

  const canStart =
    dateCol &&
    outcomeCols.length > 0 &&
    lossCol &&
    !outcomeCols.includes(lossCol) &&
    parseInt(isLengthDays, 10) > 0 &&
    parseInt(oosLengthDays, 10) > 0 &&
    parseInt(embargoDays, 10) >= 0 &&
    dataRange &&
    dataRange.min &&
    dataRange.max &&
    parseInt(embargoDays, 10) * 2 < parseInt(oosLengthDays, 10) &&
    parseInt(embargoDays, 10) * 2 < parseInt(isLengthDays, 10) &&
    optimizerValid;

  const toggleOutcome = (c) =>
    setOutcomeCols((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );

  const start = () => {
    if (!canStart) return;
    const config = {
      dateCol,
      outcomeCols: [...outcomeCols],
      lossCol,
      isLengthDays: parseInt(isLengthDays, 10),
      oosLengthDays: parseInt(oosLengthDays, 10),
      embargoDays: parseInt(embargoDays, 10),
    };
    const firstStep = computeStepWindows(dataRange.min, 0, config);
    // Strip UI-only `id`s from the optimizer's fixed filters before storing.
    const frozenFixed = JSON.parse(JSON.stringify(optimizerFixed));
    (frozenFixed.filterGroups || []).forEach((g) =>
      g.forEach((c) => delete c.id)
    );
    const optimizer = optimizerEnabled
      ? {
          enabled: true,
          fixedFilters: frozenFixed,
          candidates: JSON.parse(JSON.stringify(optimizerCandidates)),
          weights: { ...optimizerWeights },
          topK: optimizerTopK,
        }
      : emptyOptimizerConfig();
    onStart({
      schemaVersion: SCHEMA_VERSION,
      csvSignature,
      csvName,
      csvRowCount: rows.length,
      csvDataMinDate: dataRange.min,
      csvDataMaxDate: dataRange.max,
      config,
      steps: [{ ...firstStep, committed: false, leadingVersionId: null }],
      versions: [],
      results: {},
      optimizer,
      optimizerResults: {},
      currentStepIdx: 0,
      phase: "is_explore",
    });
  };

  return (
    <div style={s.card}>
      <div style={s.h2}>Procedure Mode — Setup</div>
      <p style={{ color: theme.textMuted, fontSize: 12, marginBottom: 12 }}>
        Define once, lock for the run: date column, outcome / loss columns, and
        window lengths. Each step rolls the IS window forward by one OOS step.
        Committing filters creates or reuses a version; deprecated versions are
        shadow-tracked on every subsequent step.
      </p>

      <div style={{ ...s.row, marginBottom: 16 }}>
        <div>
          <label style={s.label}>Date Column</label>
          <select
            style={s.select}
            value={dateCol}
            onChange={(e) => setDateCol(e.target.value)}
          >
            <option value="">Select...</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={s.label}>Loss Column</label>
          <select
            style={s.select}
            value={lossCol}
            onChange={(e) => setLossCol(e.target.value)}
          >
            <option value="">Select...</option>
            {columns
              .filter((c) => !outcomeCols.includes(c))
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={s.label}>Outcome Columns (click to toggle)</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {columns.map((c) => (
            <button
              key={c}
              onClick={() => toggleOutcome(c)}
              style={{
                ...s.chip(outcomeCols.includes(c)),
                ...(c === lossCol ? { opacity: 0.3, pointerEvents: "none" } : {}),
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...s.row, marginBottom: 16 }}>
        <div>
          <label style={s.label}>In-Sample Length (days)</label>
          <input
            type="number"
            min="1"
            style={{ ...s.input, width: 100 }}
            value={isLengthDays}
            onChange={(e) => setIsLengthDays(e.target.value)}
          />
        </div>
        <div>
          <label style={s.label}>OOS Step Length (days)</label>
          <input
            type="number"
            min="1"
            style={{ ...s.input, width: 100 }}
            value={oosLengthDays}
            onChange={(e) => setOosLengthDays(e.target.value)}
          />
        </div>
        <div>
          <label style={s.label}>Embargo (days per edge)</label>
          <input
            type="number"
            min="0"
            style={{ ...s.input, width: 100 }}
            value={embargoDays}
            onChange={(e) => setEmbargoDays(e.target.value)}
          />
        </div>
      </div>

      {dataRange && (
        <div
          style={{
            background: theme.surfaceAlt,
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          <div>
            <span style={{ color: theme.textMuted }}>Data range:</span>{" "}
            <strong>{dataRange.min ?? "—"}</strong> →{" "}
            <strong>{dataRange.max ?? "—"}</strong>{" "}
            <span style={{ color: theme.textMuted }}>·</span>{" "}
            <span style={{ color: theme.textMuted }}>Rows:</span>{" "}
            <strong>{rows.length}</strong>{" "}
            <span style={{ color: theme.textMuted }}>·</span>{" "}
            <span style={{ color: theme.textMuted }}>Unparseable dates:</span>{" "}
            <strong
              style={{
                color: dataRange.unparseable > 0 ? theme.gold : theme.green,
              }}
            >
              {dataRange.unparseable}
            </strong>
          </div>
        </div>
      )}

      {validation.length > 0 && (
        <ul
          style={{
            color: theme.gold,
            fontSize: 11,
            paddingLeft: 20,
            marginBottom: 12,
          }}
        >
          {validation.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      )}

      <OptimizerConfigBlock
        columns={columns}
        outcomeCols={outcomeCols}
        enabled={optimizerEnabled}
        setEnabled={setOptimizerEnabled}
        fixed={optimizerFixed}
        setFixed={setOptimizerFixed}
        candidates={optimizerCandidates}
        setCandidates={setOptimizerCandidates}
        weights={optimizerWeights}
        setWeights={setOptimizerWeights}
        topK={optimizerTopK}
        setTopK={setOptimizerTopK}
      />

      <div
        style={{
          background: theme.surfaceAlt,
          border: `1px solid ${theme.red}`,
          borderRadius: 6,
          padding: 12,
          marginBottom: 12,
          fontSize: 11,
          color: theme.text,
        }}
      >
        <strong style={{ color: theme.red }}>Before you start:</strong> this
        procedure runs once to completion. Each step's committed filters become
        part of an immutable version history. You cannot go back to edit a
        previous step's filters. Re-starting requires discarding the entire
        run.
      </div>

      <button
        style={{
          ...s.btn,
          background: canStart ? theme.accent : theme.border,
          cursor: canStart ? "pointer" : "not-allowed",
        }}
        onClick={start}
        disabled={!canStart}
      >
        Start Procedure
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZER CONFIG BLOCK (in setup screen)
// ═══════════════════════════════════════════════════════════════════
function OptimizerConfigBlock({
  columns,
  outcomeCols,
  enabled,
  setEnabled,
  fixed,
  setFixed,
  candidates,
  setCandidates,
  weights,
  setWeights,
  topK,
  setTopK,
}) {
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [newFilter, setNewFilter] = useState({
    column: "",
    operator: "equals",
    value: "",
  });
  const [newKind, setNewKind] = useState("categorical_individual");

  const addCandidate = () => {
    const base = { kind: newKind, minOccurrences: 3 };
    let row;
    if (newKind === "categorical_individual" || newKind === "categorical_combinations") {
      row = { ...base, column: "" };
    } else if (newKind === "range_gte" || newKind === "range_lte") {
      row = { ...base, column: "", max: 100, increment: 10 };
    } else if (newKind === "daily_loss_limit") {
      row = { ...base, max: 8 };
    }
    setCandidates([...candidates, row]);
  };

  const updateCandidate = (idx, patch) => {
    setCandidates(candidates.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeCandidate = (idx) =>
    setCandidates(candidates.filter((_, i) => i !== idx));

  return (
    <div
      style={{
        background: theme.surfaceAlt,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: theme.text,
          cursor: "pointer",
          marginBottom: enabled ? 12 : 0,
          fontWeight: 700,
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable Auto-Optimizer
        <span
          style={{
            color: theme.textMuted,
            fontSize: 11,
            fontWeight: 400,
            marginLeft: 8,
          }}
        >
          Runs alongside your manual procedure. Per-outcome winners committed
          on each Save IS.
        </span>
      </label>

      {enabled && (
        <>
          <FilterControls
            draft={fixed}
            setDraft={setFixed}
            columns={columns}
            outcomeCols={outcomeCols}
            activeGroupIdx={activeGroupIdx}
            setActiveGroupIdx={setActiveGroupIdx}
            newFilter={newFilter}
            setNewFilter={setNewFilter}
            readOnly={false}
            leadingVersion={null}
            hideDailyLossLimit={true}
            title="Optimizer Fixed Filters (overlap + persistent exclusions; applied at every step before search)"
          />

          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: 12,
              marginTop: 12,
              background: theme.surface,
            }}
          >
            <div style={{ ...s.h3, marginBottom: 6 }}>Candidate Parameters</div>
            <p style={{ color: theme.textMuted, fontSize: 11, marginBottom: 10 }}>
              Each parameter is searched independently in Phase 1. Best
              survivors (those that beat the fixed-filters baseline) are
              combined in Phase 2 — top-K subsets tested with AND. Distinct
              values are enumerated from the IS rows that survive the fixed
              filters.
            </p>

            {candidates.map((c, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "flex-end",
                  marginBottom: 8,
                  paddingBottom: 8,
                  borderBottom:
                    i < candidates.length - 1
                      ? `1px dashed ${theme.border}`
                      : "none",
                }}
              >
                <div>
                  <label style={s.label}>Kind</label>
                  <select
                    style={s.select}
                    value={c.kind}
                    onChange={(e) => {
                      const k = e.target.value;
                      const base = { kind: k, minOccurrences: c.minOccurrences };
                      if (k === "categorical_individual" || k === "categorical_combinations")
                        updateCandidate(i, { ...base, column: c.column || "" });
                      else if (k === "range_gte" || k === "range_lte")
                        updateCandidate(i, {
                          ...base,
                          column: c.column || "",
                          max: c.max ?? 100,
                          increment: c.increment ?? 10,
                        });
                      else if (k === "daily_loss_limit")
                        updateCandidate(i, { ...base, max: c.max ?? 8 });
                    }}
                  >
                    <option value="categorical_individual">
                      Categorical (one value at a time)
                    </option>
                    <option value="categorical_combinations">
                      Categorical (all OR-subsets)
                    </option>
                    <option value="range_gte">Range (column ≥ v)</option>
                    <option value="range_lte">Range (column ≤ v)</option>
                    <option value="daily_loss_limit">Daily Loss Limit</option>
                  </select>
                </div>
                {c.kind !== "daily_loss_limit" && (
                  <div>
                    <label style={s.label}>Column</label>
                    <select
                      style={s.select}
                      value={c.column || ""}
                      onChange={(e) => updateCandidate(i, { column: e.target.value })}
                    >
                      <option value="">Select...</option>
                      {columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {(c.kind === "range_gte" ||
                  c.kind === "range_lte" ||
                  c.kind === "daily_loss_limit") && (
                  <>
                    <div>
                      <label style={s.label}>Max</label>
                      <input
                        type="number"
                        style={{ ...s.input, width: 80 }}
                        value={c.max ?? ""}
                        onChange={(e) =>
                          updateCandidate(i, { max: e.target.value === "" ? "" : Number(e.target.value) })
                        }
                      />
                    </div>
                    {c.kind !== "daily_loss_limit" && (
                      <div>
                        <label style={s.label}>Increment</label>
                        <input
                          type="number"
                          style={{ ...s.input, width: 80 }}
                          value={c.increment ?? ""}
                          onChange={(e) =>
                            updateCandidate(i, {
                              increment: e.target.value === "" ? "" : Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    )}
                  </>
                )}
                <div>
                  <label style={s.label}>Min Occurrences</label>
                  <input
                    type="number"
                    style={{ ...s.input, width: 80 }}
                    min="0"
                    value={c.minOccurrences ?? 0}
                    onChange={(e) =>
                      updateCandidate(i, {
                        minOccurrences: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
                <button style={s.btnDanger} onClick={() => removeCandidate(i)}>
                  Remove
                </button>
              </div>
            ))}

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 4 }}>
              <div>
                <label style={s.label}>Add candidate</label>
                <select
                  style={s.select}
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value)}
                >
                  <option value="categorical_individual">
                    Categorical (one value at a time)
                  </option>
                  <option value="categorical_combinations">
                    Categorical (all OR-subsets)
                  </option>
                  <option value="range_gte">Range (column ≥ v)</option>
                  <option value="range_lte">Range (column ≤ v)</option>
                  <option value="daily_loss_limit">Daily Loss Limit</option>
                </select>
              </div>
              <button style={s.btn} onClick={addCandidate}>
                + Add
              </button>
            </div>
            <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 10 }}>
              Note: <strong>Categorical (all OR-subsets)</strong> generates
              2<sup>V</sup>−2 candidates for V distinct values. Use only on
              small categorical columns (V ≤ ~12).
            </p>
          </div>

          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: 12,
              marginTop: 12,
              background: theme.surface,
            }}
          >
            <div style={{ ...s.h3, marginBottom: 6 }}>
              Composite Score Weights
            </div>
            <p style={{ color: theme.textMuted, fontSize: 11, marginBottom: 10 }}>
              Each candidate is ranked per metric (percentile within the run);
              composite = weighted sum. Defaults are equal. Higher RU/trade and
              Net RU score better; lower Max DD scores better.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label style={s.label}>RU / trade weight</label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  style={{ ...s.input, width: 100 }}
                  value={weights.rpt}
                  onChange={(e) =>
                    setWeights({ ...weights, rpt: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <label style={s.label}>Net RU weight</label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  style={{ ...s.input, width: 100 }}
                  value={weights.net}
                  onChange={(e) =>
                    setWeights({ ...weights, net: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <label style={s.label}>Max DD weight</label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  style={{ ...s.input, width: 100 }}
                  value={weights.dd}
                  onChange={(e) =>
                    setWeights({ ...weights, dd: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <label style={s.label}>Top-K combinations</label>
                <input
                  type="number"
                  min="1"
                  style={{ ...s.input, width: 80 }}
                  value={topK}
                  onChange={(e) =>
                    setTopK(parseInt(e.target.value, 10) || 1)
                  }
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STEP SCREEN
// ═══════════════════════════════════════════════════════════════════
function StepScreen({ rows, procedure, onUpdate }) {
  const { config, currentStepIdx, phase } = procedure;
  const step = procedure.steps[currentStepIdx];
  const leadingVersion =
    procedure.versions.find((v) => v.deprecatedAtStepIdx === null) || null;

  // Pre-seed draft: on entering a fresh step, draft = leading version's
  // filters (if any). Keeps the "no change" path trivially one-click.
  const [draft, setDraft] = useState(() =>
    cloneFiltersForDraft(leadingVersion ? leadingVersion.filters : null)
  );
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [newFilter, setNewFilter] = useState({
    column: "",
    operator: "equals",
    value: "",
  });
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Group-by is a view-only control for IS exploration. NOT part of the
  // version snapshot — per user spec, group-by is a display choice.
  const [groupByCol, setGroupByCol] = useState("");
  // "raw" | "hour" | "dow" | "wom" — applied to the chosen group column.
  const [groupKeyMode, setGroupKeyMode] = useState("raw");

  // When step index changes (after advance), reset the draft to match the
  // new leading version.
  useEffect(() => {
    setDraft(
      cloneFiltersForDraft(leadingVersion ? leadingVersion.filters : null)
    );
    setActiveGroupIdx(0);
    setNewFilter({ column: "", operator: "equals", value: "" });
    setGroupByCol("");
    setGroupKeyMode("raw");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIdx, phase]);

  // Effective row subsets for this step (post-embargo date windows)
  const isRows = useMemo(
    () =>
      rowsInDateRange(rows, config.dateCol, step.effIsStart, step.effIsEnd),
    [rows, config.dateCol, step.effIsStart, step.effIsEnd]
  );
  const oosRows = useMemo(
    () =>
      rowsInDateRange(rows, config.dateCol, step.effOosStart, step.effOosEnd),
    [rows, config.dateCol, step.effOosStart, step.effOosEnd]
  );

  // Live IS metrics (for the user's exploration)
  const isLiveResults = useMemo(() => {
    if (phase !== "is_explore") return null;
    if (groupByCol)
      return {
        type: "grouped",
        ...runGroupedPipeline(isRows, draft, config, groupByCol, groupKeyMode),
      };
    return { type: "ungrouped", ...runPipeline(isRows, draft, config) };
  }, [isRows, draft, config, phase, groupByCol, groupKeyMode]);

  // Stored OOS step results (keyed by version id)
  const stepResults = procedure.results[currentStepIdx] || null;
  const optimizerResultsForStep =
    (procedure.optimizerResults || {})[currentStepIdx] || null;

  // Optimizer-domain preview during IS exploration: how many distinct values
  // each categorical candidate would expand to, computed against the IS rows
  // post the optimizer's fixed-applyFilters (NOT the user's draft).
  const optimizerPreview = useMemo(() => {
    if (phase !== "is_explore") return null;
    if (!procedure.optimizer || !procedure.optimizer.enabled) return null;
    const opt = procedure.optimizer;
    const domain = getOptimizerDomain(isRows, opt.fixedFilters);
    return {
      domainSize: domain.length,
      isRows: isRows.length,
    };
  }, [phase, procedure.optimizer, isRows]);

  // Optimizer running flag (during the brief sync run on commit)
  const [optimizing, setOptimizing] = useState(false);

  // Commit: record version + compute OOS for all live+deprecated versions
  const handleCommit = () => {
    const hash = canonicalFilters(draft);
    const leading = leadingVersion;

    let updatedVersions;
    let leadingId;
    if (leading && leading.filtersHash === hash) {
      // No change — reuse leading version
      updatedVersions = procedure.versions;
      leadingId = leading.id;
    } else {
      // New version; deprecate prior leading (if any) at this step
      const newId = `V${procedure.versions.length + 1}`;
      const frozenFilters = JSON.parse(JSON.stringify(draft));
      // Strip ids from conditions in the stored snapshot — the hash is what
      // matters for identity, ids are UI-only.
      (frozenFilters.filterGroups || []).forEach((g) =>
        g.forEach((c) => delete c.id)
      );
      const newVersion = {
        id: newId,
        createdAtStepIdx: currentStepIdx,
        deprecatedAtStepIdx: null,
        filtersHash: hash,
        filters: frozenFilters,
      };
      updatedVersions = procedure.versions.map((v) =>
        v.deprecatedAtStepIdx === null
          ? { ...v, deprecatedAtStepIdx: currentStepIdx }
          : v
      );
      updatedVersions = [...updatedVersions, newVersion];
      leadingId = newId;
    }

    // Compute OOS for leading + every deprecated version on this step's
    // OOS data. Each uses its OWN stored filter snapshot.
    const resultsForStep = {};
    for (const v of updatedVersions) {
      const pipelineResult = runPipeline(oosRows, v.filters, config);
      resultsForStep[v.id] = {
        ...pipelineResult,
        isLeading: v.id === leadingId,
        isShadow: v.deprecatedAtStepIdx !== null,
      };
    }

    const updatedSteps = procedure.steps.map((st, i) =>
      i === currentStepIdx
        ? { ...st, committed: true, leadingVersionId: leadingId }
        : st
    );

    // Run the auto-optimizer on this step (if enabled). It searches IS,
    // picks per-outcome winners, then we replay each winner on OOS rows
    // and persist both alongside the manual version's results.
    const opt = procedure.optimizer;
    const runOptimizerForCommit = () => {
      if (!opt || !opt.enabled) return null;

      // ── Build `history` for the optimizer ────────────────────────
      // OOS-firewall safe: every field is derived ONLY from optimizer
      // step results that were committed at strictly-prior steps. The
      // current step's OOS rows are NEVER referenced here. See the
      // OOS FIREWALL block at the top of autoOptimize.js.
      const oRes = procedure.optimizerResults || {};
      const priorIndices = Object.keys(oRes)
        .map((k) => parseInt(k, 10))
        .filter((i) => Number.isFinite(i) && i < currentStepIdx)
        .sort((a, b) => b - a); // newest first
      const priorSteps = priorIndices.map((i) => oRes[i]).filter(Boolean);
      const priorPhase1List = priorSteps
        .slice(0, HISTORY_LOOKBACK)
        .map((s) => s.phase1Metrics || {});
      const lastStep = priorSteps[0] || null;

      const history = {
        priorWinners: lastStep
          ? buildPriorWinners(lastStep, config.outcomeCols)
          : {},
        priorPatchMetrics: buildPriorPatchMetrics(priorPhase1List, config.outcomeCols),
        trust: buildTrustScalar(priorSteps),
      };

      const isWinners = runOptimizer(
        isRows,
        opt.fixedFilters,
        opt.candidates,
        opt.weights,
        opt.topK,
        config,
        history
      );
      const oosForOutcome = runOptimizerWinnersOnRows(
        isWinners.perOutcome,
        oosRows,
        config
      );
      const perOutcome = {};
      for (const oc of config.outcomeCols) {
        const w = isWinners.perOutcome[oc];
        const o = oosForOutcome[oc] || {
          metrics: { total: 0 },
          returnSeries: [],
          rowCount: 0,
        };
        perOutcome[oc] = {
          filters: w.filters,
          isMetrics: w.metrics,
          isReturnSeries: w.returnSeries,
          isRowCount: w.rowCount,
          oosMetrics: o.metrics,
          oosReturnSeries: o.returnSeries,
          oosRowCount: o.rowCount,
          score: w.score,
          candidatesUsed: w.candidatesUsed,
        };
      }
      return {
        perOutcome,
        domainSize: isWinners.domainSize,
        candidatesEvaluated: isWinners.candidatesEvaluated,
        // Persist per-patch IS metrics so future steps can compute the
        // per-patch trajectory feature in `priorPatchMetrics`.
        phase1Metrics: isWinners.phase1Metrics || {},
        // Persist trust used at this step so the UI can surface the
        // optimizer's calibration if desired (read-only, never re-fed).
        trustUsed: history.trust,
      };
    };

    setOptimizing(true);
    // Yield one frame so the "Running optimizer…" indicator paints before
    // the synchronous search blocks the main thread.
    setTimeout(() => {
      let optStep = null;
      try {
        optStep = runOptimizerForCommit();
      } catch (err) {
        console.error("Optimizer error:", err);
        alert(
          "Auto-optimizer failed on this step. Manual version was committed normally. See console for details."
        );
      }
      const newOptimizerResults = optStep
        ? { ...(procedure.optimizerResults || {}), [currentStepIdx]: optStep }
        : procedure.optimizerResults || {};
      onUpdate({
        ...procedure,
        versions: updatedVersions,
        steps: updatedSteps,
        results: { ...procedure.results, [currentStepIdx]: resultsForStep },
        optimizerResults: newOptimizerResults,
        phase: "oos_visible",
      });
      setOptimizing(false);
    }, 0);
  };

  // Advance to next step — or mark complete if next OOS has no rows
  const handleAdvance = () => {
    const nextIdx = currentStepIdx + 1;
    const nextStep = computeStepWindows(
      procedure.csvDataMinDate,
      nextIdx,
      config
    );
    // End if no OOS rows are available in the next window.
    const nextOosRows = rowsInDateRange(
      rows,
      config.dateCol,
      nextStep.effOosStart,
      nextStep.effOosEnd
    );
    if (nextOosRows.length === 0 || nextStep.effOosStart > procedure.csvDataMaxDate) {
      onUpdate({ ...procedure, phase: "complete" });
      return;
    }
    onUpdate({
      ...procedure,
      steps: [
        ...procedure.steps,
        { ...nextStep, committed: false, leadingVersionId: null },
      ],
      currentStepIdx: nextIdx,
      phase: "is_explore",
    });
  };

  const totalStepsSoFar = procedure.steps.length;
  const readOnly = phase === "oos_visible";

  return (
    <>
      <ProcedureHeader
        procedure={procedure}
        onDiscardRequested={() => setShowDiscardConfirm(true)}
      />

      {showDiscardConfirm && (
        <DiscardConfirm
          onConfirm={() => {
            setShowDiscardConfirm(false);
            onUpdate(null);
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}

      {/* Step window banner */}
      <div style={s.card}>
        <div style={s.h2}>
          Step {currentStepIdx + 1} —{" "}
          {phase === "is_explore" ? "In-Sample Exploration" : "OOS Revealed"}
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12 }}>
          <div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>
              IN-SAMPLE WINDOW
            </div>
            <div>
              <strong style={{ color: theme.accent }}>{step.effIsStart}</strong>{" "}
              →{" "}
              <strong style={{ color: theme.accent }}>{step.effIsEnd}</strong>
            </div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>
              {isRows.length} rows
              {config.embargoDays > 0 &&
                ` (raw ${step.isStart} → ${step.isEnd}, embargoed ${config.embargoDays}/edge)`}
            </div>
          </div>
          <div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>
              OOS STEP WINDOW
            </div>
            <div>
              <strong style={{ color: theme.gold }}>{step.effOosStart}</strong>{" "}
              →{" "}
              <strong style={{ color: theme.gold }}>{step.effOosEnd}</strong>
            </div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>
              {oosRows.length} rows {readOnly ? "(revealed)" : "(locked)"}
            </div>
          </div>
          <div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>VERSIONS</div>
            <div>
              <strong>{procedure.versions.length}</strong>
              {leadingVersion && (
                <>
                  {" "}
                  (leading: {leadingVersion.id})
                </>
              )}
            </div>
            <div style={{ color: theme.textMuted, fontSize: 11 }}>
              Steps completed: {totalStepsSoFar - (phase === "is_explore" ? 1 : 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Filter UI — editable in explore, read-only in oos_visible */}
      <FilterControls
        draft={draft}
        setDraft={setDraft}
        columns={Object.keys(rows[0] || {})}
        outcomeCols={config.outcomeCols}
        activeGroupIdx={activeGroupIdx}
        setActiveGroupIdx={setActiveGroupIdx}
        newFilter={newFilter}
        setNewFilter={setNewFilter}
        readOnly={readOnly}
        leadingVersion={leadingVersion}
        groupByCol={groupByCol}
        setGroupByCol={setGroupByCol}
        groupKeyMode={groupKeyMode}
        setGroupKeyMode={setGroupKeyMode}
      />

      {/* Live IS results during exploration */}
      {phase === "is_explore" && isLiveResults && (
        <div style={s.card}>
          <div style={s.h2}>
            In-Sample Results (live — not locked until you commit)
          </div>
          {isLiveResults.type === "ungrouped" ? (
            <OutcomeMetricsTable
              perOutcome={isLiveResults.perOutcome}
              outcomeCols={config.outcomeCols}
            />
          ) : (
            config.outcomeCols.map((oc) => (
              <GroupedOutcomeTable
                key={oc}
                grouped={isLiveResults.grouped}
                keys={isLiveResults.keys}
                outcomeCol={oc}
                groupByCol={groupByCol}
              />
            ))
          )}
          <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 8 }}>
            After filters: <strong>{isLiveResults.afterFilterCount}</strong> of{" "}
            {isRows.length} rows
            {isLiveResults.overlapActive && " · overlap filter active"}
          </div>
        </div>
      )}

      {/* Optimizer pre-commit preview (IS exploration phase) */}
      {phase === "is_explore" &&
        procedure.optimizer &&
        procedure.optimizer.enabled && (
          <div style={s.card}>
            <div style={s.h2}>Auto-Optimizer (will run on commit)</div>
            <p style={{ color: theme.textMuted, fontSize: 11, marginBottom: 6 }}>
              {optimizerPreview ? (
                <>
                  Search domain: <strong>{optimizerPreview.domainSize}</strong>{" "}
                  IS rows after fixed filters (of{" "}
                  {optimizerPreview.isRows} total IS rows).{" "}
                </>
              ) : null}
              {procedure.optimizer.candidates.length} candidate parameter
              {procedure.optimizer.candidates.length === 1 ? "" : "s"} ·
              top-K = {procedure.optimizer.topK} · weights{" "}
              {procedure.optimizer.weights.rpt.toFixed(2)} /
              {procedure.optimizer.weights.net.toFixed(2)} /
              {procedure.optimizer.weights.dd.toFixed(2)}
            </p>
            <p style={{ color: theme.textMuted, fontSize: 11 }}>
              Runs automatically when you commit. The optimizer's per-outcome
              winners will be revealed alongside the manual OOS results.
            </p>
          </div>
        )}

      {/* Commit button in explore phase */}
      {phase === "is_explore" && (
        <div style={s.card}>
          {optimizing && (
            <div
              style={{
                color: theme.gold,
                fontSize: 12,
                marginBottom: 10,
              }}
            >
              ⏳ Running auto-optimizer… this may take a few seconds.
            </div>
          )}
          <CommitPanel
            draft={draft}
            leadingVersion={leadingVersion}
            onCommit={handleCommit}
          />
        </div>
      )}

      {/* OOS reveal */}
      {phase === "oos_visible" && stepResults && (
        <OosRevealPanel
          stepResults={stepResults}
          versions={procedure.versions}
          outcomeCols={config.outcomeCols}
          leadingVersionId={step.leadingVersionId}
          oosRowCount={oosRows.length}
          onAdvance={handleAdvance}
        />
      )}

      {/* Auto-optimizer step results (visible in OOS reveal phase) */}
      {phase === "oos_visible" &&
        procedure.optimizer &&
        procedure.optimizer.enabled &&
        optimizerResultsForStep && (
          <OptimizerStepPanel
            stepResult={optimizerResultsForStep}
            outcomeCols={config.outcomeCols}
            csvName={procedure.csvName}
            stepIdx={currentStepIdx}
          />
        )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FILTER CONTROLS (used in step view, also as read-only in OOS phase)
// ═══════════════════════════════════════════════════════════════════
function FilterControls({
  draft,
  setDraft,
  columns,
  outcomeCols,
  activeGroupIdx,
  setActiveGroupIdx,
  newFilter,
  setNewFilter,
  readOnly,
  leadingVersion,
  groupByCol,
  setGroupByCol,
  groupKeyMode,
  setGroupKeyMode,
  hideDailyLossLimit,
  title,
}) {
  // Toggles the paste-filters JSON modal. Only relevant when the panel is
  // editable (readOnly suppresses the trigger button below).
  const [showPasteModal, setShowPasteModal] = useState(false);

  const updateGroups = (updater) =>
    setDraft((prev) => ({ ...prev, filterGroups: updater(prev.filterGroups) }));

  const addFilter = () => {
    if (!newFilter.column) return;
    if (
      !["not_empty", "empty"].includes(newFilter.operator) &&
      !newFilter.value
    )
      return;
    updateGroups((gs) => {
      const next = gs.map((g) => [...g]);
      next[activeGroupIdx] = [
        ...next[activeGroupIdx],
        { ...newFilter, id: Date.now() },
      ];
      return next;
    });
    // Intentionally NOT resetting newFilter — values persist so the user can
    // add the same filter to multiple OR groups without retyping.
  };

  const removeFilter = (gi, id) =>
    updateGroups((gs) => {
      const next = gs.map((g) => [...g]);
      next[gi] = next[gi].filter((f) => f.id !== id);
      if (next[gi].length === 0 && next.length > 1) {
        next.splice(gi, 1);
        if (activeGroupIdx >= next.length) setActiveGroupIdx(next.length - 1);
      }
      return next;
    });

  const addGroup = () => {
    updateGroups((gs) => [...gs, []]);
    setActiveGroupIdx(draft.filterGroups.length);
  };

  const removeGroup = (gi) =>
    updateGroups((gs) => {
      if (gs.length <= 1) return [[]];
      const next = [...gs];
      next.splice(gi, 1);
      if (activeGroupIdx >= next.length) setActiveGroupIdx(next.length - 1);
      return next;
    });

  const dll = draft.dailyLossLimit || {};
  const ov = draft.overlap || { enabled: false, exitMap: {} };

  const setDllField = (field, val) =>
    setDraft((p) => ({
      ...p,
      dailyLossLimit: { ...(p.dailyLossLimit || {}), [field]: val },
    }));
  const setOvField = (field, val) =>
    setDraft((p) => ({ ...p, overlap: { ...(p.overlap || {}), [field]: val } }));
  const setOvExitMap = (oc, val) =>
    setDraft((p) => ({
      ...p,
      overlap: {
        ...(p.overlap || {}),
        exitMap: { ...((p.overlap && p.overlap.exitMap) || {}), [oc]: val },
      },
    }));

  const disabledStyle = readOnly
    ? { pointerEvents: "none", opacity: 0.6 }
    : {};

  return (
    <div style={s.card}>
      <div
        style={{
          ...s.h2,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span>
          {title ?? (readOnly ? "Committed Filters (read-only)" : "Filters")}
          {leadingVersion && !readOnly && (
            <span
              style={{
                marginLeft: 12,
                color: theme.textMuted,
                fontSize: 11,
                textTransform: "none",
                fontWeight: 400,
              }}
            >
              Pre-seeded from leading version {leadingVersion.id} — edit
              freely; committing unchanged re-uses {leadingVersion.id}.
            </span>
          )}
        </span>
        {!readOnly && (
          <button
            style={{
              ...s.btnOutline,
              fontSize: 11,
              textTransform: "none",
              letterSpacing: "normal",
              fontWeight: 400,
            }}
            onClick={() => setShowPasteModal(true)}
          >
            Paste filters JSON
          </button>
        )}
      </div>

      <div style={disabledStyle}>
        {/* Filter groups */}
        {(draft.filterGroups || [[]]).map((group, gi) => (
          <div
            key={gi}
            style={{
              background:
                gi === activeGroupIdx ? theme.surfaceAlt : "transparent",
              border: `1px solid ${
                gi === activeGroupIdx ? theme.accent : theme.border
              }`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 10,
              cursor: readOnly ? "default" : "pointer",
            }}
            onClick={() => !readOnly && setActiveGroupIdx(gi)}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: group.length > 0 ? 8 : 0,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: theme.textMuted,
                  fontWeight: 600,
                }}
              >
                {gi > 0 && (
                  <span style={{ color: theme.gold, marginRight: 8 }}>OR</span>
                )}
                GROUP {gi + 1}{" "}
                {group.length === 0 && (
                  <span style={{ fontWeight: 400 }}>(empty)</span>
                )}
              </span>
              {(draft.filterGroups || []).length > 1 && !readOnly && (
                <button
                  style={s.btnDanger}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeGroup(gi);
                  }}
                >
                  Remove Group
                </button>
              )}
            </div>
            {group.length > 0 && (
              <div>
                {group.map((f, fi) => (
                  <span
                    key={f.id ?? fi}
                    style={{
                      ...s.tag,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: readOnly ? "default" : "pointer",
                    }}
                    onClick={(e) => {
                      if (readOnly) return;
                      e.stopPropagation();
                      setNewFilter({
                        column: f.column,
                        operator: f.operator,
                        value: f.value || "",
                      });
                    }}
                  >
                    {fi > 0 && (
                      <span style={{ color: theme.textMuted, marginRight: 4 }}>
                        AND
                      </span>
                    )}
                    <strong>{f.column}</strong>{" "}
                    {OPERATORS.find((o) => o.value === f.operator)?.label}{" "}
                    {f.value}
                    {!readOnly && (
                      <span
                        style={{
                          cursor: "pointer",
                          color: theme.red,
                          marginLeft: 4,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFilter(gi, f.id);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {!readOnly && (
          <>
            <div style={{ ...s.row, marginBottom: 12 }}>
              <div>
                <label style={s.label}>Column</label>
                <select
                  style={s.select}
                  value={newFilter.column}
                  onChange={(e) =>
                    setNewFilter((p) => ({ ...p, column: e.target.value }))
                  }
                >
                  <option value="">Select...</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={s.label}>Operator</label>
                <select
                  style={s.select}
                  value={newFilter.operator}
                  onChange={(e) =>
                    setNewFilter((p) => ({ ...p, operator: e.target.value }))
                  }
                >
                  {OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {!["not_empty", "empty"].includes(newFilter.operator) && (
                <div>
                  <label style={s.label}>
                    Value {newFilter.operator === "between" && "(lo, hi)"}
                  </label>
                  {DOW_OPERATORS.includes(newFilter.operator) ? (
                    <select
                      style={s.select}
                      value={newFilter.value}
                      onChange={(e) =>
                        setNewFilter((p) => ({ ...p, value: e.target.value }))
                      }
                    >
                      <option value="">Select...</option>
                      {DOW_LABELS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={s.input}
                      value={newFilter.value}
                      onChange={(e) =>
                        setNewFilter((p) => ({ ...p, value: e.target.value }))
                      }
                      placeholder={
                        newFilter.operator === "between" ? "10, 50" : "value"
                      }
                    />
                  )}
                </div>
              )}
              <button style={s.btn} onClick={addFilter}>
                Add to Group {activeGroupIdx + 1}
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <button style={s.btnOutline} onClick={addGroup}>
                + Add OR Group
              </button>
            </div>
          </>
        )}

        {/* Group-by (view-only, NOT locked in version) */}
        {!readOnly && setGroupByCol && (
          <div
            style={{
              borderTop: `1px solid ${theme.border}`,
              marginTop: 16,
              paddingTop: 16,
            }}
          >
            <div style={s.row}>
              <div>
                <label style={s.label}>
                  Group By (view only — not part of version)
                </label>
                <select
                  style={s.select}
                  value={groupByCol}
                  onChange={(e) => setGroupByCol(e.target.value)}
                >
                  <option value="">No grouping</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              {groupByCol && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: theme.text,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={groupKeyMode === "hour"}
                    onChange={(e) =>
                      setGroupKeyMode(e.target.checked ? "hour" : "raw")
                    }
                  />
                  Group by hour
                </label>
              )}
              {groupByCol && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: theme.text,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={groupKeyMode === "dow"}
                    onChange={(e) =>
                      setGroupKeyMode(e.target.checked ? "dow" : "raw")
                    }
                  />
                  Group by day of week
                </label>
              )}
              {groupByCol && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: theme.text,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={groupKeyMode === "wom"}
                    onChange={(e) =>
                      setGroupKeyMode(e.target.checked ? "wom" : "raw")
                    }
                  />
                  Group by week of month
                </label>
              )}
              {groupByCol && (
                <button
                  style={s.btnOutline}
                  onClick={() => {
                    setGroupByCol("");
                    setGroupKeyMode("raw");
                  }}
                >
                  Clear Grouping
                </button>
              )}
            </div>
          </div>
        )}

        {/* Daily loss limit */}
        {!hideDailyLossLimit && (
        <div
          style={{
            borderTop: `1px solid ${theme.border}`,
            marginTop: 16,
            paddingTop: 16,
          }}
        >
          <label style={{ ...s.label, marginBottom: 8 }}>
            Daily / Session Loss Limit
          </label>
          <div style={s.row}>
            <div>
              <label style={s.label}>Date Column</label>
              <select
                style={s.select}
                value={dll.col || ""}
                onChange={(e) => setDllField("col", e.target.value)}
              >
                <option value="">None (disabled)</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={s.label}>Max Losses</label>
              <input
                style={{ ...s.input, width: 80 }}
                type="number"
                min="1"
                value={dll.value || ""}
                onChange={(e) => setDllField("value", e.target.value)}
              />
            </div>
            <div>
              <label style={s.label}>Bar Time Col (optional)</label>
              <select
                style={s.select}
                value={dll.timeCol || ""}
                onChange={(e) => setDllField("timeCol", e.target.value)}
              >
                <option value="">None (by date)</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={s.label}>Session Start (HHMM)</label>
              <input
                style={{ ...s.input, width: 100 }}
                type="text"
                placeholder="e.g. 1800"
                value={dll.sessionStart || ""}
                onChange={(e) => setDllField("sessionStart", e.target.value)}
              />
            </div>
            <div>
              <label style={s.label}>Loss Time Col (optional)</label>
              <select
                style={s.select}
                value={dll.lossTimeCol || ""}
                onChange={(e) => setDllField("lossTimeCol", e.target.value)}
              >
                <option value="">None (loss = entry time)</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {dll.col && dll.value && (
            <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 6 }}>
              {dll.lossTimeCol && dll.timeCol && dll.sessionStart
                ? `Loss-time-aware: a trade is excluded only if losses already realized (per the loss time column) reach the limit BEFORE the trade enters. Trades already open when the limit is hit keep running and their losses still register.`
                : `Legacy mode: losses are treated as realized at entry time. To respect overlapping positions where multiple trades may already be open before the first loss is realized, set Bar Time Col + Session Start + Loss Time Col together.`}
            </p>
          )}
        </div>
        )}

        {/* Overlap filter */}
        <div
          style={{
            borderTop: `1px solid ${theme.border}`,
            marginTop: 16,
            paddingTop: 16,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: theme.text,
              cursor: readOnly ? "default" : "pointer",
              marginBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={!!ov.enabled}
              onChange={(e) => setOvField("enabled", e.target.checked)}
              disabled={readOnly}
            />
            <span
              style={{
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: theme.textMuted,
                fontSize: 11,
              }}
            >
              Overlap Filter
            </span>
          </label>
          {ov.enabled && (
            <div
              style={{
                background: theme.surfaceAlt,
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                padding: 12,
              }}
            >
              <div style={{ ...s.row, marginBottom: 10 }}>
                <div>
                  <label style={s.label}>Entry Date Column</label>
                  <select
                    style={s.select}
                    value={ov.entryDateCol || ""}
                    onChange={(e) => setOvField("entryDateCol", e.target.value)}
                  >
                    <option value="">Select...</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={s.label}>Entry Time Column</label>
                  <select
                    style={s.select}
                    value={ov.entryTimeCol || ""}
                    onChange={(e) => setOvField("entryTimeCol", e.target.value)}
                  >
                    <option value="">Select...</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={s.label}>Loss DateTime Column</label>
                  <select
                    style={s.select}
                    value={ov.lossTimeCol || ""}
                    onChange={(e) => setOvField("lossTimeCol", e.target.value)}
                  >
                    <option value="">Select...</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={s.label}>Exit DateTime per Outcome</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {outcomeCols.map((oc) => (
                    <div key={oc}>
                      <label style={{ ...s.label, color: theme.green }}>
                        {oc}
                      </label>
                      <select
                        style={s.select}
                        value={(ov.exitMap || {})[oc] || ""}
                        onChange={(e) => setOvExitMap(oc, e.target.value)}
                      >
                        <option value="">Select...</option>
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              <div style={s.row}>
                <div>
                  <label style={s.label}>Mode</label>
                  <select
                    style={s.select}
                    value={ov.mode || "always"}
                    onChange={(e) => setOvField("mode", e.target.value)}
                  >
                    <option value="always">Exclude all overlapping</option>
                    <option value="excludeIfMatch">
                      Exclude if compare column MATCHES
                    </option>
                    <option value="excludeIfDiffer">
                      Exclude if compare column DIFFERS
                    </option>
                  </select>
                </div>
                {ov.mode !== "always" && (
                  <div>
                    <label style={s.label}>Compare Column</label>
                    <select
                      style={s.select}
                      value={ov.compareCol || ""}
                      onChange={(e) => setOvField("compareCol", e.target.value)}
                    >
                      <option value="">Select...</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label
                    style={s.label}
                    title="Bar timestamps name the open of the bar; entries fire at close. Set this to the bar duration in minutes (e.g., 60 for 60-min bars, 90 for 90-min bars) so overlap compares by actual entry time."
                  >
                    Entry Offset (min)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    style={{ ...s.input, width: 100 }}
                    value={ov.entryOffsetMinutes ?? 0}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setOvField("entryOffsetMinutes", Number.isFinite(n) && n >= 0 ? n : 0);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {showPasteModal && (
        <FiltersPasteModal
          columns={columns}
          onApply={(filters) => {
            // cloneFiltersForDraft re-runs JSON.parse(JSON.stringify) and
            // assigns fresh ids — keeps draft shape consistent with what
            // the rest of FilterControls expects, even though normalize
            // already produced a complete object.
            setDraft(cloneFiltersForDraft(filters));
            setActiveGroupIdx(0);
            setNewFilter({ column: "", operator: "equals", value: "" });
            setShowPasteModal(false);
          }}
          onCancel={() => setShowPasteModal(false)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMMIT PANEL (shows the "new version will be created" vs "reuse" hint)
// ═══════════════════════════════════════════════════════════════════
function CommitPanel({ draft, leadingVersion, onCommit }) {
  const draftHash = canonicalFilters(draft);
  const willCreateNew =
    !leadingVersion || leadingVersion.filtersHash !== draftHash;
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div style={{ marginBottom: 12, fontSize: 12 }}>
        {willCreateNew ? (
          <span style={{ color: theme.gold }}>
            ⚠ Committing will create a <strong>new version</strong>
            {leadingVersion && (
              <>
                {" "}
                and deprecate <strong>{leadingVersion.id}</strong> at this step.
                From the next step on, {leadingVersion.id} will be shadow-tracked.
              </>
            )}
          </span>
        ) : (
          <span style={{ color: theme.green }}>
            ✓ Filters match <strong>{leadingVersion.id}</strong> — committing
            will re-use that version for this step.
          </span>
        )}
      </div>
      {!confirming ? (
        <button
          style={{
            ...s.btn,
            background: willCreateNew ? theme.gold : theme.accent,
            color: willCreateNew ? "#0f1117" : "#fff",
          }}
          onClick={() => setConfirming(true)}
        >
          Commit Filters & Reveal OOS
        </button>
      ) : (
        <div
          style={{
            background: theme.surfaceAlt,
            border: `1px solid ${theme.red}`,
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
          }}
        >
          <div style={{ marginBottom: 10 }}>
            <strong style={{ color: theme.red }}>Final commit.</strong> You
            cannot edit these filters for this step after revealing OOS. Proceed?
          </div>
          <button
            style={{ ...s.btn, marginRight: 8 }}
            onClick={onCommit}
          >
            Yes — Commit & Reveal
          </button>
          <button style={s.btnOutline} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OOS REVEAL PANEL
// ═══════════════════════════════════════════════════════════════════
function OosRevealPanel({
  stepResults,
  versions,
  outcomeCols,
  leadingVersionId,
  oosRowCount,
  onAdvance,
}) {
  // Order: leading first, then deprecated in reverse-chronological order
  const versionOrder = [];
  const leading = versions.find((v) => v.id === leadingVersionId);
  if (leading) versionOrder.push(leading);
  const deprecated = versions
    .filter((v) => v.deprecatedAtStepIdx !== null)
    .sort((a, b) => b.createdAtStepIdx - a.createdAtStepIdx);
  for (const v of deprecated) if (v.id !== leadingVersionId) versionOrder.push(v);

  return (
    <div style={s.card}>
      <div style={s.h2}>OOS Results (step locked)</div>
      <p style={{ color: theme.textMuted, fontSize: 11, marginBottom: 16 }}>
        {oosRowCount} OOS rows in this step. Each row below is one version's
        result. Deprecated versions are shadow-tracked — they show what you
        would have gotten had you not changed filters.
      </p>

      {versionOrder.map((v) => {
        const r = stepResults[v.id];
        if (!r) return null;
        return (
          <div
            key={v.id}
            style={{
              border: `1px solid ${
                v.id === leadingVersionId ? theme.accent : theme.border
              }`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              background: v.id === leadingVersionId ? theme.surfaceAlt : "transparent",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                {v.id}
                {v.id === leadingVersionId ? (
                  <span
                    style={{
                      ...s.tag,
                      marginLeft: 8,
                      borderColor: theme.accent,
                      color: theme.accent,
                    }}
                  >
                    LEADING
                  </span>
                ) : (
                  <span
                    style={{
                      ...s.tag,
                      marginLeft: 8,
                      borderColor: theme.textMuted,
                      color: theme.textMuted,
                    }}
                  >
                    SHADOW
                  </span>
                )}
              </span>
              <span style={{ color: theme.textMuted, fontSize: 11 }}>
                After filters: {r.afterFilterCount} rows
              </span>
            </div>
            <OutcomeMetricsTable
              perOutcome={r.perOutcome}
              outcomeCols={outcomeCols}
            />
          </div>
        );
      })}

      <button style={s.btn} onClick={onAdvance}>
        Next Step →
      </button>
      <span style={{ color: theme.textMuted, fontSize: 11, marginLeft: 12 }}>
        Advancing rolls the IS window forward by one OOS step. This step's
        results are now part of the permanent record.
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZER STEP PANEL
// ═══════════════════════════════════════════════════════════════════
// Shows per-outcome winners on the current step: chosen filters, IS metrics
// (what was scored) and OOS metrics (revealed alongside manual OOS).
function OptimizerStepPanel({ stepResult, outcomeCols, csvName, stepIdx }) {
  const [expanded, setExpanded] = useState({});
  const csvBase = (csvName || "procedure").replace(/\.csv$/i, "");
  return (
    <div style={s.card}>
      <div style={s.h2}>
        Auto-Optimizer Results (step locked)
        <span
          style={{
            marginLeft: 12,
            color: theme.textMuted,
            fontSize: 11,
            textTransform: "none",
            fontWeight: 400,
          }}
        >
          Domain: {stepResult.domainSize} IS rows ·{" "}
          {stepResult.candidatesEvaluated} pipeline runs
        </span>
      </div>
      {outcomeCols.map((oc) => {
        const r = stepResult.perOutcome[oc];
        if (!r) return null;
        const isExp = !!expanded[oc];
        return (
          <div
            key={oc}
            style={{
              border: `1px solid ${theme.gold}`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              background: theme.surfaceAlt,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                AUTO · {oc}
                <span
                  style={{
                    ...s.tag,
                    marginLeft: 8,
                    borderColor: theme.gold,
                    color: theme.gold,
                  }}
                >
                  WINNER
                </span>
              </span>
              <span style={{ color: theme.textMuted, fontSize: 11 }}>
                IS: {r.isRowCount} rows · OOS: {r.oosRowCount} rows · score{" "}
                {r.score.toFixed(3)}
              </span>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: theme.textMuted }}>
                Picked filters
              </div>
              <div style={{ fontSize: 12 }}>
                {r.candidatesUsed.length === 0 ? (
                  <em style={{ color: theme.textMuted }}>
                    Baseline (fixed filters only — no candidate beat baseline)
                  </em>
                ) : (
                  r.candidatesUsed.map((label, i) => (
                    <span key={i} style={{ ...s.tag, marginRight: 4 }}>
                      {label}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div style={{ ...s.h3, marginBottom: 4, fontSize: 11 }}>
              In-Sample (scored)
            </div>
            <OutcomeMetricsTable
              perOutcome={{ [oc]: { metrics: r.isMetrics } }}
              outcomeCols={[oc]}
            />
            <div
              style={{ ...s.h3, marginTop: 8, marginBottom: 4, fontSize: 11 }}
            >
              Out-of-Sample (revealed)
            </div>
            <OutcomeMetricsTable
              perOutcome={{ [oc]: { metrics: r.oosMetrics } }}
              outcomeCols={[oc]}
            />
            <div
              style={{
                marginTop: 8,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                style={s.btnOutline}
                onClick={() =>
                  setExpanded((p) => ({ ...p, [oc]: !p[oc] }))
                }
              >
                {isExp ? "Hide locked filters" : "View locked filters"}
              </button>
              <button
                style={s.btnOutline}
                onClick={() =>
                  downloadFiltersJsonTxt(
                    r.filters,
                    `procedure_auto_${oc}_step${stepIdx + 1}_filters_${csvBase}`
                  )
                }
              >
                Download filters (.txt)
              </button>
            </div>
            {isExp && (
              <pre
                style={{
                  marginTop: 8,
                  background: theme.bg,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  padding: 10,
                  fontSize: 11,
                  overflow: "auto",
                  color: theme.text,
                }}
              >
                {JSON.stringify(r.filters, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMPLETE SCREEN
// ═══════════════════════════════════════════════════════════════════
function CompleteScreen({ rows, procedure, onDiscard }) {
  const { versions, results, steps, config } = procedure;

  // Aggregate view mode:
  //   true  (default) → "lineage": each version's series includes the slices
  //                     of predecessors that were leading before it (walked
  //                     via step.leadingVersionId), capped at this version's
  //                     deprecation step. The leading-final version covers
  //                     the full timeline.
  //   false           → "shadow": each version's series is its own results
  //                     across every step it was tracked (current behavior;
  //                     deprecated versions continue to be shadow-tracked
  //                     past their replacement, which is useful for
  //                     "would V1 alone have done?" counterfactual reading).
  const [showLineage, setShowLineage] = useState(true);

  // For each (version, outcome) concatenate the OOS return series across
  // every relevant step.
  //   shadow  → use V's own results at every step it was tracked.
  //   lineage → for steps BEFORE V was created, pull whoever was leading
  //             then (step.leadingVersionId) — that's the predecessor
  //             chain. For steps from V.createdAtStepIdx onward, pull V's
  //             own results (which spans both V's leading period and any
  //             shadow-tracked period after V was deprecated).
  const perVersionSeries = useMemo(() => {
    const out = {};
    const stepIndices = Object.keys(results)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    for (const v of versions) {
      const byOutcome = {};
      for (const oc of config.outcomeCols) {
        const all = [];
        for (const stepIdx of stepIndices) {
          let activeId;
          if (showLineage) {
            if (stepIdx < v.createdAtStepIdx) {
              // Predecessor slice: whoever was leading at this step.
              const st = steps[stepIdx];
              if (!st || !st.leadingVersionId) continue;
              activeId = st.leadingVersionId;
            } else {
              // V's own track from creation onward (leading + shadow).
              activeId = v.id;
            }
          } else {
            activeId = v.id;
          }
          const series =
            results[stepIdx]?.[activeId]?.perOutcome?.[oc]?.returnSeries;
          if (Array.isArray(series)) all.push(...series);
        }
        byOutcome[oc] = all;
      }
      out[v.id] = byOutcome;
    }
    return out;
  }, [versions, results, steps, config.outcomeCols, showLineage]);

  const aggregates = useMemo(() => {
    const out = {};
    for (const v of versions) {
      const byOutcome = {};
      for (const oc of config.outcomeCols) {
        byOutcome[oc] = calcMetrics(perVersionSeries[v.id][oc]);
      }
      out[v.id] = byOutcome;
    }
    return out;
  }, [versions, perVersionSeries, config.outcomeCols]);

  // Chart line seed offset.
  //   lineage → 0 for everyone (each line already includes its predecessors,
  //             so the curve naturally starts at zero on step 0).
  //   shadow  → predecessor's cumulative R at the step before V was created
  //             (gives visual continuity even though V's series is its own).
  // Versions are stored in creation order, so seeds[pred.id] is already
  // known when we process V.
  const seedByVersion = useMemo(() => {
    const seeds = {};
    if (showLineage) {
      for (const v of versions) {
        seeds[v.id] = {};
        for (const oc of config.outcomeCols) seeds[v.id][oc] = 0;
      }
      return seeds;
    }
    for (const v of versions) {
      seeds[v.id] = {};
      const pred = versions.find(
        (p) => p.deprecatedAtStepIdx === v.createdAtStepIdx
      );
      for (const oc of config.outcomeCols) {
        if (!pred) {
          seeds[v.id][oc] = 0;
          continue;
        }
        let s = (seeds[pred.id] || {})[oc] || 0;
        for (let stepIdx = 0; stepIdx < v.createdAtStepIdx; stepIdx++) {
          const stepRes = results[stepIdx];
          const entry = stepRes && stepRes[pred.id];
          const series = entry && entry.perOutcome?.[oc]?.returnSeries;
          if (Array.isArray(series)) {
            for (const e of series) s += e.value;
          }
        }
        seeds[v.id][oc] = s;
      }
    }
    return seeds;
  }, [showLineage, versions, results, config.outcomeCols]);

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [inspectVersion, setInspectVersion] = useState(null);
  const [chartOutcome, setChartOutcome] = useState(
    config.outcomeCols[0] || ""
  );
  // Disables the Download-all button while JSZip is generating the blob,
  // so a user double-clicking doesn't kick off two parallel zip jobs.
  const [zipping, setZipping] = useState(false);

  // When the auto-optimizer is on, append a synthetic "AUTO" pseudo-version
  // and merge its concatenated OOS series so the main chart shows manual
  // versions and the optimizer track together. AUTO has no predecessor and
  // no shadow lineage — it's its own track from step 0, seed = 0.
  const optimizerEnabled =
    procedure.optimizer && procedure.optimizer.enabled;
  const chartVersions = useMemo(() => {
    if (!optimizerEnabled) return versions;
    return [
      ...versions,
      {
        id: "AUTO",
        createdAtStepIdx: 0,
        deprecatedAtStepIdx: null,
        filters: null,
      },
    ];
  }, [optimizerEnabled, versions]);

  const chartSeries = useMemo(() => {
    if (!optimizerEnabled) return perVersionSeries;
    const optResults = procedure.optimizerResults || {};
    const stepIndices = Object.keys(optResults)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    const auto = {};
    for (const oc of config.outcomeCols) {
      const all = [];
      for (const stepIdx of stepIndices) {
        const r = optResults[stepIdx];
        if (!r || !r.perOutcome[oc]) continue;
        const series = r.perOutcome[oc].oosReturnSeries;
        if (Array.isArray(series)) all.push(...series);
      }
      auto[oc] = all;
    }
    return { ...perVersionSeries, AUTO: auto };
  }, [optimizerEnabled, perVersionSeries, procedure.optimizerResults, config.outcomeCols]);

  return (
    <>
      <ProcedureHeader
        procedure={procedure}
        onDiscardRequested={() => setShowDiscardConfirm(true)}
      />

      {showDiscardConfirm && (
        <DiscardConfirm
          onConfirm={() => {
            setShowDiscardConfirm(false);
            onDiscard();
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}

      <div style={s.card}>
        <div style={s.h2}>Procedure Complete</div>
        <div style={{ fontSize: 12, marginBottom: 10 }}>
          {steps.length} step{steps.length === 1 ? "" : "s"} completed ·{" "}
          {versions.length} version{versions.length === 1 ? "" : "s"}
        </div>

        {/* Download-all .zip — bundles every version's CSV + filters .txt
            in the currently-active toggle's view, plus per-outcome
            optimizer CSV + per-step filters .txt when the optimizer was
            enabled. */}
        <div style={{ marginBottom: 12 }}>
          <button
            style={{
              ...s.btn,
              opacity: zipping ? 0.6 : 1,
              cursor: zipping ? "wait" : "pointer",
            }}
            disabled={zipping}
            onClick={async () => {
              if (zipping) return;
              setZipping(true);
              try {
                await downloadProcedureZip(
                  procedure,
                  rows,
                  showLineage ? "lineage" : "shadow"
                );
              } catch (err) {
                console.error("Zip generation failed:", err);
                alert(
                  "Failed to build .zip — see console for details."
                );
              } finally {
                setZipping(false);
              }
            }}
          >
            {zipping
              ? "Generating .zip…"
              : `Download all (${
                  showLineage ? "lineage" : "shadow"
                } view, .zip)`}
          </button>
          <span
            style={{
              color: theme.textMuted,
              fontSize: 11,
              marginLeft: 10,
            }}
          >
            Bundles every version's CSV + filters .txt for the active view
            {procedure.optimizer && procedure.optimizer.enabled
              ? ", plus the auto-optimizer's per-outcome CSV + per-step filters .txt."
              : "."}
          </span>
        </div>

        {/* Aggregate view toggle — affects metrics tables, equity chart,
            and the per-version CSV / filters downloads. */}
        <div
          style={{
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            padding: 10,
            marginBottom: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600 }}>
            AGGREGATE VIEW
          </span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              cursor: "pointer",
              color: theme.text,
            }}
          >
            <input
              type="radio"
              name="aggregate-view"
              checked={showLineage}
              onChange={() => setShowLineage(true)}
            />
            Include previous version results (lineage)
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              cursor: "pointer",
              color: theme.text,
            }}
          >
            <input
              type="radio"
              name="aggregate-view"
              checked={!showLineage}
              onChange={() => setShowLineage(false)}
            />
            Show this version only (shadow)
          </label>
          <span
            style={{ color: theme.textMuted, fontSize: 11, flex: "1 1 100%" }}
          >
            {showLineage
              ? "Each version's metrics chain its predecessors' leading slices, then continue with this version's own track from creation through the end of the procedure (its leading period plus any shadow-tracked period after deprecation)."
              : "Each version's metrics use only its own results across every step it was tracked. Deprecated versions keep accruing shadow data after replacement."}
          </span>
        </div>

        {/* Equity chart */}
        {config.outcomeCols.length > 0 && (
          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div style={s.h3}>Cumulative OOS Return — {chartOutcome}</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {config.outcomeCols.map((oc) => (
                  <button
                    key={oc}
                    style={s.chip(oc === chartOutcome)}
                    onClick={() => setChartOutcome(oc)}
                  >
                    {oc}
                  </button>
                ))}
              </div>
            </div>
            <EquityChart
              versions={chartVersions}
              perVersionSeries={chartSeries}
              outcome={chartOutcome}
              seedByVersion={seedByVersion}
            />
            <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 6 }}>
              X = trade date · Y = cumulative R. One line per version;
              deprecated versions continue to be shadow-tracked on every
              subsequent step. New versions begin where their predecessor
              left off, not at zero.
              {optimizerEnabled && (
                <>
                  {" "}
                  The dashed gold line is the auto-optimizer's per-step
                  winners concatenated into one OOS track.
                </>
              )}
            </div>
          </div>
        )}

        {versions.map((v) => (
          <div
            key={v.id}
            style={{
              border: `1px solid ${
                v.deprecatedAtStepIdx === null ? theme.accent : theme.border
              }`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              background:
                v.deprecatedAtStepIdx === null ? theme.surfaceAlt : "transparent",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                {v.id}
                <span
                  style={{
                    ...s.tag,
                    marginLeft: 8,
                    borderColor:
                      v.deprecatedAtStepIdx === null
                        ? theme.accent
                        : theme.textMuted,
                    color:
                      v.deprecatedAtStepIdx === null
                        ? theme.accent
                        : theme.textMuted,
                  }}
                >
                  {v.deprecatedAtStepIdx === null
                    ? "LEADING (final)"
                    : `DEPRECATED @ step ${v.deprecatedAtStepIdx + 1}`}
                </span>
              </span>
              <span style={{ color: theme.textMuted, fontSize: 11 }}>
                Introduced @ step {v.createdAtStepIdx + 1} · tracked through
                step {steps.length}
              </span>
            </div>
            <OutcomeMetricsTable
              perOutcome={Object.fromEntries(
                config.outcomeCols.map((oc) => [
                  oc,
                  { metrics: aggregates[v.id][oc] },
                ])
              )}
              outcomeCols={config.outcomeCols}
            />
            <div
              style={{
                marginTop: 8,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                style={s.btnOutline}
                onClick={() =>
                  setInspectVersion(inspectVersion === v.id ? null : v.id)
                }
              >
                {inspectVersion === v.id
                  ? "Hide filters"
                  : "View locked filters"}
              </button>
              <button
                style={s.btnOutline}
                onClick={() =>
                  exportVersionCsv(
                    v,
                    procedure,
                    rows,
                    showLineage ? "lineage" : "shadow"
                  )
                }
              >
                {showLineage
                  ? `Download lineage CSV through ${v.id}`
                  : `Download CSV of ${v.id}'s trades`}
              </button>
              <button
                style={s.btnOutline}
                onClick={() =>
                  exportFiltersTxt(
                    v,
                    procedure,
                    showLineage ? "lineage" : "shadow"
                  )
                }
              >
                {showLineage
                  ? `Download lineage filters through ${v.id} (.txt)`
                  : `Download ${v.id} filters (.txt)`}
              </button>
            </div>
            {inspectVersion === v.id && (
              <pre
                style={{
                  marginTop: 8,
                  background: theme.bg,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  padding: 10,
                  fontSize: 11,
                  overflow: "auto",
                  color: theme.text,
                }}
              >
                {JSON.stringify(v.filters, null, 2)}
              </pre>
            )}
          </div>
        ))}

        <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 12 }}>
          {showLineage ? (
            <>
              Lineage view: each version's aggregate concatenates the OOS
              series of predecessors that were leading before this version
              was created, then continues with this version's own track
              from creation onward — covering its leading period plus any
              shadow-tracked period after deprecation. CSV export tags each
              row with <code>_version_id</code> so the per-step filters
              that produced it are unambiguous, and the filters .txt
              bundles every version in the chain with its applied step
              range.
            </>
          ) : (
            <>
              Per-version (shadow) view: each version's aggregate uses only
              its own concatenated OOS return series across every step it
              was tracked — including shadow-tracked steps after deprecation.
              CSV export tags each row with the version it was scored under
              (always this version in shadow mode).
            </>
          )}{" "}
          CSV rows are those that survived the relevant pre-overlap pipeline
          (filters + daily loss limit) — overlap behavior can vary per
          outcome at view time, so it is intentionally not applied in the
          single-table export.
        </p>
      </div>

      {procedure.optimizer && procedure.optimizer.enabled && (
        <OptimizerSummary procedure={procedure} rows={rows} />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZER SUMMARY (in CompleteScreen)
// ═══════════════════════════════════════════════════════════════════
// Per outcome: equity chart of the optimizer's OOS series across all steps,
// aggregate metrics, per-step breakdown of chosen filters, CSV export.
function OptimizerSummary({ procedure, rows }) {
  const { config, optimizerResults, steps } = procedure;
  const stepIndices = useMemo(
    () =>
      Object.keys(optimizerResults || {})
        .map((k) => parseInt(k, 10))
        .sort((a, b) => a - b),
    [optimizerResults]
  );

  // Concatenate OOS return series across all steps for each outcome.
  const perOutcomeSeries = useMemo(() => {
    const out = {};
    for (const oc of config.outcomeCols) {
      const all = [];
      for (const stepIdx of stepIndices) {
        const r = optimizerResults[stepIdx];
        if (!r || !r.perOutcome[oc]) continue;
        const series = r.perOutcome[oc].oosReturnSeries;
        if (Array.isArray(series)) all.push(...series);
      }
      out[oc] = all;
    }
    return out;
  }, [config.outcomeCols, optimizerResults, stepIndices]);

  const aggregates = useMemo(() => {
    const out = {};
    for (const oc of config.outcomeCols) {
      out[oc] = calcMetrics(perOutcomeSeries[oc]);
    }
    return out;
  }, [config.outcomeCols, perOutcomeSeries]);

  return (
    <div style={s.card}>
      <div style={s.h2}>
        Auto-Optimizer Summary
        <span
          style={{
            marginLeft: 12,
            color: theme.textMuted,
            fontSize: 11,
            textTransform: "none",
            fontWeight: 400,
          }}
        >
          One winner per outcome per step. Aggregates concatenate every step's
          OOS return series. The dashed gold line on the chart above is the
          optimizer's track.
        </span>
      </div>

      {/* Per outcome: aggregate row + per-step breakdown + CSV export */}
      {config.outcomeCols.map((oc) => (
        <div
          key={oc}
          style={{
            border: `1px solid ${theme.gold}`,
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              AUTO · {oc}
              <span
                style={{
                  ...s.tag,
                  marginLeft: 8,
                  borderColor: theme.gold,
                  color: theme.gold,
                }}
              >
                FULL OOS
              </span>
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={s.btnOutline}
                onClick={() => exportOptimizerCsv(oc, procedure, rows)}
              >
                Download CSV ({oc})
              </button>
              <button
                style={s.btnOutline}
                onClick={() => exportOptimizerStepsFiltersTxt(oc, procedure)}
              >
                Download per-step filters ({oc}, .txt)
              </button>
            </div>
          </div>
          <OutcomeMetricsTable
            perOutcome={{ [oc]: { metrics: aggregates[oc] } }}
            outcomeCols={[oc]}
          />
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: theme.textMuted,
            }}
          >
            Per-step picks
          </div>
          <table style={{ ...s.table, marginTop: 4 }}>
            <thead>
              <tr>
                <th style={s.th}>Step</th>
                <th style={s.th}>Window</th>
                <th style={s.th}>Filters Picked</th>
                <th style={s.th}>OOS N</th>
                <th style={s.th}>Net R</th>
                <th style={s.th}>Max DD</th>
                <th style={s.th}>Win %</th>
              </tr>
            </thead>
            <tbody>
              {stepIndices.map((stepIdx) => {
                const r = optimizerResults[stepIdx]?.perOutcome[oc];
                if (!r) return null;
                const st = steps[stepIdx];
                const m = r.oosMetrics;
                return (
                  <tr key={stepIdx}>
                    <td style={s.td}>{stepIdx + 1}</td>
                    <td style={{ ...s.td, color: theme.textMuted, fontSize: 10 }}>
                      {st?.effOosStart} → {st?.effOosEnd}
                    </td>
                    <td style={{ ...s.td, fontSize: 10 }}>
                      {r.candidatesUsed.length === 0 ? (
                        <em style={{ color: theme.textMuted }}>baseline</em>
                      ) : (
                        r.candidatesUsed.join(" ∧ ")
                      )}
                    </td>
                    <td style={s.td}>{m.total}</td>
                    <td
                      style={{
                        ...s.td,
                        color: m.netReturn >= 0 ? theme.green : theme.red,
                      }}
                    >
                      {fmt(m.netReturn)}
                    </td>
                    <td style={{ ...s.td, color: theme.red }}>{fmt(m.maxDD)}</td>
                    <td style={s.td}>{fmtPct(m.winPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 8 }}>
        Aggregates use calcMetrics on the optimizer's concatenated OOS series
        for each outcome — same math as the manual aggregates above. CSV
        export per outcome includes only rows that survived that step's
        winning pre-overlap pipeline (filters + daily loss limit), tagged
        with the step and the labels of filters picked.
      </p>
    </div>
  );
}

// Internal helper: write content to a file-download Blob and click. Used
// by every individual export wrapper (and by the .zip composer below) so
// the Blob/createObjectURL/anchor dance lives in exactly one place.
function triggerDownload(content, filename, mime = "text/plain;charset=utf-8;") {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Each exportXxx is split into a pure buildXxx (returns {filename, content,
// mime} or null) plus a thin export wrapper that triggers the download.
// The build halves are reused by downloadProcedureZip so the same content
// goes into the .zip as into the per-button downloads — no duplicated
// pipeline math, no drift.

// Bundle the optimizer's chosen filters for a single outcome across every
// step into one JSON-formatted .txt file. Each step's entry includes the
// OOS window, candidate labels picked, and the full filter snapshot — so
// the file is a self-contained reference for what the optimizer ran on
// that outcome at every step.
function buildOptimizerStepsFiltersTxt(outcome, procedure) {
  const { optimizerResults, steps } = procedure;
  const csvBase = (procedure.csvName || "procedure").replace(/\.csv$/i, "");
  const stepIndices = Object.keys(optimizerResults || {})
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);

  const out = {};
  for (const stepIdx of stepIndices) {
    const r = optimizerResults[stepIdx]?.perOutcome[outcome];
    if (!r) continue;
    const st = steps[stepIdx];
    out[`step_${stepIdx + 1}`] = {
      window: st ? `${st.effOosStart} → ${st.effOosEnd}` : null,
      candidatesUsed: r.candidatesUsed,
      filters: r.filters,
    };
  }
  return {
    filename: `procedure_auto_${outcome}_steps_filters_${csvBase}.txt`,
    content: JSON.stringify(
      { outcome, csvName: procedure.csvName || null, steps: out },
      null,
      2
    ),
    mime: "text/plain;charset=utf-8;",
  };
}

function exportOptimizerStepsFiltersTxt(outcome, procedure) {
  const a = buildOptimizerStepsFiltersTxt(outcome, procedure);
  triggerDownload(a.content, a.filename, a.mime);
}

// CSV export for an optimizer outcome: walk every step where that outcome
// has a winner, replay the chosen pre-overlap pipeline (applyFilters + DLL)
// on the step's OOS rows, concatenate, tag each row with step idx + the
// filter labels picked. Overlap intentionally NOT applied (per-outcome,
// matches the manual exportVersionCsv convention). Returns null when no
// rows survive across the procedure for this outcome.
function buildOptimizerCsv(outcome, procedure, rows) {
  const { config, optimizerResults, steps } = procedure;
  const stepIndices = Object.keys(optimizerResults || {})
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);

  const exported = [];
  for (const stepIdx of stepIndices) {
    const r = optimizerResults[stepIdx]?.perOutcome[outcome];
    if (!r) continue;
    const st = steps[stepIdx];
    if (!st) continue;
    const filters = r.filters;
    const activeGroups = (filters.filterGroups || []).filter(
      (g) => g.length > 0
    );
    const dll = filters.dailyLossLimit;
    const limNum = dll ? parseInt(dll.value, 10) : 0;
    const sessMins = dll ? parseTimeToMinutes(dll.sessionStart) : null;
    const oosRowsRaw = rowsInDateRange(
      rows,
      config.dateCol,
      st.effOosStart,
      st.effOosEnd
    );
    const afterFilters = applyFilters(oosRowsRaw, activeGroups);
    // Per-outcome DLL: pass `outcome` so the surviving rows match the
    // outcome-specific metric calc on conflicted rows (loss + outcome both
    // populated → loss event suppressed for this outcome).
    const afterLimit = applyDailyLossLimit(
      afterFilters,
      dll ? dll.col || "" : "",
      config.lossCol,
      limNum,
      dll ? dll.timeCol || "" : "",
      sessMins,
      dll ? dll.lossTimeCol || "" : "",
      outcome
    );
    const labels = r.candidatesUsed.length === 0 ? "baseline" : r.candidatesUsed.join(" ∧ ");
    for (const row of afterLimit) {
      exported.push({
        _step_idx: stepIdx + 1,
        _outcome: outcome,
        _picked: labels,
        _oos_start: st.effOosStart,
        _oos_end: st.effOosEnd,
        ...row,
      });
    }
  }

  if (exported.length === 0) return null;

  const metaCols = ["_step_idx", "_outcome", "_picked", "_oos_start", "_oos_end"];
  const origCols = Object.keys(rows[0] || {});
  const fields = [...metaCols, ...origCols];
  const csv = Papa.unparse(exported, { columns: fields });
  const csvBase = (procedure.csvName || "procedure").replace(/\.csv$/i, "");
  return {
    filename: `procedure_auto_${outcome}_${csvBase}.csv`,
    content: csv,
    mime: "text/csv;charset=utf-8;",
  };
}

function exportOptimizerCsv(outcome, procedure, rows) {
  const a = buildOptimizerCsv(outcome, procedure, rows);
  if (!a) {
    alert(
      `No surviving OOS rows for the optimizer winner on outcome ${outcome}.`
    );
    return;
  }
  triggerDownload(a.content, a.filename, a.mime);
}

// ═══════════════════════════════════════════════════════════════════
// EQUITY CHART (SVG, no dependencies)
// ═══════════════════════════════════════════════════════════════════
// Plots cumulative R over time. One line per version. X = ISO date
// (linear on epoch-seconds). Y = cumulative R. Versions are colored
// from a fixed palette; legend shows the final cumulative R per version.
function EquityChart({ versions, perVersionSeries, outcome, seedByVersion }) {
  // Legend wraps into multiple columns once the entry count exceeds what
  // fits vertically. PAD_R is sized to fit (legendCols × LEGEND_COL_W);
  // PLOT_W shrinks accordingly so labels never get clipped.
  const LEGEND_ROW_H = 18;
  const LEGEND_COL_W = 90;
  const H = 280;
  const PAD_L = 50;
  const PAD_T = 12;
  const PAD_B = 28;
  // Available vertical space for legend rows. Subtract a small slack so
  // the last entry's two text lines don't dip below the SVG bottom edge.
  const legendVAvail = H - PAD_T - 24;
  const legendRowsPerCol = Math.max(1, Math.floor(legendVAvail / LEGEND_ROW_H));
  const legendCount = Math.max(1, versions.length || 1);
  const legendCols = Math.max(1, Math.ceil(legendCount / legendRowsPerCol));
  const PAD_R = Math.max(120, 12 + legendCols * LEGEND_COL_W);
  // Grow W modestly when the legend needs extra columns so the chart
  // itself doesn't shrink too aggressively.
  const W = 780 + Math.max(0, legendCols - 1) * 90;
  const PLOT_W = W - PAD_L - PAD_R;
  const PLOT_H = H - PAD_T - PAD_B;

  const colors = [
    theme.accent,
    theme.gold,
    theme.green,
    theme.red,
    "#c084fc",
    "#22d3ee",
    "#f97316",
    "#a3e635",
  ];

  // Build per-version cumulative curves, in version-id order (V1, V2, ...).
  // Each point: { date, cum }. Entries with no date are dropped (can't
  // position on the axis). Entries are NOT re-sorted within a version —
  // procedure-mode append order is chronological by construction.
  // A version replacing a previous leading version starts at that
  // predecessor's cumulative R (seed), so the chart is continuous across
  // version changes instead of jumping back to 0.
  // The synthetic "AUTO" pseudo-version (when present) is rendered gold +
  // dashed to stand apart from manual versions.
  const curves = versions.map((v, i) => {
    const entries = (perVersionSeries[v.id] || {})[outcome] || [];
    const seed = (seedByVersion && seedByVersion[v.id]?.[outcome]) || 0;
    let cum = seed;
    const pts = [];
    if (seed !== 0 && entries.length > 0 && entries[0].date) {
      // Anchor point so the line literally begins at seed.
      pts.push({ date: entries[0].date, cum: seed });
    }
    for (const e of entries) {
      cum += e.value;
      if (e.date) pts.push({ date: e.date, cum });
    }
    const isAuto = v.id === "AUTO";
    return {
      id: v.id,
      color: isAuto ? theme.gold : colors[i % colors.length],
      dashed: isAuto,
      pts,
      finalCum: cum,
      isLeading: v.deprecatedAtStepIdx === null,
    };
  });

  const allPts = curves.flatMap((c) => c.pts);
  if (allPts.length === 0) {
    return (
      <div style={{ color: theme.textMuted, fontSize: 12, padding: 20 }}>
        No dated OOS entries recorded yet (a chart appears after the first
        commit).
      </div>
    );
  }

  // Convert ISO date "YYYY-MM-DD" to epoch seconds for linear scaling.
  const toEpoch = (iso) => new Date(iso + "T00:00:00Z").getTime() / 86400000;
  const xs = allPts.map((p) => toEpoch(p.date));
  const ys = allPts.map((p) => p.cum);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const xToPx = (x) => PAD_L + ((x - xMin) / xRange) * PLOT_W;
  const yToPx = (y) => PAD_T + PLOT_H - ((y - yMin) / yRange) * PLOT_H;

  // Y-axis zero line
  const zeroY = yToPx(0);

  // Axis tick helpers — 4 ticks each
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yRange * i) / 4;
    yTicks.push(yv);
  }
  const xTicks = [];
  for (let i = 0; i <= 4; i++) {
    const xv = xMin + (xRange * i) / 4;
    xTicks.push(xv);
  }
  const epochToIso = (epochDays) => {
    const d = new Date(epochDays * 86400000);
    return d.toISOString().slice(0, 10);
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", maxWidth: W, height: "auto", display: "block" }}
    >
      {/* Plot frame */}
      <rect
        x={PAD_L}
        y={PAD_T}
        width={PLOT_W}
        height={PLOT_H}
        fill="none"
        stroke={theme.border}
      />
      {/* Zero line */}
      {yMin < 0 && yMax > 0 && (
        <line
          x1={PAD_L}
          x2={PAD_L + PLOT_W}
          y1={zeroY}
          y2={zeroY}
          stroke={theme.textMuted}
          strokeDasharray="3,3"
        />
      )}
      {/* Y ticks */}
      {yTicks.map((yv, i) => {
        const py = yToPx(yv);
        return (
          <g key={`y${i}`}>
            <line
              x1={PAD_L - 4}
              x2={PAD_L}
              y1={py}
              y2={py}
              stroke={theme.textMuted}
            />
            <text
              x={PAD_L - 6}
              y={py + 3}
              fontSize={10}
              textAnchor="end"
              fill={theme.textMuted}
            >
              {yv.toFixed(1)}
            </text>
          </g>
        );
      })}
      {/* X ticks */}
      {xTicks.map((xv, i) => {
        const px = xToPx(xv);
        return (
          <g key={`x${i}`}>
            <line
              x1={px}
              x2={px}
              y1={PAD_T + PLOT_H}
              y2={PAD_T + PLOT_H + 4}
              stroke={theme.textMuted}
            />
            <text
              x={px}
              y={PAD_T + PLOT_H + 16}
              fontSize={10}
              textAnchor="middle"
              fill={theme.textMuted}
            >
              {epochToIso(xv)}
            </text>
          </g>
        );
      })}
      {/* Lines */}
      {curves.map((c) => {
        if (c.pts.length === 0) return null;
        const d = c.pts
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${xToPx(toEpoch(p.date)).toFixed(1)},${yToPx(
                p.cum
              ).toFixed(1)}`
          )
          .join(" ");
        return (
          <path
            key={c.id}
            d={d}
            stroke={c.color}
            strokeWidth={c.isLeading ? 2 : 1.4}
            strokeDasharray={c.dashed ? "5,4" : undefined}
            fill="none"
            opacity={c.isLeading ? 1 : 0.8}
          />
        );
      })}
      {/* Legend — wraps into multiple columns when entries exceed
          legendRowsPerCol so V15+ markers don't get cut off. */}
      {curves.map((c, i) => {
        const col = Math.floor(i / legendRowsPerCol);
        const row = i % legendRowsPerCol;
        const lx = PAD_L + PLOT_W + 10 + col * LEGEND_COL_W;
        const ly = PAD_T + row * LEGEND_ROW_H;
        return (
          <g key={`lg${c.id}`} transform={`translate(${lx}, ${ly})`}>
            <line x1={0} x2={16} y1={6} y2={6} stroke={c.color} strokeWidth={2} />
            <text x={22} y={10} fontSize={11} fill={theme.text}>
              {c.id}
              {c.isLeading ? " ★" : ""}
            </text>
            <text x={22} y={22} fontSize={10} fill={theme.textMuted}>
              {c.finalCum >= 0 ? "+" : ""}
              {c.finalCum.toFixed(2)} R
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════════════
// For a given version, two modes:
//   "shadow"  — original behavior. Walk every step where this version has
//               a result, replay the version's own pre-overlap pipeline on
//               that step's OOS rows. _version_id is constant (= version.id).
//   "lineage" — for steps BEFORE V was created, replay the predecessor that
//               was leading at that step (step.leadingVersionId). For steps
//               from V.createdAtStepIdx onward, replay V's own filters on
//               the step's OOS rows — including steps where V was shadow-
//               tracked after deprecation. _version_id varies per row, so
//               the same CSV captures the predecessor chain plus V's full
//               track (leading + shadow).
// Overlap is intentionally NOT applied because it's per-outcome and the
// export is a single table. Returns null when no rows survive.
function buildVersionCsv(version, procedure, rows, mode) {
  const { config, results, steps, versions } = procedure;
  const versionsById = Object.fromEntries(versions.map((v) => [v.id, v]));

  const exported = [];
  const stepIndices = Object.keys(results)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);

  for (const stepIdx of stepIndices) {
    const step = steps[stepIdx];
    if (!step) continue;

    let activeId;
    if (mode === "lineage") {
      if (stepIdx < version.createdAtStepIdx) {
        if (!step.leadingVersionId) continue;
        activeId = step.leadingVersionId;
      } else {
        if (!results[stepIdx] || !results[stepIdx][version.id]) continue;
        activeId = version.id;
      }
    } else {
      if (!results[stepIdx] || !results[stepIdx][version.id]) continue;
      activeId = version.id;
    }
    const activeVersion = versionsById[activeId];
    if (!activeVersion) continue;

    const filters = activeVersion.filters;
    const activeGroups = (filters.filterGroups || []).filter(
      (g) => g.length > 0
    );
    const dll = filters.dailyLossLimit;
    const limNum = dll ? parseInt(dll.value, 10) : 0;
    const sessMins = dll ? parseTimeToMinutes(dll.sessionStart) : null;
    const oosRowsRaw = rowsInDateRange(
      rows,
      config.dateCol,
      step.effOosStart,
      step.effOosEnd
    );
    const afterFilters = applyFilters(oosRowsRaw, activeGroups);
    // Per-version export covers all outcomes, but DLL is now per-outcome.
    // Take the union of per-outcome surviving sets so a row that contributed
    // to ANY outcome's metrics appears exactly once. Order is preserved by
    // filtering afterFilters in original order (Set membership is by
    // reference; applyDailyLossLimit returns a subset of the same row refs).
    const dllColName = dll ? dll.col || "" : "";
    const dllTimeColName = dll ? dll.timeCol || "" : "";
    const dllLossTimeColName = dll ? dll.lossTimeCol || "" : "";
    const surviving = new Set();
    for (const oc of config.outcomeCols) {
      const ocAfterLimit = applyDailyLossLimit(
        afterFilters,
        dllColName,
        config.lossCol,
        limNum,
        dllTimeColName,
        sessMins,
        dllLossTimeColName,
        oc
      );
      for (const r of ocAfterLimit) surviving.add(r);
    }
    const afterLimit = afterFilters.filter((r) => surviving.has(r));
    const isShadow = step.leadingVersionId !== activeId;
    for (const r of afterLimit) {
      exported.push({
        _step_idx: stepIdx + 1,
        _version_id: activeId,
        _is_shadow: isShadow ? "true" : "false",
        _oos_start: step.effOosStart,
        _oos_end: step.effOosEnd,
        ...r,
      });
    }
  }

  if (exported.length === 0) return null;

  // Column order: meta columns first, then original CSV column order
  const metaCols = [
    "_step_idx",
    "_version_id",
    "_is_shadow",
    "_oos_start",
    "_oos_end",
  ];
  const origCols = Object.keys(rows[0] || {});
  const fields = [...metaCols, ...origCols];
  const csv = Papa.unparse(exported, { columns: fields });
  const csvBase = (procedure.csvName || "procedure").replace(/\.csv$/i, "");
  const modeSuffix = mode === "lineage" ? "_lineage" : "";
  return {
    filename: `procedure_${version.id}${modeSuffix}_${csvBase}.csv`,
    content: csv,
    mime: "text/csv;charset=utf-8;",
  };
}

function exportVersionCsv(version, procedure, rows, mode) {
  const a = buildVersionCsv(version, procedure, rows, mode);
  if (!a) {
    alert(`${version.id} had no surviving OOS rows across the procedure.`);
    return;
  }
  triggerDownload(a.content, a.filename, a.mime);
}

// Generic helper: write any JSON-serializable filter snapshot to a .txt file.
// Used by the optimizer step panel where there's no version concept — just
// a per-outcome winning filter snapshot for the current step.
function downloadFiltersJsonTxt(filters, baseName) {
  triggerDownload(
    JSON.stringify(filters, null, 2),
    `${baseName}.txt`,
    "text/plain;charset=utf-8;"
  );
}

// Build a version's locked-filters .txt content.
// "lineage" mode mirrors the lineage CSV's data sourcing rule: list each
// predecessor that was leading before V was created (with its leading
// step range), then V itself with the step range from V's creation to
// the end of the procedure (covering both V's leading period and any
// shadow-tracked period after deprecation). "shadow" mode dumps just
// V's own filter snapshot.
function buildFiltersTxt(version, procedure, mode) {
  const { versions, steps } = procedure;
  const csvBase = (procedure.csvName || "procedure").replace(/\.csv$/i, "");

  if (mode === "lineage") {
    const versionsById = Object.fromEntries(versions.map((v) => [v.id, v]));
    const ordered = [];
    let prevId = null;
    // Predecessors: collapse consecutive runs of the same leadingVersionId
    // for steps strictly before V was created.
    for (let i = 0; i < version.createdAtStepIdx; i++) {
      const st = steps[i];
      if (!st || !st.committed || !st.leadingVersionId) continue;
      const id = st.leadingVersionId;
      if (id !== prevId) {
        ordered.push({ id, firstStep: i, lastStep: i });
        prevId = id;
      } else {
        ordered[ordered.length - 1].lastStep = i;
      }
    }
    // V itself: from V's creation to the last recorded step. V's filters
    // were applied to every row tagged _version_id = V in the lineage CSV,
    // including steps where V was shadow-tracked after deprecation.
    const lastStepIdx = steps.length - 1;
    if (lastStepIdx >= version.createdAtStepIdx) {
      ordered.push({
        id: version.id,
        firstStep: version.createdAtStepIdx,
        lastStep: lastStepIdx,
      });
    }
    const chain = {};
    for (const c of ordered) {
      chain[c.id] = {
        appliedFromStep: c.firstStep + 1,
        appliedToStep: c.lastStep + 1,
        filters: versionsById[c.id]?.filters ?? null,
      };
    }
    return {
      filename: `procedure_${version.id}_lineage_filters_${csvBase}.txt`,
      content: JSON.stringify({ lineageFor: version.id, chain }, null, 2),
      mime: "text/plain;charset=utf-8;",
    };
  }

  return {
    filename: `procedure_${version.id}_filters_${csvBase}.txt`,
    content: JSON.stringify(version.filters, null, 2),
    mime: "text/plain;charset=utf-8;",
  };
}

function exportFiltersTxt(version, procedure, mode) {
  const a = buildFiltersTxt(version, procedure, mode);
  triggerDownload(a.content, a.filename, a.mime);
}

// ═══════════════════════════════════════════════════════════════════
// FULL-PROCEDURE .ZIP COMPOSER
// ═══════════════════════════════════════════════════════════════════
// Bundles every per-version artifact (lineage CSV + lineage filters .txt,
// or shadow CSV + shadow filters .txt — whichever the user has currently
// toggled) plus, when the auto-optimizer was enabled, every per-outcome
// optimizer CSV and per-step filters .txt. JSZip is loaded lazily via
// dynamic import so the +30KB (gz) cost only hits users who click the
// button — Vite code-splits it into a separate chunk.
async function downloadProcedureZip(procedure, rows, mode) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const csvBase = (procedure.csvName || "procedure").replace(/\.csv$/i, "");

  const versionsDir = zip.folder("versions");
  for (const v of procedure.versions) {
    const csvArtifact = buildVersionCsv(v, procedure, rows, mode);
    if (csvArtifact) {
      versionsDir.file(csvArtifact.filename, csvArtifact.content);
    }
    const txtArtifact = buildFiltersTxt(v, procedure, mode);
    versionsDir.file(txtArtifact.filename, txtArtifact.content);
  }

  if (procedure.optimizer && procedure.optimizer.enabled) {
    const optDir = zip.folder("optimizer");
    for (const oc of procedure.config.outcomeCols) {
      const csvArtifact = buildOptimizerCsv(oc, procedure, rows);
      if (csvArtifact) {
        optDir.file(csvArtifact.filename, csvArtifact.content);
      }
      const txtArtifact = buildOptimizerStepsFiltersTxt(oc, procedure);
      optDir.file(txtArtifact.filename, txtArtifact.content);
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, `procedure_${csvBase}_${mode}.zip`, "application/zip");
}

// ═══════════════════════════════════════════════════════════════════
// Shared UI helpers
// ═══════════════════════════════════════════════════════════════════

function ProcedureHeader({ procedure, onDiscardRequested }) {
  return (
    <div
      style={{
        ...s.card,
        background: theme.surfaceAlt,
        padding: "10px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 11, color: theme.textMuted }}>
        PROCEDURE ·{" "}
        <span style={{ color: theme.text }}>{procedure.csvName}</span> ·{" "}
        {procedure.csvRowCount} rows · IS {procedure.config.isLengthDays}d /
        OOS {procedure.config.oosLengthDays}d
        {procedure.config.embargoDays > 0 &&
          ` · embargo ${procedure.config.embargoDays}d`}
      </div>
      <button style={s.btnDanger} onClick={onDiscardRequested}>
        Discard Procedure
      </button>
    </div>
  );
}

function DiscardButton({ onDiscard, label }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button style={s.btnDanger} onClick={() => setConfirming(true)}>
        {label}
      </button>
    );
  return (
    <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span style={{ color: theme.red, fontSize: 11 }}>
        This permanently deletes the saved procedure. Confirm?
      </span>
      <button style={s.btnDanger} onClick={onDiscard}>
        Yes, discard
      </button>
      <button style={s.btnOutline} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}

function DiscardConfirm({ onConfirm, onCancel }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: theme.surface,
          border: `2px solid ${theme.red}`,
          borderRadius: 8,
          padding: 24,
          maxWidth: 500,
          width: "90%",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{ color: theme.red, fontWeight: 700, fontSize: 14, marginBottom: 10 }}
        >
          Discard Procedure?
        </div>
        <div style={{ fontSize: 12, marginBottom: 16 }}>
          This permanently deletes all committed versions, step results, and
          OOS records from this run. The procedure cannot be resumed after
          discard. Continue?
        </div>
        <button
          style={{ ...s.btn, background: theme.red, marginRight: 8 }}
          onClick={onConfirm}
        >
          Yes, discard everything
        </button>
        <button style={s.btnOutline} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Grouped metrics table for IS exploration. One table per outcome; rows
// are the group keys (sorted numerically if they parse as numbers). _count
// column shows the pre-overlap group size; remaining columns are the
// per-outcome metrics. Same columns as free mode's GroupedTable.
function GroupedOutcomeTable({ grouped, keys, outcomeCol, groupByCol }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={s.h3}>{outcomeCol}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>{groupByCol}</th>
              <th style={s.th}>N</th>
              <th style={s.th}>Wins</th>
              <th style={s.th}>Losses</th>
              <th style={s.th}>BE</th>
              <th style={s.th}>Win %</th>
              <th style={s.th}>Net R</th>
              <th style={s.th}>Gross W</th>
              <th style={s.th}>Gross L</th>
              <th style={s.th}>Avg R</th>
              <th style={s.th}>Sortino</th>
              <th style={s.th}>Max DD</th>
              <th style={s.th}>Long DD</th>
              <th style={s.th}>Avg DD</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const m = grouped[key][outcomeCol];
              return (
                <tr key={key}>
                  <td style={{ ...s.td, fontWeight: 600 }}>{key}</td>
                  <td style={s.td}>{m.total}</td>
                  <td style={{ ...s.td, color: theme.green }}>{m.winCount}</td>
                  <td style={{ ...s.td, color: theme.red }}>{m.lossCount}</td>
                  <td style={{ ...s.td, color: theme.gold }}>
                    {m.breakEvenCount}
                  </td>
                  <td style={s.td}>{fmtPct(m.winPct)}</td>
                  <td
                    style={{
                      ...s.td,
                      color: m.netReturn >= 0 ? theme.green : theme.red,
                      fontWeight: 700,
                    }}
                  >
                    {fmt(m.netReturn)}
                  </td>
                  <td style={{ ...s.td, color: theme.green }}>
                    {fmt(m.grossReturn)}
                  </td>
                  <td style={{ ...s.td, color: theme.red }}>
                    {fmt(m.grossLoss)}
                  </td>
                  <td
                    style={{
                      ...s.td,
                      color: m.avgReturn >= 0 ? theme.green : theme.red,
                    }}
                  >
                    {fmt(m.avgReturn, 3)}
                  </td>
                  <td
                    style={{
                      ...s.td,
                      color:
                        m.sortino == null
                          ? theme.textMuted
                          : m.sortino >= 0
                          ? theme.green
                          : theme.red,
                    }}
                  >
                    {m.sortino == null ? "∞" : fmt(m.sortino, 2)}
                  </td>
                  <td style={{ ...s.td, color: theme.red }}>{fmt(m.maxDD)}</td>
                  <td style={s.td}>{m.longestDD}</td>
                  <td style={s.td}>{fmt(m.avgDDLength, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Metrics table used in step IS view, OOS reveal, and complete summary.
function OutcomeMetricsTable({ perOutcome, outcomeCols }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Outcome</th>
            <th style={s.th}>N</th>
            <th style={s.th}>Wins</th>
            <th style={s.th}>Losses</th>
            <th style={s.th}>BE</th>
            <th style={s.th}>Win %</th>
            <th style={s.th}>Net R</th>
            <th style={s.th}>Avg R</th>
            <th style={s.th}>Sortino</th>
            <th style={s.th}>Max DD</th>
            <th style={s.th}>Long DD</th>
          </tr>
        </thead>
        <tbody>
          {outcomeCols.map((oc) => {
            const m = (perOutcome[oc] && perOutcome[oc].metrics) || {
              total: 0,
              winCount: 0,
              lossCount: 0,
              breakEvenCount: 0,
              winPct: 0,
              netReturn: 0,
              avgReturn: 0,
              sortino: null,
              maxDD: 0,
              longestDD: 0,
            };
            return (
              <tr key={oc}>
                <td style={{ ...s.td, fontWeight: 600 }}>{oc}</td>
                <td style={s.td}>{m.total}</td>
                <td style={{ ...s.td, color: theme.green }}>{m.winCount}</td>
                <td style={{ ...s.td, color: theme.red }}>{m.lossCount}</td>
                <td style={{ ...s.td, color: theme.gold }}>{m.breakEvenCount}</td>
                <td style={s.td}>{fmtPct(m.winPct)}</td>
                <td
                  style={{
                    ...s.td,
                    color: m.netReturn >= 0 ? theme.green : theme.red,
                    fontWeight: 700,
                  }}
                >
                  {fmt(m.netReturn)}
                </td>
                <td
                  style={{
                    ...s.td,
                    color: m.avgReturn >= 0 ? theme.green : theme.red,
                  }}
                >
                  {fmt(m.avgReturn, 3)}
                </td>
                <td
                  style={{
                    ...s.td,
                    color:
                      m.sortino == null
                        ? theme.textMuted
                        : m.sortino >= 0
                        ? theme.green
                        : theme.red,
                  }}
                >
                  {m.sortino == null ? "∞" : fmt(m.sortino, 2)}
                </td>
                <td style={{ ...s.td, color: theme.red }}>{fmt(m.maxDD)}</td>
                <td style={s.td}>{m.longestDD}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

