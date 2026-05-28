// Pure helpers shared by Free Mode (App.jsx) and Procedure Mode
// (ProcedureMode.jsx). No React state, no side effects. Byte-for-byte
// copies of the original App.jsx implementations so Free Mode behavior
// is unchanged.

// ── Metric Calculations ──────────────────────────────────────────────
export function buildReturnSeries(rows, outcomeCol, lossCol) {
  const series = [];
  for (const row of rows) {
    const winRaw = row[outcomeCol];
    const lossRaw = row[lossCol];
    const hasWin = winRaw !== "" && winRaw != null && winRaw !== undefined;
    const hasLoss = lossRaw !== "" && lossRaw != null && lossRaw !== undefined;

    if (hasWin) {
      const val = parseFloat(winRaw);
      if (!isNaN(val)) {
        series.push({ value: val, type: val === 0 ? "breakeven" : "win" });
      }
    } else if (hasLoss) {
      const val = parseFloat(lossRaw);
      if (!isNaN(val)) {
        series.push({ value: -Math.abs(val), type: "loss" });
      }
    }
  }
  return series;
}

// Like buildReturnSeries but also keeps the row's date string so callers
// can plot equity curves along a calendar axis. dateCol is optional — if
// omitted or the date is unparseable, `date` is null on that entry.
export function buildReturnSeriesDated(rows, outcomeCol, lossCol, dateCol) {
  const series = [];
  for (const row of rows) {
    const winRaw = row[outcomeCol];
    const lossRaw = row[lossCol];
    const hasWin = winRaw !== "" && winRaw != null && winRaw !== undefined;
    const hasLoss = lossRaw !== "" && lossRaw != null && lossRaw !== undefined;
    const date = dateCol ? parseDateToISO(row[dateCol]) : null;

    if (hasWin) {
      const val = parseFloat(winRaw);
      if (!isNaN(val)) {
        series.push({ value: val, type: val === 0 ? "breakeven" : "win", date });
      }
    } else if (hasLoss) {
      const val = parseFloat(lossRaw);
      if (!isNaN(val)) {
        series.push({ value: -Math.abs(val), type: "loss", date });
      }
    }
  }
  return series;
}

export function calcMetrics(entries) {
  if (entries.length === 0) {
    return { maxDD: 0, longestDD: 0, avgDDLength: 0, netReturn: 0, grossReturn: 0, grossLoss: 0, winCount: 0, lossCount: 0, breakEvenCount: 0, winPct: 0, avgReturn: 0, sortino: null, total: 0 };
  }
  const winCount = entries.filter(e => e.type === "win").length;
  const lossCount = entries.filter(e => e.type === "loss").length;
  const breakEvenCount = entries.filter(e => e.type === "breakeven").length;
  const total = entries.length;
  const winPct = total > 0 ? (winCount / total) * 100 : 0;

  const values = entries.map(e => e.value);
  const netReturn = values.reduce((s, v) => s + v, 0);
  const grossReturn = entries.filter(e => e.type === "win").reduce((s, e) => s + e.value, 0);
  const grossLoss = entries.filter(e => e.type === "loss").reduce((s, e) => s + e.value, 0);
  const avgReturn = total > 0 ? netReturn / total : 0;

  const target = 0;
  const sumSqDownside = values.reduce((s, v) => s + Math.pow(Math.min(0, v - target), 2), 0);
  const downsideDev = Math.sqrt(sumSqDownside / total);
  const sortino = downsideDev > 0 ? (avgReturn - target) / downsideDev : null;

  let cumulative = 0;
  let peak = 0;
  let maxDD = 0;
  let inDrawdown = false;
  let currentDDLength = 0;
  const drawdownLengths = [];

  for (const v of values) {
    cumulative += v;
    if (cumulative >= peak) {
      if (inDrawdown && currentDDLength > 0) {
        drawdownLengths.push(currentDDLength);
      }
      peak = cumulative;
      currentDDLength = 0;
      inDrawdown = false;
    } else {
      inDrawdown = true;
      currentDDLength++;
      const dd = peak - cumulative;
      if (dd > maxDD) maxDD = dd;
    }
  }
  if (inDrawdown && currentDDLength > 0) {
    drawdownLengths.push(currentDDLength);
  }

  const longestDD = drawdownLengths.length > 0 ? Math.max(...drawdownLengths) : 0;
  const avgDDLength = drawdownLengths.length > 0
    ? drawdownLengths.reduce((s, l) => s + l, 0) / drawdownLengths.length
    : 0;

  return { maxDD, longestDD, avgDDLength, netReturn, grossReturn, grossLoss, winCount, lossCount, breakEvenCount, winPct, avgReturn, sortino, total };
}

