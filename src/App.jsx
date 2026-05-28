import { useState, useMemo, useCallback } from "react";
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
  fmt,
  fmtPct,
  parseDateToISO,
  daysBetween,
  addDays,
} from "./metrics.js";
import { theme, s, OPERATORS, DOW_OPERATORS } from "./theme.js";
import { DOW_LABELS } from "./metrics.js";
import ProcedureMode from "./ProcedureMode.jsx";
import FiltersPasteModal from "./FiltersPasteModal.jsx";

// ── Main App ─────────────────────────────────────────────────────────
export default function App() {
  // Source CSV + date-split state
  const [singleSourceRaw, setSingleSourceRaw] = useState(null);
  const [singleSourceName, setSingleSourceName] = useState("");
  const [columns, setColumns] = useState([]);
  const [dateSplitCol, setDateSplitCol] = useState("");
  const [isStart, setIsStart] = useState("");
  const [isEnd, setIsEnd] = useState("");
  const [oosStart, setOosStart] = useState("");
  const [oosEnd, setOosEnd] = useState("");
  const [embargoDays, setEmbargoDays] = useState("0");
  const [splitApplied, setSplitApplied] = useState(false);

  // Column config
  const [outcomeColumns, setOutcomeColumns] = useState([]);
  const [lossColumn, setLossColumn] = useState("");
  const [configured, setConfigured] = useState(false);

  // Analysis state — filterGroups is [[condition, ...], [condition, ...], ...]
  const [filterGroups, setFilterGroups] = useState([[]]);
  const [newFilter, setNewFilter] = useState({ column: "", operator: "equals", value: "" });
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [groupByCol, setGroupByCol] = useState("");
  // "raw" | "hour" | "dow" | "wom" — applied to the chosen group column.
  const [groupKeyMode, setGroupKeyMode] = useState("raw");
  const [dailyLossLimitCol, setDailyLossLimitCol] = useState("");
  const [dailyLossLimit, setDailyLossLimit] = useState("");
  // Optional session inputs — when both set and valid, loss-limit buckets by
  // session (rolls at Session Start) and walks rows chronologically within.
  const [dailyLossLimitTimeCol, setDailyLossLimitTimeCol] = useState("");
  const [dailyLossLimitSessionStart, setDailyLossLimitSessionStart] = useState("");
  // Loss-realization datetime column. When set, applyDailyLossLimit treats
  // a trade's loss as occurring at THIS time rather than at entry — so an
  // entry placed before a previous open trade's loss is realized is not
  // retroactively blocked.
  const [dailyLossLimitLossTimeCol, setDailyLossLimitLossTimeCol] = useState("");
  // Overlap filter — excludes rows that enter while a previous row's event is
  // still active. Runs per-outcome (exit time depends on outcome column).
  const [overlapEnabled, setOverlapEnabled] = useState(false);
  const [overlapMode, setOverlapMode] = useState("always"); // always | excludeIfMatch | excludeIfDiffer
  const [overlapCompareCol, setOverlapCompareCol] = useState("");
  const [overlapEntryDateCol, setOverlapEntryDateCol] = useState("");
  const [overlapEntryTimeCol, setOverlapEntryTimeCol] = useState("");
  const [overlapLossTimeCol, setOverlapLossTimeCol] = useState("");
  // Map from outcome column name → that outcome's exit datetime column name.
  const [overlapExitMap, setOverlapExitMap] = useState({});
  // Bar duration in minutes. Bar timestamps name the OPEN of the bar, but a
  // signal-based entry can only fire on the close — so the overlap walk
  // shifts entries forward by this many minutes before checking against
  // active trades. 0 disables the offset (treats bar timestamp as entry).
  const [overlapEntryOffsetMinutes, setOverlapEntryOffsetMinutes] = useState(0);
  const [activeTab, setActiveTab] = useState("in");
  const [showProcedure, setShowProcedure] = useState(false);
  const [mode, setMode] = useState("free");
  // Toggles the paste-filters JSON modal in Free Mode.
  const [showPasteModal, setShowPasteModal] = useState(false);

  // ── CSV Parsing ──────────────────────────────────────────────────
  // Always refreshes columns from the uploaded file and resets the split,
  // so swapping CSVs cannot leave behind stale column or window state.
  const parseCSV = useCallback((file, setter, nameSetter) => {
    nameSetter(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        setter(result.data);
        if (result.meta.fields) setColumns(result.meta.fields);
        setDateSplitCol("");
        setIsStart(""); setIsEnd(""); setOosStart(""); setOosEnd("");
        setSplitApplied(false);
        setOutcomeColumns([]); setLossColumn(""); setConfigured(false);
      },
    });
  }, []);

  // ── Date-split computation ───────────────────────────────────────
  // Parses every row's date once and reports min/max + unparseable count.
  const dateParse = useMemo(() => {
    if (!singleSourceRaw || !dateSplitCol) return null;
    const parsed = singleSourceRaw.map((row, idx) => ({
      idx,
      row,
      date: parseDateToISO(row[dateSplitCol]),
    }));
    let unparseable = 0;
    let minDate = null, maxDate = null;
    const samples = [];
    for (const p of parsed) {
      if (p.date === null) { unparseable++; continue; }
      if (minDate === null || p.date < minDate) minDate = p.date;
      if (maxDate === null || p.date > maxDate) maxDate = p.date;
    }
    // Show first 5 raw → parsed pairs so the user can verify parsing
    for (let i = 0; i < Math.min(5, parsed.length); i++) {
      samples.push({ raw: parsed[i].row[dateSplitCol], parsed: parsed[i].date });
    }
    return { parsed, unparseable, minDate, maxDate, total: singleSourceRaw.length, samples };
  }, [singleSourceRaw, dateSplitCol]);

  // Apply split + enforce strict ordering + verify zero overlap.
  const splitWindows = useMemo(() => {
    if (!dateParse || !splitApplied) return null;
    if (!isStart || !isEnd || !oosStart || !oosEnd) {
      return { error: "All four dates must be set." };
    }
    if (isStart > isEnd) {
      return { error: `In-sample start (${isStart}) must be ≤ in-sample end (${isEnd}).` };
    }
    if (oosStart > oosEnd) {
      return { error: `Out-of-sample start (${oosStart}) must be ≤ out-of-sample end (${oosEnd}).` };
    }
    if (!(isEnd < oosStart)) {
      return { error: `Strict ordering required: in-sample end (${isEnd}) must be BEFORE out-of-sample start (${oosStart}). Equal dates would cause leakage.` };
    }

    // Embargo: shrink each window inward by N days from BOTH edges.
    // Negative or NaN treated as 0. Strict ordering already prevents
    // overlap; embargo only makes the gap larger.
    const embN = Math.max(0, parseInt(embargoDays, 10) || 0);
    const isLo = embN > 0 ? addDays(isStart, embN) : isStart;
    const isHi = embN > 0 ? addDays(isEnd, -embN) : isEnd;
    const oosLo = embN > 0 ? addDays(oosStart, embN) : oosStart;
    const oosHi = embN > 0 ? addDays(oosEnd, -embN) : oosEnd;
    if (embN > 0 && (isLo > isHi || oosLo > oosHi)) {
      return { error: `Embargo of ${embN} day(s) is larger than one of the windows — nothing would remain. Reduce embargo or widen window.` };
    }

    const inIdx = new Set();
    const outIdx = new Set();
    let embargoDroppedIn = 0;
    let embargoDroppedOut = 0;
    for (const p of dateParse.parsed) {
      if (p.date === null) continue;
      if (p.date >= isStart && p.date <= isEnd) {
        if (p.date >= isLo && p.date <= isHi) inIdx.add(p.idx);
        else embargoDroppedIn++;
      }
      if (p.date >= oosStart && p.date <= oosEnd) {
        if (p.date >= oosLo && p.date <= oosHi) outIdx.add(p.idx);
        else embargoDroppedOut++;
      }
    }

    // Runtime invariant: intersection MUST be empty.
    let overlap = 0;
    for (const i of inIdx) if (outIdx.has(i)) overlap++;
    if (overlap > 0) {
      return { error: `LEAKAGE DETECTED: ${overlap} rows appear in both windows. Refusing to render results.` };
    }

    const inRows = [], outRows = [];
    const inDates = [], outDates = [];
    for (const p of dateParse.parsed) {
      if (inIdx.has(p.idx)) { inRows.push(p.row); inDates.push(p.date); }
      if (outIdx.has(p.idx)) { outRows.push(p.row); outDates.push(p.date); }
    }
    inDates.sort();
    outDates.sort();

    const inMin = inDates[0] ?? null;
    const inMax = inDates[inDates.length - 1] ?? null;
    const outMin = outDates[0] ?? null;
    const outMax = outDates[outDates.length - 1] ?? null;
    const gapDays = (inMax && outMin) ? daysBetween(inMax, outMin) : null;

    return {
      inRows, outRows,
      inCount: inRows.length, outCount: outRows.length,
      overlap: 0,
      inMin, inMax, outMin, outMax,
      gapDays,
      excluded: dateParse.total - inRows.length - outRows.length,
      inUniqueDays: new Set(inDates).size,
      outUniqueDays: new Set(outDates).size,
      embargoDays: embN,
      embargoDroppedIn,
      embargoDroppedOut,
      effectiveIsRange: embN > 0 ? [isLo, isHi] : null,
      effectiveOosRange: embN > 0 ? [oosLo, oosHi] : null,
    };
  }, [dateParse, splitApplied, isStart, isEnd, oosStart, oosEnd, embargoDays]);

  // Effective datasets — all downstream logic operates ONLY on the
  // windowed subsets produced by splitWindows.
  const effectiveInSample = splitWindows && !splitWindows.error ? splitWindows.inRows : null;
  const effectiveOutSample = splitWindows && !splitWindows.error ? splitWindows.outRows : null;

  // ── Toggle outcome column ────────────────────────────────────────
  const toggleOutcomeCol = (col) => {
    setOutcomeColumns(prev =>
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    );
  };

  // ── Filter management ────────────────────────────────────────────
  const addFilter = () => {
    if (!newFilter.column) return;
    if (!["not_empty", "empty"].includes(newFilter.operator) && !newFilter.value) return;
    setFilterGroups(prev => {
      const updated = prev.map(g => [...g]);
      updated[activeGroupIdx] = [...updated[activeGroupIdx], { ...newFilter, id: Date.now() }];
      return updated;
    });
    // Intentionally NOT resetting newFilter — values persist so the user can
    // add the same filter to multiple OR groups without retyping.
  };

  const removeFilter = (groupIdx, id) => {
    setFilterGroups(prev => {
      const updated = prev.map(g => [...g]);
      updated[groupIdx] = updated[groupIdx].filter(f => f.id !== id);
      // If group is now empty and there are other groups, remove it
      if (updated[groupIdx].length === 0 && updated.length > 1) {
        updated.splice(groupIdx, 1);
        if (activeGroupIdx >= updated.length) setActiveGroupIdx(updated.length - 1);
      }
      return updated;
    });
  };

  const addFilterGroup = () => {
    setFilterGroups(prev => [...prev, []]);
    setActiveGroupIdx(filterGroups.length);
  };

  const removeFilterGroup = (groupIdx) => {
    setFilterGroups(prev => {
      if (prev.length <= 1) return [[]];
      const updated = [...prev];
      updated.splice(groupIdx, 1);
      if (activeGroupIdx >= updated.length) setActiveGroupIdx(updated.length - 1);
      return updated;
    });
  };

  // Apply a parsed filter snapshot from the paste modal. Replaces every
  // piece of filter state (groups + DLL + overlap) atomically. The modal
  // hands us a fully normalized object with default fields filled, fresh
  // condition ids assigned, and warnings already surfaced — so this is a
  // straight fan-out into setters.
  const applyFilterSnapshot = useCallback((filters) => {
    setFilterGroups(filters.filterGroups);
    setActiveGroupIdx(0);
    setNewFilter({ column: "", operator: "equals", value: "" });
    setDailyLossLimitCol(filters.dailyLossLimit.col);
    setDailyLossLimit(filters.dailyLossLimit.value);
    setDailyLossLimitTimeCol(filters.dailyLossLimit.timeCol);
    setDailyLossLimitSessionStart(filters.dailyLossLimit.sessionStart);
    setDailyLossLimitLossTimeCol(filters.dailyLossLimit.lossTimeCol);
    setOverlapEnabled(filters.overlap.enabled);
    setOverlapMode(filters.overlap.mode);
    setOverlapCompareCol(filters.overlap.compareCol);
    setOverlapEntryDateCol(filters.overlap.entryDateCol);
    setOverlapEntryTimeCol(filters.overlap.entryTimeCol);
    setOverlapLossTimeCol(filters.overlap.lossTimeCol);
    setOverlapExitMap(filters.overlap.exitMap);
    setOverlapEntryOffsetMinutes(filters.overlap.entryOffsetMinutes || 0);
    setShowPasteModal(false);
  }, []);

  // ── Compute results ──────────────────────────────────────────────
  const computeResults = useMemo(() => {
    if (!configured) return null;

    const dataSource = activeTab === "in" ? effectiveInSample : effectiveOutSample;
    if (!dataSource) return null;

    // Only pass groups that have conditions
    const activeGroups = filterGroups.filter(g => g.length > 0);
    const afterFilters = applyFilters(dataSource, activeGroups);

    // Per-outcome overlap → per-outcome DLL. Overlap runs first so trades
    // that wouldn't actually have been taken (because a prior trade was
    // still active) don't consume any of the daily-loss budget. DLL also
    // runs INSIDE the per-outcome loop so a row whose outcome cell is
    // populated does not generate a loss event for that outcome — even if
    // its loss column is also populated. This matches buildReturnSeries's
    // "outcome wins" rule and keeps DLL, overlap, and metric calc
    // consistent on conflicted rows.
    const limitNum = parseInt(dailyLossLimit, 10);
    const sessionStartMinutes = parseTimeToMinutes(dailyLossLimitSessionStart);
    const overlapReady = overlapEnabled && overlapEntryDateCol && overlapEntryTimeCol &&
      (overlapMode === "always" || overlapCompareCol);
    const ocFiltered = {};
    const ocRowCounts = {};
    const ocAfterOverlapCounts = {};
    for (const oc of outcomeColumns) {
      const afterOverlap = overlapReady
        ? applyOverlapFilter(afterFilters, {
            enabled: true,
            mode: overlapMode,
            compareCol: overlapCompareCol,
            entryDateCol: overlapEntryDateCol,
            entryTimeCol: overlapEntryTimeCol,
            lossTimeCol: overlapLossTimeCol,
            exitTimeCol: overlapExitMap[oc] || "",
            lossCol: lossColumn,
            outcomeCol: oc,
            entryOffsetMinutes: overlapEntryOffsetMinutes,
          })
        : afterFilters;
      ocAfterOverlapCounts[oc] = afterOverlap.length;
      ocFiltered[oc] = applyDailyLossLimit(
        afterOverlap,
        dailyLossLimitCol,
        lossColumn,
        limitNum,
        dailyLossLimitTimeCol,
        sessionStartMinutes,
        dailyLossLimitLossTimeCol,
        oc
      );
      ocRowCounts[oc] = ocFiltered[oc].length;
    }

    if (!groupByCol) {
      // No grouping — one set of results per outcome
      const results = {};
      for (const oc of outcomeColumns) {
        const returns = buildReturnSeries(ocFiltered[oc], oc, lossColumn);
        results[oc] = calcMetrics(returns);
      }
      return {
        type: "ungrouped", results,
        totalRows: afterFilters.length, sourceRows: dataSource.length,
        ocRowCounts, ocAfterOverlapCounts, overlapActive: overlapReady,
      };
    }

    // Grouped. Group keys come from the shared post-applyFilters set so columns
    // line up across outcomes (per-outcome DLL/overlap then reshape row counts
    // within each group). `_count` reflects the post-applyFilters group size,
    // pre-DLL — a stable shared denominator across outcomes.
    const keyFn = getGroupKeyFn(groupKeyMode);
    const preGroups = groupRows(afterFilters, groupByCol, keyFn);
    const sortedKeys = sortGroupKeys(Object.keys(preGroups), groupKeyMode);

    const grouped = {};
    for (const key of sortedKeys) {
      grouped[key] = { _count: preGroups[key].length };
    }
    for (const oc of outcomeColumns) {
      const ocGroups = groupRows(ocFiltered[oc], groupByCol, keyFn);
      for (const key of sortedKeys) {
        const rowsForGroup = ocGroups[key] ?? [];
        grouped[key][oc] = calcMetrics(buildReturnSeries(rowsForGroup, oc, lossColumn));
      }
    }
    return {
      type: "grouped", grouped, keys: sortedKeys,
      totalRows: afterFilters.length, sourceRows: dataSource.length,
      ocRowCounts, ocAfterOverlapCounts, overlapActive: overlapReady,
    };
  }, [configured, effectiveInSample, effectiveOutSample, activeTab, filterGroups, groupByCol, groupKeyMode, outcomeColumns, lossColumn, dailyLossLimitCol, dailyLossLimit, dailyLossLimitTimeCol, dailyLossLimitSessionStart, dailyLossLimitLossTimeCol, overlapEnabled, overlapMode, overlapCompareCol, overlapEntryDateCol, overlapEntryTimeCol, overlapLossTimeCol, overlapExitMap, overlapEntryOffsetMinutes]);

  // ── Verification bar (inline render — keeps stable identity per render) ──
  const renderVerificationBar = () => {
    if (!computeResults) return null;
    const windowLabel = splitWindows && !splitWindows.error
      ? (activeTab === "in"
          ? `${splitWindows.inMin ?? "—"} → ${splitWindows.inMax ?? "—"}`
          : `${splitWindows.outMin ?? "—"} → ${splitWindows.outMax ?? "—"}`)
      : null;
    return (
      <div style={{ ...s.card, background: theme.surfaceAlt, display: "flex", gap: 24, alignItems: "center", padding: "10px 20px", flexWrap: "wrap" }}>
        <span style={{ color: theme.textMuted, fontSize: 11 }}>VERIFICATION</span>
        <span>Window rows: <strong>{computeResults.sourceRows}</strong></span>
        <span>After filters: <strong>{computeResults.totalRows}</strong></span>
        <span>Dropped: <strong style={{ color: computeResults.sourceRows - computeResults.totalRows > 0 ? theme.gold : theme.green }}>{computeResults.sourceRows - computeResults.totalRows}</strong></span>
        <span>Dataset: <strong style={{ color: activeTab === "in" ? theme.accent : theme.gold }}>{activeTab === "in" ? "IN-SAMPLE" : "OUT-OF-SAMPLE"}</strong></span>
        {windowLabel && <span>Date window: <strong>{windowLabel}</strong></span>}
        {computeResults.overlapActive && (
          <span style={{ color: theme.textMuted }}>
            Overlap per outcome:{" "}
            {outcomeColumns.map(oc => {
              // Overlap is the FIRST per-outcome stage now. "kept" reports
              // post-overlap (pre-DLL), and the baseline is the shared
              // post-applyFilters count — so "excluded" measures only what
              // overlap removed, independent of any DLL trimming that runs
              // afterward.
              const kept = computeResults.ocAfterOverlapCounts?.[oc] ?? computeResults.totalRows;
              const baseline = computeResults.totalRows;
              const removed = baseline - kept;
              return (
                <span key={oc} style={{ ...s.tag, borderColor: theme.accent }}>
                  <strong>{oc}</strong>: {kept} kept / {removed} excluded
                </span>
              );
            })}
          </span>
        )}
      </div>
    );
  };

  // ── Metrics Table Renderer ───────────────────────────────────────
  const MetricsTable = ({ metrics, label }) => {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={s.h3}>{label}</div>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Events</th>
              <th style={s.th}>Wins</th>
              <th style={s.th}>Losses</th>
              <th style={s.th}>BE</th>
              <th style={s.th}>Win %</th>
              <th style={s.th}>Net Return</th>
              <th style={s.th}>Gross Win</th>
              <th style={s.th}>Gross Loss</th>
              <th style={s.th}>Avg R/Trade</th>
              <th style={s.th}>Sortino</th>
              <th style={s.th}>Max DD</th>
              <th style={s.th}>Longest DD</th>
              <th style={s.th}>Avg DD Len</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={s.td}>{metrics.total}</td>
              <td style={{ ...s.td, color: theme.green }}>{metrics.winCount}</td>
              <td style={{ ...s.td, color: theme.red }}>{metrics.lossCount}</td>
              <td style={{ ...s.td, color: theme.gold }}>{metrics.breakEvenCount}</td>
              <td style={s.td}>{fmtPct(metrics.winPct)}</td>
              <td style={{ ...s.td, color: metrics.netReturn >= 0 ? theme.green : theme.red, fontWeight: 700 }}>{fmt(metrics.netReturn)}</td>
              <td style={{ ...s.td, color: theme.green }}>{fmt(metrics.grossReturn)}</td>
              <td style={{ ...s.td, color: theme.red }}>{fmt(metrics.grossLoss)}</td>
              <td style={{ ...s.td, color: metrics.avgReturn >= 0 ? theme.green : theme.red }}>{fmt(metrics.avgReturn, 3)}</td>
              <td style={{ ...s.td, color: metrics.sortino == null ? theme.textMuted : (metrics.sortino >= 0 ? theme.green : theme.red) }}>{metrics.sortino == null ? "∞" : fmt(metrics.sortino, 2)}</td>
              <td style={{ ...s.td, color: theme.red }}>{fmt(metrics.maxDD)}</td>
              <td style={s.td}>{metrics.longestDD}</td>
              <td style={s.td}>{fmt(metrics.avgDDLength, 1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  // ── Grouped Metrics Table ────────────────────────────────────────
  const GroupedTable = ({ grouped, keys, outcomeCol }) => {
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
              {keys.map(key => {
                const m = grouped[key][outcomeCol];
                return (
                  <tr key={key}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{key}</td>
                    <td style={s.td}>{m.total}</td>
                    <td style={{ ...s.td, color: theme.green }}>{m.winCount}</td>
                    <td style={{ ...s.td, color: theme.red }}>{m.lossCount}</td>
                    <td style={{ ...s.td, color: theme.gold }}>{m.breakEvenCount}</td>
                    <td style={s.td}>{fmtPct(m.winPct)}</td>
                    <td style={{ ...s.td, color: m.netReturn >= 0 ? theme.green : theme.red, fontWeight: 700 }}>{fmt(m.netReturn)}</td>
                    <td style={{ ...s.td, color: theme.green }}>{fmt(m.grossReturn)}</td>
                    <td style={{ ...s.td, color: theme.red }}>{fmt(m.grossLoss)}</td>
                    <td style={{ ...s.td, color: m.avgReturn >= 0 ? theme.green : theme.red }}>{fmt(m.avgReturn, 3)}</td>
                    <td style={{ ...s.td, color: m.sortino == null ? theme.textMuted : (m.sortino >= 0 ? theme.green : theme.red) }}>{m.sortino == null ? "∞" : fmt(m.sortino, 2)}</td>
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
  };

  // ── Operation Procedure modal ────────────────────────────────────
  const renderProcedureModal = () => {
    if (!showProcedure) return null;
    const p = { color: theme.text, fontSize: 13, lineHeight: 1.55, margin: "0 0 12px 0" };
    const h1 = { fontSize: 22, fontWeight: 700, color: theme.gold, margin: "8px 0 16px 0", letterSpacing: "-0.02em" };
    const h2 = { fontSize: 16, fontWeight: 700, color: theme.accent, margin: "24px 0 10px 0", paddingBottom: 6, borderBottom: `1px solid ${theme.border}` };
    const h3 = { fontSize: 13, fontWeight: 700, color: theme.text, margin: "16px 0 6px 0", textTransform: "uppercase", letterSpacing: "0.05em" };
    const ul = { margin: "0 0 12px 0", paddingLeft: 20, color: theme.text, fontSize: 13, lineHeight: 1.55 };
    const li = { marginBottom: 6 };
    const em = { fontStyle: "italic", color: theme.textMuted };
    const warn = { background: theme.surfaceAlt, border: `1px solid ${theme.gold}`, borderRadius: 6, padding: 12, margin: "16px 0" };
    const cb = { marginRight: 8, accentColor: theme.accent };
    return (
      <div onClick={() => setShowProcedure(false)} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "40px 20px", zIndex: 1000, overflowY: "auto",
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          background: theme.surface, border: `2px solid ${theme.gold}`, borderRadius: 10,
          padding: "32px 40px", maxWidth: 820, width: "100%", position: "relative",
          fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        }}>
          <button onClick={() => setShowProcedure(false)} aria-label="Close"
            style={{ position: "absolute", top: 10, right: 14, background: "transparent",
              border: "none", color: theme.textMuted, fontSize: 28, cursor: "pointer",
              fontFamily: "inherit", lineHeight: 1 }}>×</button>

          <p style={{ ...em, marginBottom: 6 }}>A default procedure used to evaluate research data &amp; test hypotheses. 4/19/26</p>
          <ul style={ul}><li style={li}>Strategies can be regime dependent — only work during certain periods. That's why we have retirement rules. Some years they'll work, some they won't. Don't be discouraged.</li></ul>

          <h1 style={h1}>Strategy Research Methodology</h1>

          <h2 style={h2}>Core principle</h2>
          <p style={p}>The question under test: does our <strong>adaptation process</strong> — our judgment and methods applied to a fundamental market event — produce a net gain over time? Individual procedure versions are evolutions within this process, not the full experiment. We validate the procedure, not parameter values frozen in time.</p>

          <h2 style={h2}>Rolling walk-forward validation</h2>
          <ul style={ul}>
            <li style={li}><strong>Training window</strong>: sized by filtered trade count. Target 100+ per cycle (30 min, 200+ robust). Fits stable parameters without fitting noise.</li>
            <li style={li}><strong>Test window</strong>: one step following the training window. Procedure outputs parameters; they are evaluated on the test with zero modification.</li>
            <li style={li}><strong>Step forward</strong>: advance training and test windows by one step, refit parameters, evaluate the next test window. Each test window is "first contact" — results are locked on view.</li>
            <li style={li}><strong>Cycles</strong>: enough to accumulate 100+ OOS trades minimum, 200+ preferred for tight confidence intervals.</li>
            <li style={li}><strong>Holdout</strong>: the most recent segment, reserved untouched from day one. Evaluated exactly once on the final committed procedure. Cleaner than walk-forward OOS because zero selection decisions were made while it was visible.</li>
          </ul>
          <p style={{ ...p, ...em }}>Example: train on months 1–12, test on month 13. Step forward: train on months 2–13, refit, test month 14. Repeat for 18 cycles (accumulating 18 months of OOS). Evaluate final committed procedure once on held-out months 31–36.</p>

          <h2 style={h2}>Version evolution and shadow tracking</h2>
          <p style={p}>A procedure version is not frozen forever. When insight from completed walk-forward motivates a change, evolve to a new version — and continue running the deprecated version in parallel on all subsequent data to test whether the evolution was a net gain.</p>
          <ul style={ul}>
            <li style={li}>Shadow tracking applies <strong>only after deprecation</strong>, on data arriving after deprecation. Running parallel versions during development is multi-version optimization and recreates the overfitting problem the methodology exists to prevent.</li>
            <li style={li}>Each new version's statistical clock starts at introduction; its walk-forward OOS sample is its own record going forward, not the prior version's.</li>
            <li style={li}>Too-frequent changes prevent any version from accumulating enough OOS for confidence. If shadow tracking consistently shows deprecated versions holding up or outperforming, recent evolutions are likely noise-fitting rather than genuine improvement.</li>
          </ul>

          <div style={warn}>
            <h2 style={{ ...h2, margin: 0, paddingBottom: 8, color: theme.gold, borderColor: theme.gold }}>⚠️ If they don't work, too bad</h2>
            <p style={p}><strong>Within a version, the procedure is frozen. Looking at OOS and adjusting the current version converts OOS into a training set and produces overfit validation.</strong> Results are locked on view. Within-version iteration is the most common killer of systematic strategies.</p>
            <p style={{ ...p, margin: 0 }}>Parameter values changing cycle to cycle as the procedure refits on new training data is adaptation, not iteration. A filter being included or excluded across cycles is the same — fine if the procedure decides mechanically from training data, not fine if a human decides after seeing OOS. A human modifying the procedure itself — widening search ranges, adding new filter candidates, restructuring decision logic — is version evolution, not within-version adjustment, and triggers the new-version rules above.</p>
          </div>

          <h2 style={h2}>Pre-commitment and variants</h2>
          <p style={p}>For each version: iterate freely on the initial training window, then write down the exact procedure, its filter candidates, and their parameter ranges for <strong>no more than 2 variants</strong>. Date-stamp. Then run walk-forward; variants execute as committed.</p>
          <p style={p}>Maintain a trial log of every configuration ever tested across all versions. Sortino estimates are silently inflated by the number of trials attempted.</p>

          <h2 style={h2}>Filter construction</h2>
          <p style={p}>During initial training window ideation: test one filter at a time against an unfiltered baseline. Each filter needs an economic rationale, not just statistical improvement. Combine only after individual validation.</p>

          <h3 style={h3}>Questioning</h3>
          <p style={{ ...p, ...em }}>We start with these questions and add whatever additional questions we have. This is what we're using the EDA tool for (in a github repo and built locally).</p>
          <ul style={{ ...ul, listStyle: "none", paddingLeft: 4 }}>
            <li style={li}><input type="checkbox" disabled style={cb} />Optimal Loss per day, 5, 4, 3, 2? No trade after win? 5 is baseline, lets try 3, then 2. See if better in sample, then confirm out of sample. Maybe some in pre 0000 then some after? Limit the shorts/longs per day? What's simple and effective?</li>
            <li style={li}><input type="checkbox" disabled style={cb} />Optimal Prev. Day Rank, top 50%, 60, 70? Make sure to look at really low rank range day, 99% or rank 30, 60.</li>
            <li style={li}><input type="checkbox" disabled style={cb} />Best to exit x amount at 3bar? or at EOD? or 1wk?</li>
            <li style={li}><input type="checkbox" disabled style={cb} />Is long at high and short at low better performance than long at low / short at high or the inverse?</li>
            <li style={li}><input type="checkbox" disabled style={cb} />Any poor performance hours?</li>
            <li style={li}><input type="checkbox" disabled style={cb} />What is Max DD?</li>
          </ul>

          <h2 style={h2}>Data hygiene</h2>
          <ul style={ul}>
            <li style={li}><strong>Purge</strong>: remove training trades whose holding period overlaps the test window.</li>
            <li style={li}><strong>Embargo</strong>: exclude training observations in a short buffer around test boundaries.</li>
          </ul>

          <h2 style={h2}>Realism requirements</h2>
          <p style={p}>Backtest numbers must reflect what is executable:</p>
          <ul style={ul}>
            <li style={li}><strong>Transaction costs and slippage</strong>: realistic commissions plus slippage modeled from typical bid-ask and order type.</li>
            <li style={li}><strong>Sizing and margin feasibility</strong>: target-risk position size must be fillable at expected volume without market impact, and margin must cover the position with reserve for adverse moves.</li>
            <li style={li}><strong>Correlation and gap risk</strong>: 1% risk across 5 correlated positions is 5% aggregate risk; stops don't guarantee fill, so model price gapping through the stop as the real max loss per trade.</li>
          </ul>

          <h2 style={h2}>Strategy retirement</h2>
          <p style={p}>Every deployed strategy has a predetermined retirement point based on max drawdown. Position sizing assumes live drawdown 50% greater than the maximum observed in testing; exceeding that level retires the strategy. The decision is made by the framework, not by emotion.</p>
          <p style={p}>Deploy the committed procedure refit on the most recent training window. The model is always fit to fresh data; the <em>procedure</em> is what walk-forward validated.</p>

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${theme.border}`, textAlign: "right" }}>
            <button onClick={() => setShowProcedure(false)} style={s.btn}>Close</button>
          </div>
        </div>
      </div>
    );
  };

  // ── RENDER ───────────────────────────────────────────────────────
  return (
    <div style={s.page}>
      {renderProcedureModal()}
      <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={s.h1}>EDA Tool</h1>
          <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>Upload → Configure Columns → Filter & Group → Analyze</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4, background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 4 }}>
            <button onClick={() => setMode("free")} style={s.chip(mode === "free")}>Free Mode</button>
            <button onClick={() => setMode("procedure")} style={s.chip(mode === "procedure")}>Procedure Mode</button>
          </div>
          <button onClick={() => setShowProcedure(true)} style={{
            background: theme.gold, color: "#0f1117", border: "none", borderRadius: 6,
            padding: "12px 22px", fontSize: 13, fontWeight: 800, fontFamily: "inherit",
            cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase",
            boxShadow: `0 0 0 3px ${theme.gold}33, 0 4px 14px ${theme.gold}55`,
          }}>
            Methodology
          </button>
        </div>
      </div>

      {/* ── STEP 1: Upload ──────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.h2}>1 — Data Upload</div>
        <div style={{ minWidth: 200 }}>
          <label style={s.label}>Source CSV {singleSourceName && <span style={{ color: theme.green }}>✓ {singleSourceName}</span>}</label>
          <div style={s.file}>
            <input type="file" accept=".csv" onChange={(e) => e.target.files[0] && parseCSV(e.target.files[0], setSingleSourceRaw, setSingleSourceName)} style={{ fontSize: 12, fontFamily: "inherit" }} />
          </div>
        </div>
        {singleSourceRaw && <p style={{ color: theme.textMuted, marginTop: 8, fontSize: 11 }}>{columns.length} columns detected — {singleSourceRaw.length} total rows. {mode === "free" ? "Configure date split below." : "Procedure mode will set windows for you."}</p>}
      </div>

      {/* ── PROCEDURE MODE ─────────────────────────────────────── */}
      {mode === "procedure" && (
        <ProcedureMode
          rows={singleSourceRaw}
          columns={columns}
          csvName={singleSourceName}
        />
      )}

      {/* ── STEP 1b: Date split ─────────────────────────────────── */}
      {mode === "free" && singleSourceRaw && (
        <div style={s.card}>
          <div style={s.h2}>1b — Date Split (In-Sample / Out-of-Sample)</div>
          <p style={{ color: theme.textMuted, fontSize: 12, marginBottom: 12 }}>
            Pick the date column, then define two non-overlapping date windows. All filtering, grouping, and metric computation will operate ONLY on rows inside the selected window for the active tab.
          </p>

          <div style={{ ...s.row, marginBottom: 12 }}>
            <div>
              <label style={s.label}>Date Column</label>
              <select style={s.select} value={dateSplitCol} onChange={e => { setDateSplitCol(e.target.value); setSplitApplied(false); }}>
                <option value="">Select...</option>
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {dateParse && (
            <>
              <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 12 }}>
                <div style={{ marginBottom: 6 }}>
                  <span style={{ color: theme.textMuted }}>Detected range:</span>{" "}
                  <strong>{dateParse.minDate ?? "—"}</strong> → <strong>{dateParse.maxDate ?? "—"}</strong>
                  {" · "}
                  <span style={{ color: theme.textMuted }}>Total:</span> <strong>{dateParse.total}</strong>
                  {" · "}
                  <span style={{ color: theme.textMuted }}>Unparseable:</span>{" "}
                  <strong style={{ color: dateParse.unparseable > 0 ? theme.red : theme.green }}>{dateParse.unparseable}</strong>
                </div>
                <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 6 }}>Parse preview (first 5 rows — verify these match what you expect):</div>
                <div style={{ marginTop: 4 }}>
                  {dateParse.samples.map((sm, i) => (
                    <span key={i} style={s.tag}>
                      <code style={{ color: theme.textMuted }}>{String(sm.raw)}</code>
                      {" → "}
                      <strong style={{ color: sm.parsed ? theme.green : theme.red }}>{sm.parsed ?? "UNPARSEABLE"}</strong>
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 }}>
                <div style={{ border: `1px solid ${theme.accent}`, borderRadius: 6, padding: 12 }}>
                  <div style={{ fontSize: 11, color: theme.accent, fontWeight: 600, marginBottom: 8 }}>IN-SAMPLE WINDOW</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <label style={s.label}>Start (inclusive)</label>
                      <input type="date" style={s.input} value={isStart}
                        min={dateParse.minDate ?? undefined} max={dateParse.maxDate ?? undefined}
                        onChange={e => { setIsStart(e.target.value); setSplitApplied(false); }} />
                    </div>
                    <div>
                      <label style={s.label}>End (inclusive)</label>
                      <input type="date" style={s.input} value={isEnd}
                        min={dateParse.minDate ?? undefined} max={dateParse.maxDate ?? undefined}
                        onChange={e => { setIsEnd(e.target.value); setSplitApplied(false); }} />
                    </div>
                  </div>
                </div>
                <div style={{ border: `1px solid ${theme.gold}`, borderRadius: 6, padding: 12 }}>
                  <div style={{ fontSize: 11, color: theme.gold, fontWeight: 600, marginBottom: 8 }}>OUT-OF-SAMPLE WINDOW</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <label style={s.label}>Start (inclusive)</label>
                      <input type="date" style={s.input} value={oosStart}
                        min={dateParse.minDate ?? undefined} max={dateParse.maxDate ?? undefined}
                        onChange={e => { setOosStart(e.target.value); setSplitApplied(false); }} />
                    </div>
                    <div>
                      <label style={s.label}>End (inclusive)</label>
                      <input type="date" style={s.input} value={oosEnd}
                        min={dateParse.minDate ?? undefined} max={dateParse.maxDate ?? undefined}
                        onChange={e => { setOosEnd(e.target.value); setSplitApplied(false); }} />
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ ...s.row, marginBottom: 12 }}>
                <div>
                  <label style={s.label}>Embargo (days dropped from each edge of both windows)</label>
                  <input type="number" min="0" style={{ ...s.input, width: 80 }} value={embargoDays}
                    onChange={e => { setEmbargoDays(e.target.value); setSplitApplied(false); }} />
                </div>
                <span style={{ color: theme.textMuted, fontSize: 11, paddingBottom: 6 }}>
                  e.g. 1 → drops the first AND last day of both windows. Embargo only widens the gap; strict ordering still enforced.
                </span>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button style={s.btn} onClick={() => setSplitApplied(true)}
                  disabled={!isStart || !isEnd || !oosStart || !oosEnd}>
                  Apply Split
                </button>
                {splitApplied && splitWindows && (
                  splitWindows.error
                    ? <span style={{ color: theme.red, fontSize: 12, fontWeight: 600 }}>✗ {splitWindows.error}</span>
                    : <span style={{ color: theme.green, fontSize: 12, fontWeight: 600 }}>✓ Split valid · Overlap: 0</span>
                )}
              </div>

              {splitApplied && splitWindows && !splitWindows.error && (
                <div style={{ marginTop: 12, background: theme.surfaceAlt, border: `1px solid ${theme.green}`, borderRadius: 6, padding: 12, fontSize: 12 }}>
                  <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 8, fontWeight: 600 }}>SPLIT VERIFICATION</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={{ color: theme.accent, fontWeight: 600, marginBottom: 4 }}>In-sample</div>
                      <div>Rows: <strong>{splitWindows.inCount}</strong></div>
                      <div>Unique days: <strong>{splitWindows.inUniqueDays}</strong></div>
                      <div>Actual range: <strong>{splitWindows.inMin ?? "—"}</strong> → <strong>{splitWindows.inMax ?? "—"}</strong></div>
                      {splitWindows.effectiveIsRange && (
                        <div style={{ color: theme.textMuted, fontSize: 11 }}>
                          Effective range after embargo: {splitWindows.effectiveIsRange[0]} → {splitWindows.effectiveIsRange[1]}
                        </div>
                      )}
                      {splitWindows.embargoDays > 0 && (
                        <div>Dropped by embargo: <strong style={{ color: theme.gold }}>{splitWindows.embargoDroppedIn}</strong></div>
                      )}
                    </div>
                    <div>
                      <div style={{ color: theme.gold, fontWeight: 600, marginBottom: 4 }}>Out-of-sample</div>
                      <div>Rows: <strong>{splitWindows.outCount}</strong></div>
                      <div>Unique days: <strong>{splitWindows.outUniqueDays}</strong></div>
                      <div>Actual range: <strong>{splitWindows.outMin ?? "—"}</strong> → <strong>{splitWindows.outMax ?? "—"}</strong></div>
                      {splitWindows.effectiveOosRange && (
                        <div style={{ color: theme.textMuted, fontSize: 11 }}>
                          Effective range after embargo: {splitWindows.effectiveOosRange[0]} → {splitWindows.effectiveOosRange[1]}
                        </div>
                      )}
                      {splitWindows.embargoDays > 0 && (
                        <div>Dropped by embargo: <strong style={{ color: theme.gold }}>{splitWindows.embargoDroppedOut}</strong></div>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${theme.border}` }}>
                    <span>Overlap (rows in both windows): <strong style={{ color: theme.green }}>{splitWindows.overlap}</strong></span>
                    {" · "}
                    <span>Excluded rows (outside windows, unparseable, or embargoed): <strong>{splitWindows.excluded}</strong></span>
                    {splitWindows.gapDays !== null && (
                      <>
                        {" · "}
                        <span>Gap between IS end and OOS start: <strong>{splitWindows.gapDays} day{splitWindows.gapDays === 1 ? "" : "s"}</strong></span>
                      </>
                    )}
                    {splitWindows.embargoDays > 0 && (
                      <>
                        {" · "}
                        <span>Embargo: <strong style={{ color: theme.gold }}>{splitWindows.embargoDays} day{splitWindows.embargoDays === 1 ? "" : "s"}</strong> per edge</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── STEP 2: Column Config ───────────────────────────────── */}
      {mode === "free" && columns.length > 0 && !configured && (
        <div style={s.card}>
          <div style={s.h2}>2 — Configure Result Columns</div>
          <p style={{ color: theme.textMuted, fontSize: 12, marginBottom: 12 }}>Select outcome (win) columns and the loss column. Each outcome column creates a separate result group.</p>

          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Outcome Columns (click to toggle)</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {columns.map(col => (
                <button key={col} onClick={() => toggleOutcomeCol(col)}
                  style={{ ...s.chip(outcomeColumns.includes(col)), ...(col === lossColumn ? { opacity: 0.3, pointerEvents: "none" } : {}) }}>
                  {col}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Loss Column</label>
            <select style={s.select} value={lossColumn} onChange={e => setLossColumn(e.target.value)}>
              <option value="">Select...</option>
              {columns.filter(c => !outcomeColumns.includes(c)).map(col => (
                <option key={col} value={col}>{col}</option>
              ))}
            </select>
          </div>

          {outcomeColumns.length > 0 && lossColumn && (
            <button style={s.btn} onClick={() => setConfigured(true)}>
              Confirm Configuration
            </button>
          )}
        </div>
      )}

      {/* ── Configured summary ──────────────────────────────────── */}
      {mode === "free" && configured && (
        <div style={{ ...s.card, padding: "10px 20px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: theme.textMuted, fontSize: 11 }}>CONFIG</span>
          <span>Outcomes: {outcomeColumns.map(c => <span key={c} style={{ ...s.tag, borderColor: theme.green, color: theme.green }}>{c}</span>)}</span>
          <span>Loss: <span style={{ ...s.tag, borderColor: theme.red, color: theme.red }}>{lossColumn}</span></span>
          <button style={{ ...s.btnOutline, fontSize: 11, padding: "3px 10px" }} onClick={() => setConfigured(false)}>Edit</button>
        </div>
      )}

      {/* ── STEP 3: Filters ─────────────────────────────────────── */}
      {mode === "free" && configured && (
        <div style={s.card}>
          <div style={{ ...s.h2, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span>3 — Filters & Grouping</span>
            <button
              style={{ ...s.btnOutline, fontSize: 11, textTransform: "none", letterSpacing: "normal", fontWeight: 400 }}
              onClick={() => setShowPasteModal(true)}
            >
              Paste filters JSON
            </button>
          </div>

          {/* Filter groups */}
          {filterGroups.map((group, gi) => (
            <div key={gi} style={{
              background: gi === activeGroupIdx ? theme.surfaceAlt : "transparent",
              border: `1px solid ${gi === activeGroupIdx ? theme.accent : theme.border}`,
              borderRadius: 6, padding: 12, marginBottom: 10, cursor: "pointer"
            }} onClick={() => setActiveGroupIdx(gi)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: group.length > 0 ? 8 : 0 }}>
                <span style={{ fontSize: 11, color: theme.textMuted, fontWeight: 600 }}>
                  {gi > 0 && <span style={{ color: theme.gold, marginRight: 8 }}>OR</span>}
                  GROUP {gi + 1} {group.length === 0 && <span style={{ fontWeight: 400 }}>(empty — add conditions below)</span>}
                </span>
                {filterGroups.length > 1 && (
                  <button style={s.btnDanger} onClick={(e) => { e.stopPropagation(); removeFilterGroup(gi); }}>Remove Group</button>
                )}
              </div>
              {group.length > 0 && (
                <div>
                  {group.map((f, fi) => (
                    <span key={f.id} style={{ ...s.tag, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                      onClick={(e) => { e.stopPropagation(); setNewFilter({ column: f.column, operator: f.operator, value: f.value || "" }); }}>
                      {fi > 0 && <span style={{ color: theme.textMuted, marginRight: 4 }}>AND</span>}
                      <strong>{f.column}</strong> {OPERATORS.find(o => o.value === f.operator)?.label} {f.value}
                      <span style={{ cursor: "pointer", color: theme.red, marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); removeFilter(gi, f.id); }}>×</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Add filter to active group */}
          <div style={{ ...s.row, marginBottom: 12 }}>
            <div>
              <label style={s.label}>Column</label>
              <select style={s.select} value={newFilter.column} onChange={e => setNewFilter(p => ({ ...p, column: e.target.value }))}>
                <option value="">Select...</option>
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label}>Operator</label>
              <select style={s.select} value={newFilter.operator} onChange={e => setNewFilter(p => ({ ...p, operator: e.target.value }))}>
                {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {!["not_empty", "empty"].includes(newFilter.operator) && (
              <div>
                <label style={s.label}>Value {newFilter.operator === "between" && "(lo, hi)"}</label>
                {DOW_OPERATORS.includes(newFilter.operator) ? (
                  <select
                    style={s.select}
                    value={newFilter.value}
                    onChange={e => setNewFilter(p => ({ ...p, value: e.target.value }))}
                  >
                    <option value="">Select...</option>
                    {DOW_LABELS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                ) : (
                  <input style={s.input} value={newFilter.value} onChange={e => setNewFilter(p => ({ ...p, value: e.target.value }))}
                    placeholder={newFilter.operator === "between" ? "10, 50" : "value"} />
                )}
              </div>
            )}
            <button style={s.btn} onClick={addFilter}>Add to Group {activeGroupIdx + 1}</button>
          </div>

          <div style={{ marginBottom: 16 }}>
            <button style={s.btnOutline} onClick={addFilterGroup}>+ Add OR Group</button>
          </div>

          {/* Group by */}
          <div style={s.row}>
            <div>
              <label style={s.label}>Group By</label>
              <select style={s.select} value={groupByCol} onChange={e => setGroupByCol(e.target.value)}>
                <option value="">No grouping</option>
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {groupByCol && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.text, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={groupKeyMode === "hour"}
                  onChange={e => setGroupKeyMode(e.target.checked ? "hour" : "raw")}
                />
                Group by hour
              </label>
            )}
            {groupByCol && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.text, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={groupKeyMode === "dow"}
                  onChange={e => setGroupKeyMode(e.target.checked ? "dow" : "raw")}
                />
                Group by day of week
              </label>
            )}
            {groupByCol && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.text, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={groupKeyMode === "wom"}
                  onChange={e => setGroupKeyMode(e.target.checked ? "wom" : "raw")}
                />
                Group by week of month
              </label>
            )}
            {groupByCol && (
              <button style={s.btnOutline} onClick={() => { setGroupByCol(""); setGroupKeyMode("raw"); }}>Clear Grouping</button>
            )}
          </div>

          {/* Daily / session loss limit */}
          {(() => {
            const _sessMins = parseTimeToMinutes(dailyLossLimitSessionStart);
            const _sessionActive = Boolean(dailyLossLimitTimeCol) && _sessMins != null;
            const _sessionInvalid = Boolean(dailyLossLimitSessionStart) && _sessMins === null;
            const _formattedStart = _sessMins != null
              ? `${String(Math.floor(_sessMins / 60)).padStart(2, "0")}:${String(_sessMins % 60).padStart(2, "0")}`
              : "";
            return (
              <div style={{ borderTop: `1px solid ${theme.border}`, marginTop: 16, paddingTop: 16 }}>
                <label style={{ ...s.label, marginBottom: 8 }}>Daily / Session Loss Limit</label>
                <div style={s.row}>
                  <div>
                    <label style={s.label}>Date Column</label>
                    <select style={s.select} value={dailyLossLimitCol} onChange={e => setDailyLossLimitCol(e.target.value)}>
                      <option value="">None (disabled)</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={s.label}>Max Losses</label>
                    <input
                      style={{ ...s.input, width: 80 }}
                      type="number"
                      min="1"
                      placeholder="e.g. 3"
                      value={dailyLossLimit}
                      onChange={e => setDailyLossLimit(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={s.label}>Bar Time Column (optional)</label>
                    <select style={s.select} value={dailyLossLimitTimeCol} onChange={e => setDailyLossLimitTimeCol(e.target.value)}>
                      <option value="">None (by date)</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={s.label}>Session Start (HHMM)</label>
                    <input
                      style={{ ...s.input, width: 100 }}
                      type="text"
                      placeholder="e.g. 1800"
                      value={dailyLossLimitSessionStart}
                      onChange={e => setDailyLossLimitSessionStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={s.label}>Loss Time Column (optional)</label>
                    <select style={s.select} value={dailyLossLimitLossTimeCol} onChange={e => setDailyLossLimitLossTimeCol(e.target.value)}>
                      <option value="">None (loss = entry time)</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {(dailyLossLimitCol || dailyLossLimit || dailyLossLimitTimeCol || dailyLossLimitSessionStart || dailyLossLimitLossTimeCol) && (
                    <button style={s.btnOutline} onClick={() => { setDailyLossLimitCol(""); setDailyLossLimit(""); setDailyLossLimitTimeCol(""); setDailyLossLimitSessionStart(""); setDailyLossLimitLossTimeCol(""); }}>Clear</button>
                  )}
                </div>
                {dailyLossLimitCol && dailyLossLimit && (
                  <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 6 }}>
                    {_sessionActive
                      ? (dailyLossLimitLossTimeCol
                          ? `After ${dailyLossLimit} loss${dailyLossLimit !== "1" ? "es" : ""} are realized within a session (sessions roll at ${_formattedStart}), entries placed AFTER that point are excluded. Trades already open when the limit is hit keep running and their losses still register.`
                          : `After ${dailyLossLimit} loss${dailyLossLimit !== "1" ? "es" : ""} within a session (sessions roll at ${_formattedStart}), remaining events in that session are excluded. Without a Loss Time Column, losses are treated as realized at entry time.`)
                      : `After ${dailyLossLimit} loss${dailyLossLimit !== "1" ? "es" : ""} on a given date, remaining events for that date are excluded.`}
                  </p>
                )}
                {dailyLossLimitLossTimeCol && !_sessionActive && (
                  <p style={{ color: theme.gold, fontSize: 11, marginTop: 4 }}>
                    Loss Time Column is set but Bar Time Column / Session Start aren&apos;t — loss-time-aware sweep needs all three. Falling back to entry-time approximation.
                  </p>
                )}
                {_sessionInvalid && (
                  <p style={{ color: theme.gold, fontSize: 11, marginTop: 4 }}>
                    Session Start &quot;{dailyLossLimitSessionStart}&quot; could not be parsed (use HHMM or HH:MM, 00:00–23:59). Falling back to date buckets.
                  </p>
                )}
                {dailyLossLimitTimeCol && !dailyLossLimitSessionStart && dailyLossLimitCol && dailyLossLimit && (
                  <p style={{ color: theme.gold, fontSize: 11, marginTop: 4 }}>
                    Bar Time Column is set but Session Start is empty — still bucketing by date. Enter a Session Start to enable session mode.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Overlap filter */}
          <div style={{ borderTop: `1px solid ${theme.border}`, marginTop: 16, paddingTop: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: theme.text, cursor: "pointer", marginBottom: 8 }}>
              <input type="checkbox" checked={overlapEnabled} onChange={e => setOverlapEnabled(e.target.checked)} />
              <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: theme.textMuted, fontSize: 11 }}>
                Overlap Filter (exclude rows entering while a prior event is still active)
              </span>
            </label>
            {overlapEnabled && (
              <div style={{ background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 6, padding: 12 }}>
                <div style={{ ...s.row, marginBottom: 10 }}>
                  <div>
                    <label style={s.label}>Entry Date Column</label>
                    <select style={s.select} value={overlapEntryDateCol} onChange={e => setOverlapEntryDateCol(e.target.value)}>
                      <option value="">Select...</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={s.label}>Entry Time Column</label>
                    <select style={s.select} value={overlapEntryTimeCol} onChange={e => setOverlapEntryTimeCol(e.target.value)}>
                      <option value="">Select...</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={s.label}>Loss DateTime Column</label>
                    <select style={s.select} value={overlapLossTimeCol} onChange={e => setOverlapLossTimeCol(e.target.value)}>
                      <option value="">Select...</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={s.label}>Exit DateTime per Outcome</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {outcomeColumns.length === 0 && (
                      <span style={{ color: theme.textMuted, fontSize: 11 }}>Configure outcome columns first.</span>
                    )}
                    {outcomeColumns.map(oc => (
                      <div key={oc}>
                        <label style={{ ...s.label, color: theme.green }}>{oc}</label>
                        <select
                          style={s.select}
                          value={overlapExitMap[oc] || ""}
                          onChange={e => setOverlapExitMap(prev => ({ ...prev, [oc]: e.target.value }))}
                        >
                          <option value="">Select exit datetime...</option>
                          {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={s.row}>
                  <div>
                    <label style={s.label}>Mode</label>
                    <select style={s.select} value={overlapMode} onChange={e => setOverlapMode(e.target.value)}>
                      <option value="always">Exclude all overlapping</option>
                      <option value="excludeIfMatch">Exclude if compare column MATCHES active</option>
                      <option value="excludeIfDiffer">Exclude if compare column DIFFERS from active</option>
                    </select>
                  </div>
                  {overlapMode !== "always" && (
                    <div>
                      <label style={s.label}>Compare Column</label>
                      <select style={s.select} value={overlapCompareCol} onChange={e => setOverlapCompareCol(e.target.value)}>
                        <option value="">Select...</option>
                        {columns.map(c => <option key={c} value={c}>{c}</option>)}
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
                      value={overlapEntryOffsetMinutes}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setOverlapEntryOffsetMinutes(Number.isFinite(n) && n >= 0 ? n : 0);
                      }}
                    />
                  </div>
                </div>

                <p style={{ color: theme.textMuted, fontSize: 11, marginTop: 10, marginBottom: 0 }}>
                  Active period = entry → (loss datetime if row is a loss, else the selected outcome's exit datetime). Touching (entry = prior exit) is included. Excluded rows cannot block later rows. Rows with no determinable exit pass through but never block.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 4: Results ─────────────────────────────────────── */}
      {mode === "free" && configured && computeResults && (
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <div style={s.h2}>4 — Results</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={s.chip(activeTab === "in")} onClick={() => setActiveTab("in")}>In-Sample</button>
              <button
                style={{ ...s.chip(activeTab === "out"), ...(effectiveOutSample ? {} : { opacity: 0.3, pointerEvents: "none" }) }}
                onClick={() => effectiveOutSample && setActiveTab("out")}>
                Out-of-Sample
              </button>
            </div>
          </div>

          {renderVerificationBar()}

          <div style={{ marginTop: 16, overflowX: "auto" }}>
            {computeResults.type === "ungrouped" && (
              outcomeColumns.map(oc => (
                <MetricsTable key={oc} metrics={computeResults.results[oc]} label={oc} />
              ))
            )}
            {computeResults.type === "grouped" && (
              outcomeColumns.map(oc => (
                <GroupedTable key={oc} grouped={computeResults.grouped} keys={computeResults.keys} outcomeCol={oc} />
              ))
            )}
          </div>

          {computeResults.totalRows === 0 && (
            <p style={{ color: theme.gold, textAlign: "center", padding: 20 }}>No rows match current filters.</p>
          )}
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────── */}
      <div style={{ textAlign: "center", color: theme.textMuted, fontSize: 10, marginTop: 24, padding: 16 }}>
        All values in risk units as provided in source data — verify row counts before reporting results
      </div>

      {showPasteModal && (
        <FiltersPasteModal
          columns={columns}
          onApply={applyFilterSnapshot}
          onCancel={() => setShowPasteModal(false)}
        />
      )}
    </div>
  );
}