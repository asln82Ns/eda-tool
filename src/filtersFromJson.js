// Parse a filter snapshot (or chain/bundle) from a JSON-text source — the
// same shapes the "Download filters .txt" buttons emit:
//   1. single snapshot: { filterGroups, dailyLossLimit, overlap }
//   2. lineage chain:   { lineageFor, chain: { Vid: { filters, appliedFromStep, ... } } }
//   3. optimizer bundle:{ outcome, steps: { step_N: { filters, window, candidatesUsed, ... } } }
// Used by the paste-filters modal to round-trip a downloaded filter set
// back into the live UI.

import { OPERATORS } from "./theme.js";

// Tolerant JSON parse for paste fragments. Tries:
//   1. The text as-is (the happy path: a complete JSON object).
//   2. Same text with a trailing comma stripped (common when copying out
//      of an enclosing array or object).
//   3. The text wrapped in {} (handles fragments like `"filters": {...}`
//      copied straight out of a lineage chain entry).
// Returns the parsed value or null. Captures the *first* parse error so
// the UI can show something useful when every strategy fails.
function tryParseTolerant(text) {
  const trimmed = text.trim();
  if (!trimmed) return { data: null, error: "Input is empty." };

  let firstError = null;
  const tryOne = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      if (firstError === null) firstError = e.message;
      return undefined;
    }
  };

  let parsed = tryOne(trimmed);
  if (parsed !== undefined) return { data: parsed, error: null };

  // Strip a trailing comma if it's the last non-whitespace character.
  let stripped = trimmed.replace(/,\s*$/, "");
  if (stripped !== trimmed) {
    parsed = tryOne(stripped);
    if (parsed !== undefined) return { data: parsed, error: null };
  }

  // Wrap fragments that look like an object's body. Guarded by a leading
  // quote so we don't try to wrap obviously malformed input (it'd just
  // fail again with a less useful error).
  if (stripped.startsWith('"')) {
    parsed = tryOne("{" + stripped + "}");
    if (parsed !== undefined) return { data: parsed, error: null };
  }

  return { data: null, error: firstError || "Could not parse as JSON." };
}

// If the parsed JSON wraps the snapshot in a single key, unwrap it. This
// makes `{"filters": {...}}` (a paste fragment from a chain entry) and
// `{"Vid": {"filters": {...}}}` (a whole chain entry) both behave like a
// direct snapshot.
function unwrapSnapshot(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const keys = Object.keys(data);
  if (keys.length === 1) {
    const inner = data[keys[0]];
    if (
      keys[0] === "filters" &&
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner)
    ) {
      return inner;
    }
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      inner.filters &&
      typeof inner.filters === "object"
    ) {
      return inner.filters;
    }
  }
  return data;
}

// Try JSON.parse + detect the shape. Returns:
//   { errors: string[], options: [{label, snapshot}], kind }
//   kind ∈ "single" | "lineage" | "optimizer" | null
// On unrecognized / invalid input, errors is non-empty and options is [].
export function parseFiltersJson(text) {
  const { data: rawData, error } = tryParseTolerant(text);
  if (rawData == null) {
    return {
      errors: [`Invalid JSON: ${error || "empty input"}`],
      options: [],
      kind: null,
    };
  }
  let data = rawData;
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return {
      errors: ["Top-level JSON must be an object."],
      options: [],
      kind: null,
    };
  }
  data = unwrapSnapshot(data);
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return {
      errors: ["Could not unwrap to a filter object."],
      options: [],
      kind: null,
    };
  }

  // Lineage chain
  if (data.chain && typeof data.chain === "object" && !Array.isArray(data.chain)) {
    const opts = [];
    for (const [vid, entry] of Object.entries(data.chain)) {
      if (entry && entry.filters) {
        const range =
          entry.appliedFromStep && entry.appliedToStep
            ? ` (steps ${entry.appliedFromStep}–${entry.appliedToStep})`
            : "";
        opts.push({ label: `${vid}${range}`, snapshot: entry.filters });
      }
    }
    if (opts.length === 0) {
      return {
        errors: ["Lineage chain has no entries with filters."],
        options: [],
        kind: "lineage",
      };
    }
    return { errors: [], options: opts, kind: "lineage" };
  }

  // Optimizer per-step bundle
  if (
    data.steps &&
    typeof data.steps === "object" &&
    !Array.isArray(data.steps) &&
    typeof data.outcome === "string"
  ) {
    const opts = [];
    for (const [stepKey, entry] of Object.entries(data.steps)) {
      if (entry && entry.filters) {
        const win = entry.window ? ` ${entry.window}` : "";
        const picks =
          Array.isArray(entry.candidatesUsed) && entry.candidatesUsed.length
            ? ` · ${entry.candidatesUsed.join(" ∧ ")}`
            : "";
        opts.push({
          label: `${stepKey}${win}${picks}`,
          snapshot: entry.filters,
        });
      }
    }
    if (opts.length === 0) {
      return {
        errors: ["Optimizer step bundle has no steps with filters."],
        options: [],
        kind: "optimizer",
      };
    }
    return { errors: [], options: opts, kind: "optimizer" };
  }

  // Single snapshot — recognize when ANY of the three known top-level
  // keys are present so older / partial snapshots still load.
  if (
    Array.isArray(data.filterGroups) ||
    (data.dailyLossLimit && typeof data.dailyLossLimit === "object") ||
    (data.overlap && typeof data.overlap === "object")
  ) {
    return {
      errors: [],
      options: [{ label: "(single snapshot)", snapshot: data }],
      kind: "single",
    };
  }

  return {
    errors: [
      "Could not detect filter shape. Expected a top-level filterGroups, a lineage chain, or an optimizer steps bundle.",
    ],
    options: [],
    kind: null,
  };
}