// ── Filter Logic ─────────────────────────────────────────────────────
export function rowMatchesCondition(row, f) {
  const val = row[f.column];
  const numVal = parseFloat(val);
  const target = f.value;
  const numTarget = parseFloat(target);
  switch (f.operator) {
    case "equals": return val === target;
    case "not_equals": return val !== target;
    case "greater_than": return !isNaN(numVal) && numVal > numTarget;
    case "less_than": return !isNaN(numVal) && numVal < numTarget;
    case "gte": return !isNaN(numVal) && numVal >= numTarget;
    case "lte": return !isNaN(numVal) && numVal <= numTarget;
    case "between": {
      const [lo, hi] = target.split(",").map(s => parseFloat(s.trim()));
      return !isNaN(numVal) && numVal >= lo && numVal <= hi;
    }
    case "not_empty": return val !== "" && val != null;
    case "empty": return val === "" || val == null;
    case "dow_equals":
    case "dow_not_equals": {
      // Day-of-week is derived from the row's date (column = date column).
      // Unparseable dates fail both equals and not-equals — treating them
      // as a third bucket would surprise users and break overlap with the
      // group-by-DOW buckets, which use the same DOW_LABELS mapping.
      const iso = parseDateToISO(val);
      if (!iso) return false;
      const dow = DOW_LABELS[new Date(iso + "T00:00:00Z").getUTCDay()];
      return f.operator === "dow_equals" ? dow === target : dow !== target;
    }
    default: return true;
  }
}

// filterGroups is an array of groups. Each group is an array of AND conditions.
// Groups are OR'd: a row passes if it matches ALL conditions in ANY group.
export function applyFilters(rows, filterGroups) {
  if (filterGroups.length === 0) return rows;
  return rows.filter(row => {
    return filterGroups.some(group =>
      group.every(f => rowMatchesCondition(row, f))
    );
  });
}

// Parse a time value ("0730", "730", "07:30", "07:30:00") to minutes since
// midnight. Returns null if empty or unparseable.
export function parseTimeToMinutes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let hh, mm;
  if (s.includes(":")) {
    const parts = s.split(":");
    hh = parseInt(parts[0], 10);
    mm = parseInt(parts[1] ?? "0", 10);
  } else {
    const padded = s.padStart(4, "0");
    hh = parseInt(padded.slice(0, 2), 10);
    mm = parseInt(padded.slice(2, 4), 10);
  }
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

// Parse a loss-time cell. Accepts either a full datetime
//   "YYYY-MM-DD HH:MM[:SS]" / "YYYY-MM-DDTHH:MM[:SS]"
// or a bare time "HH:MM" / "HHMM" / "HH:MM:SS". Returns
//   { date: "YYYY-MM-DD" | null, mins: number }   on success
//   null                                          when unparseable.
// The bare-time path leaves date null so the caller can pair it with the
// row's own bar date.
export function parseLossDateTime(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const dt = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (dt) {
    const hh = parseInt(dt[2], 10);
    const mm = parseInt(dt[3], 10);
    if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59)
      return null;
    return { date: dt[1], mins: hh * 60 + mm };
  }
  const bare = parseTimeToMinutes(s);
  if (bare == null) return null;
  return { date: null, mins: bare };
}

// Daily loss limit.
//
// Two algorithms in one function, picked by whether `lossTimeCol` is set
// (loss-time-aware sweep) or not (legacy sort-by-entry walk). Both share
// the same session bucketing — a trade belongs to the session it ENTERED.
//
//  Legacy (lossTimeCol falsy): walk rows in entry-time order. Once
//  lossCount ≥ limit, exclude every subsequent row in the bucket. Loss
//  counts are accumulated as if the loss realizes at the entry timestamp.
//  This is wrong whenever positions overlap — a trade entered while a
//  prior trade is still open shouldn't be retroactively blocked because
//  the prior trade later turned into a loss.
//
//  Sweep (lossTimeCol set): build two events per loss-bearing row (entry
//  + loss) and one event per non-loss row (entry only). Sort each session
//  bucket's events by (timestamp asc, kind: entry < loss at the same
//  timestamp, then origIdx). Walk:
//    - entry event → if lossCount ≥ limit at this moment, exclude.
//    - loss event  → if the trade wasn't excluded, lossCount++.
//  This honors "you don't know it's a loss until it's a loss." Trades
//  excluded by the gate did not happen, so their losses don't count.
//
// Backward compat: when lossTimeCol is empty or unparseable, the per-row
// loss event uses entry time as its sort key, which makes the sweep
// produce results byte-identical to the legacy walk. So a saved
// procedure with no lossTimeCol replays exactly as before.
// `outcomeCol` (optional) makes DLL outcome-aware. When set, a row whose
// outcome cell is populated does NOT generate a loss event — even if its
// loss column is also populated. This mirrors buildReturnSeries's "outcome
// wins" rule, so DLL agrees with the per-outcome metric calc on conflicted
// rows. Omit to get the legacy shared-DLL predicate (loss-column-only).
export function applyDailyLossLimit(rows, dateCol, lossCol, maxLosses, timeCol, sessionStartMinutes, lossTimeCol, outcomeCol) {
  if (!dateCol || !maxLosses || maxLosses <= 0) return rows;
  const sessionActive = Boolean(timeCol) && sessionStartMinutes != null;
  const lossTimeActive = Boolean(lossTimeCol);

  // Map a (date, minsFromMidnight) pair to "minutes from this bucket's
  // session start." Used for loss events whose timestamp may land on a
  // later calendar day than the bucket anchor (a session that crosses
  // midnight). For non-session mode there's no time axis at all, so
  // bucket sort keys revert to CSV row index — see below.
  function toBucketSortKey(bucketDate, dt) {
    if (!sessionActive) return null;
    if (!dt || dt.date == null) return null;
    const dayDelta =
      (new Date(dt.date + "T00:00:00Z").getTime() -
        new Date(bucketDate + "T00:00:00Z").getTime()) /
      86400000;
    return Math.round(dayDelta) * 1440 + dt.mins - sessionStartMinutes;
  }

  const items = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let bucket, entrySortKey, entryDate;
    if (sessionActive) {
      const isoDate = parseDateToISO(row[dateCol]);
      const mins = parseTimeToMinutes(row[timeCol]);
      if (isoDate === null || mins === null) {
        bucket = `__unparseable_${i}`;
        entrySortKey = 0;
        entryDate = null;
      } else if (mins >= sessionStartMinutes) {
        bucket = isoDate;
        entrySortKey = mins - sessionStartMinutes;
        entryDate = isoDate;
      } else {
        bucket = addDays(isoDate, -1);
        entrySortKey = 1440 - sessionStartMinutes + mins;
        entryDate = isoDate;
      }
    } else {
      bucket = row[dateCol] ?? "";
      entrySortKey = i;
      entryDate = null;
    }

    // Determine whether this row carries a loss and, if so, the event
    // sort key for the loss. Falls back to entrySortKey when lossTimeCol
    // is unset or its value is unparseable.
    const lossRaw = row[lossCol];
    const lossPopulated =
      lossRaw !== "" && lossRaw != null && lossRaw !== undefined;
    // Outcome-aware suppression: when outcomeCol is set and this row's
    // outcome cell is populated, the row is a winner for that outcome —
    // its loss-column value is shadow data and must not generate a DLL
    // loss event for this outcome's pass. When outcomeCol is omitted,
    // ocPopulated is false and behavior matches the legacy predicate.
    const ocRaw = outcomeCol ? row[outcomeCol] : undefined;
    const ocPopulated = ocRaw !== "" && ocRaw != null && ocRaw !== undefined;
    const hasLossVal =
      lossPopulated && !ocPopulated && !isNaN(parseFloat(lossRaw));

    let lossSortKey = null;
    if (hasLossVal) {
      lossSortKey = entrySortKey;
      if (lossTimeActive && sessionActive) {
        const dt = parseLossDateTime(row[lossTimeCol]);
        if (dt) {
          // Bare "HH:MM" loss time: pair with the entry row's bar date so
          // we have a full datetime to anchor against the session bucket.
          const dtForBucket = dt.date != null ? dt : { date: entryDate, mins: dt.mins };
          const k = toBucketSortKey(bucket, dtForBucket);
          // Clamp: a loss can't realize before the trade's own entry. If
          // parseable but precedes entry (data error), use entry instead.
          if (k != null && k >= entrySortKey) lossSortKey = k;
        }
      }
    }

    items[i] = {
      origIdx: i,
      bucket,
      entrySortKey,
      hasLossVal,
      lossSortKey,
    };
  }

  // Group by session bucket.
  const buckets = {};
  for (const it of items) {
    if (!buckets[it.bucket]) buckets[it.bucket] = [];
    buckets[it.bucket].push(it);
  }

  const excluded = new Set();
  for (const bucketItems of Object.values(buckets)) {
    // Two events per loss-bearing row (entry + loss), one per non-loss.
    // Tiebreak: at equal sortKey, entries fire before losses — a trade
    // entered "at the same instant" a prior trade lost cannot have known
    // about the loss yet.
    const events = [];
    for (const it of bucketItems) {
      events.push({ kind: 0, sortKey: it.entrySortKey, idx: it.origIdx }); // 0 = entry
      if (it.hasLossVal) {
        events.push({ kind: 1, sortKey: it.lossSortKey, idx: it.origIdx }); // 1 = loss
      }
    }
    events.sort((a, b) => {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      if (a.kind !== b.kind) return a.kind - b.kind;
      return a.idx - b.idx;
    });

    let lossCount = 0;
    for (const ev of events) {
      if (ev.kind === 0) {
        if (lossCount >= maxLosses) excluded.add(ev.idx);
      } else {
        // Excluded trades didn't actually take place — their loss can't
        // count toward the limit.
        if (!excluded.has(ev.idx)) lossCount++;
      }
    }
  }

  return rows.filter((_, i) => !excluded.has(i));
}