// Validate field types, fill in defaults, assign fresh `id`s on conditions,
// emit warnings when columns referenced in the JSON aren't in the current
// CSV. Always returns a usable filters object even if input is partial —
// missing-CSV-column issues are warnings, not errors, so users can paste
// then rebind one column rather than retype everything.
export function normalizeSnapshot(snapshot, columns) {
  const warnings = [];
  const colSet = new Set(columns || []);
  const colOk = (name) => !name || colSet.has(name);
  let nextId = Date.now();

  const knownOps = new Set(OPERATORS.map((o) => o.value));
  const filterGroups = [];
  if (Array.isArray(snapshot.filterGroups)) {
    for (let gi = 0; gi < snapshot.filterGroups.length; gi++) {
      const group = snapshot.filterGroups[gi];
      if (!Array.isArray(group)) continue;
      const cleaned = [];
      for (const cond of group) {
        if (!cond || typeof cond !== "object") continue;
        const column = typeof cond.column === "string" ? cond.column : "";
        const operator =
          typeof cond.operator === "string" ? cond.operator : "";
        const value = cond.value == null ? "" : String(cond.value);
        if (!column || !operator) {
          warnings.push(
            `Group ${gi + 1}: skipped a filter with missing column or operator.`
          );
          continue;
        }
        if (!colOk(column)) {
          warnings.push(
            `Group ${gi + 1}: column "${column}" is not in the current CSV.`
          );
        }
        if (!knownOps.has(operator)) {
          warnings.push(
            `Group ${gi + 1}: operator "${operator}" is not recognized — kept as-is.`
          );
        }
        cleaned.push({ column, operator, value, id: ++nextId });
      }
      filterGroups.push(cleaned);
    }
  }
  // Always have at least one group so the UI's filterGroups.map renders
  // something (matches emptyFilters behavior).
  if (filterGroups.length === 0) filterGroups.push([]);

  const dllRaw =
    snapshot.dailyLossLimit && typeof snapshot.dailyLossLimit === "object"
      ? snapshot.dailyLossLimit
      : {};
  const dailyLossLimit = {
    col: typeof dllRaw.col === "string" ? dllRaw.col : "",
    value: dllRaw.value == null ? "" : String(dllRaw.value),
    timeCol: typeof dllRaw.timeCol === "string" ? dllRaw.timeCol : "",
    sessionStart:
      typeof dllRaw.sessionStart === "string" ? dllRaw.sessionStart : "",
    lossTimeCol:
      typeof dllRaw.lossTimeCol === "string" ? dllRaw.lossTimeCol : "",
  };
  if (!colOk(dailyLossLimit.col)) {
    warnings.push(
      `Daily loss limit: date column "${dailyLossLimit.col}" is not in the current CSV.`
    );
  }
  if (!colOk(dailyLossLimit.timeCol)) {
    warnings.push(
      `Daily loss limit: bar time column "${dailyLossLimit.timeCol}" is not in the current CSV.`
    );
  }
  if (!colOk(dailyLossLimit.lossTimeCol)) {
    warnings.push(
      `Daily loss limit: loss time column "${dailyLossLimit.lossTimeCol}" is not in the current CSV.`
    );
  }

  const ovRaw =
    snapshot.overlap && typeof snapshot.overlap === "object"
      ? snapshot.overlap
      : {};
  const overlap = {
    enabled: !!ovRaw.enabled,
    mode: typeof ovRaw.mode === "string" ? ovRaw.mode : "always",
    compareCol: typeof ovRaw.compareCol === "string" ? ovRaw.compareCol : "",
    entryDateCol:
      typeof ovRaw.entryDateCol === "string" ? ovRaw.entryDateCol : "",
    entryTimeCol:
      typeof ovRaw.entryTimeCol === "string" ? ovRaw.entryTimeCol : "",
    lossTimeCol:
      typeof ovRaw.lossTimeCol === "string" ? ovRaw.lossTimeCol : "",
    exitMap:
      ovRaw.exitMap &&
      typeof ovRaw.exitMap === "object" &&
      !Array.isArray(ovRaw.exitMap)
        ? Object.fromEntries(
            Object.entries(ovRaw.exitMap).filter(
              ([, v]) => typeof v === "string"
            )
          )
        : {},
    entryOffsetMinutes:
      Number.isFinite(Number(ovRaw.entryOffsetMinutes)) &&
      Number(ovRaw.entryOffsetMinutes) >= 0
        ? Number(ovRaw.entryOffsetMinutes)
        : 0,
  };
  if (!colOk(overlap.compareCol)) {
    warnings.push(
      `Overlap: compare column "${overlap.compareCol}" is not in the current CSV.`
    );
  }
  if (!colOk(overlap.entryDateCol)) {
    warnings.push(
      `Overlap: entry date column "${overlap.entryDateCol}" is not in the current CSV.`
    );
  }
  if (!colOk(overlap.entryTimeCol)) {
    warnings.push(
      `Overlap: entry time column "${overlap.entryTimeCol}" is not in the current CSV.`
    );
  }
  if (!colOk(overlap.lossTimeCol)) {
    warnings.push(
      `Overlap: loss time column "${overlap.lossTimeCol}" is not in the current CSV.`
    );
  }
  for (const [oc, col] of Object.entries(overlap.exitMap)) {
    if (!colOk(col)) {
      warnings.push(
        `Overlap exit map: "${oc}" → "${col}" — column not in the current CSV.`
      );
    }
  }

  return {
    filters: { filterGroups, dailyLossLimit, overlap },
    warnings,
  };
}