// ── Overlap filter helpers ───────────────────────────────────────────
export function buildEntryTs(row, dateCol, timeCol) {
  const d = row[dateCol];
  const t = row[timeCol];
  if (d == null || t == null) return null;
  const ds = String(d).trim();
  const ts = String(t).trim();
  if (!ds || !ts) return null;
  let hh, mm;
  if (ts.includes(":")) {
    const parts = ts.split(":");
    hh = parts[0] ?? "";
    mm = parts[1] ?? "00";
  } else {
    const padded = ts.padStart(4, "0");
    hh = padded.slice(0, 2);
    mm = padded.slice(2, 4);
  }
  hh = hh.padStart(2, "0");
  mm = mm.padStart(2, "0");
  if (isNaN(parseInt(hh, 10)) || isNaN(parseInt(mm, 10))) return null;
  return `${ds} ${hh}:${mm}`;
}

export function normalizeExitTs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = m[2].padStart(2, "0");
  return `${m[1]} ${hh}:${m[3]}`;
}

// Add `mins` minutes to a "YYYY-MM-DD HH:MM" timestamp, handling date
// rollover. Returns null if the input is not parseable. Used by the
// overlap filter's entryOffsetMinutes — bar timestamps name the open of
// the bar, but the trade can only be entered at the close, so we shift
// the entry timestamp forward by the bar duration before checking
// against active trades.
export function addMinutesToTs(ts, mins) {
  if (ts == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  const offset = Number(mins);
  if (!Number.isFinite(offset) || offset === 0) return ts;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  d.setUTCMinutes(d.getUTCMinutes() + offset);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${dy} ${hh}:${mi}`;
}

export function applyOverlapFilter(rows, opts) {
  if (!opts || !opts.enabled) return rows;
  const { mode, compareCol, entryDateCol, entryTimeCol, lossTimeCol, exitTimeCol, lossCol, outcomeCol, entryOffsetMinutes } = opts;
  if (!entryDateCol || !entryTimeCol) return rows;
  if (mode !== "always" && !compareCol) return rows;

  // Bar timestamps in the source data name the OPEN of the bar, but a
  // signal-based entry can only fire at the bar's close. Callers that know
  // the bar duration pass it in as `entryOffsetMinutes` so the overlap walk
  // compares trades by their actual entry time (open + duration). Exit
  // timestamps come from absolute datetime columns and are NOT shifted.
  const offsetMins = Number(entryOffsetMinutes) || 0;

  const indexed = rows.map((row, origIdx) => {
    const rawEntryTs = buildEntryTs(row, entryDateCol, entryTimeCol);
    const entryTs = offsetMins ? addMinutesToTs(rawEntryTs, offsetMins) : rawEntryTs;
    const lossRaw = lossCol ? row[lossCol] : undefined;
    const lossPopulated = lossRaw !== "" && lossRaw != null && lossRaw !== undefined;
    // Outcome-aware: a row whose active outcome cell is populated is treated
    // as a winner for THIS outcome's pass — the loss column is shadow data
    // for it, so the trade's exit-time comes from the outcome's exit column,
    // not lossTime. Matches buildReturnSeries's "outcome wins" rule. When
    // outcomeCol is omitted, falls back to the original loss-presence test.
    const ocRaw = outcomeCol ? row[outcomeCol] : undefined;
    const ocPopulated = ocRaw !== "" && ocRaw != null && ocRaw !== undefined;
    const hasLoss = lossPopulated && !ocPopulated;
    let exitTs = null;
    if (hasLoss) {
      if (lossTimeCol) exitTs = normalizeExitTs(row[lossTimeCol]);
    } else if (exitTimeCol) {
      exitTs = normalizeExitTs(row[exitTimeCol]);
    }
    return { row, origIdx, entryTs, exitTs };
  });

  const sortable = indexed.slice().sort((a, b) => {
    if (a.entryTs === b.entryTs) return a.origIdx - b.origIdx;
    if (a.entryTs === null) return 1;
    if (b.entryTs === null) return -1;
    return a.entryTs < b.entryTs ? -1 : 1;
  });

  const excluded = new Set();
  const active = [];
  for (const item of sortable) {
    if (item.entryTs === null) continue;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].exitTs <= item.entryTs) active.splice(i, 1);
    }
    let exclude = false;
    if (active.length > 0) {
      if (mode === "always") {
        exclude = true;
      } else if (mode === "excludeIfMatch") {
        exclude = active.some(a => a.row[compareCol] === item.row[compareCol]);
      } else if (mode === "excludeIfDiffer") {
        exclude = active.some(a => a.row[compareCol] !== item.row[compareCol]);
      }
    }
    if (exclude) {
      excluded.add(item.origIdx);
    } else if (item.exitTs !== null) {
      active.push({ row: item.row, exitTs: item.exitTs });
    }
  }
  return rows.filter((_, i) => !excluded.has(i));
}

// ── Full pipeline (filters → per-outcome overlap → per-outcome DLL → metrics) ──
// Single source of truth shared by Procedure Mode and the Auto-Optimizer.
// Anything that wants per-outcome OOS-style metrics for a `filters` snapshot
// goes through this function so all paths are byte-identical.
//
// Overlap runs BEFORE DLL: a trade you would never have taken (because an
// overlapping prior trade was already open) cannot realize a loss, so it
// must not consume any of the daily-loss budget. DLL therefore counts only
// losses on trades that actually survived the overlap walk.
//
// DLL also runs INSIDE the per-outcome loop so that on rows where the loss
// column AND the active outcome cell are both populated, the row is treated
// as a winner for that outcome (no DLL loss event) but still counts as a
// loss for outcomes whose cell is empty. This matches buildReturnSeries's
// "outcome wins" rule.
//
// Return shape: `afterFilterCount` is the post-applyFilters count (pre any
// per-outcome reduction). Per-outcome counts are exposed as:
//   - `perOutcome[oc].afterOverlapCount`: post-overlap, pre-DLL
//   - `perOutcome[oc].afterDLLCount`: post-DLL — equals `rowCount`, kept
//      for backward compatibility with consumers that read this field.
export function runPipeline(rows, filters, config) {
  const { outcomeCols, lossCol, dateCol } = config;
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

  const perOutcome = {};
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
    const returnSeries = buildReturnSeriesDated(ocRows, oc, lossCol, dateCol);
    perOutcome[oc] = {
      metrics: calcMetrics(returnSeries),
      returnSeries,
      rowCount: ocRows.length,
      afterOverlapCount: afterOverlap.length,
      afterDLLCount: ocRows.length,
    };
  }
  return {
    perOutcome,
    afterFilterCount: afterFilters.length,
    overlapActive: overlapReady,
  };
}

export function groupRows(rows, groupCol, keyFn) {
  const groups = {};
  for (const row of rows) {
    const raw = row[groupCol] ?? "(empty)";
    const key = keyFn ? keyFn(raw) : raw;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

// ── Group-by key transforms ──────────────────────────────────────────
// Map a date-string column to a day-of-week or week-of-month bucket so the
// grouping UI can offer "Group by day of week" / "Group by week of month"
// alongside the existing "Group by hour" toggle. All four modes go through
// groupRows via getGroupKeyFn — sorting is mode-aware (sortGroupKeys).
export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getGroupKeyFn(mode) {
  if (mode === "hour") {
    return (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n)) return "(unparseable)";
      return String(Math.floor(n / 100));
    };
  }
  if (mode === "dow") {
    return (v) => {
      const iso = parseDateToISO(v);
      if (!iso) return "(unparseable)";
      return DOW_LABELS[new Date(iso + "T00:00:00Z").getUTCDay()];
    };
  }
  if (mode === "wom") {
    return (v) => {
      const iso = parseDateToISO(v);
      if (!iso) return "(unparseable)";
      const day = parseInt(iso.slice(8, 10), 10);
      if (isNaN(day)) return "(unparseable)";
      // Cap at week 4: days 1-7 → 1, 8-14 → 2, 15-21 → 3, 22-31 → 4.
      return "Week " + Math.min(Math.ceil(day / 7), 4);
    };
  }
  return null; // raw
}

export function sortGroupKeys(keys, mode) {
  if (mode === "dow") {
    return [...keys].sort((a, b) => {
      const ai = DOW_LABELS.indexOf(a);
      const bi = DOW_LABELS.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }
  if (mode === "wom") {
    return [...keys].sort((a, b) => {
      const ma = a.match(/^Week (\d+)$/);
      const mb = b.match(/^Week (\d+)$/);
      if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
      if (ma) return -1;
      if (mb) return 1;
      return a.localeCompare(b);
    });
  }
  return [...keys].sort((a, b) => {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

// ── Format helpers ───────────────────────────────────────────────────
export const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "—");
export const fmtPct = (v) => (typeof v === "number" ? v.toFixed(1) + "%" : "—");

// ── Date parsing ─────────────────────────────────────────────────────
export function parseDateToISO(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00Z");
  const b = new Date(isoB + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
