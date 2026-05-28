// Modal for pasting a downloaded filter .txt back into the live filter UI.
// Used by both Free Mode (App.jsx) and Procedure Mode (FilterControls).
//
// Flow:
//   1. User pastes JSON into the textarea.
//   2. parseFiltersJson detects the shape (single / lineage / optimizer
//      bundle) and returns a list of selectable snapshots.
//   3. When the user picks one (or there's only one), normalizeSnapshot
//      coerces it into the canonical filters shape and surfaces warnings
//      for any columns it references that aren't in the current CSV.
//   4. Apply hands the normalized filters object to the parent, which
//      replaces its current filter state.

import { useState, useMemo } from "react";
import { theme, s } from "./theme.js";
import { parseFiltersJson, normalizeSnapshot } from "./filtersFromJson.js";

export default function FiltersPasteModal({ columns, onApply, onCancel }) {
  const [text, setText] = useState("");
  const [optionIdx, setOptionIdx] = useState(0);

  const parsed = useMemo(() => {
    if (!text.trim()) return { errors: [], options: [], kind: null };
    return parseFiltersJson(text);
  }, [text]);

  // Snap the picker back to 0 whenever new text comes in (otherwise the
  // index can point past the new option array). Doing this in the change
  // handler instead of a useEffect avoids the setState-in-effect lint.
  const handleTextChange = (e) => {
    setText(e.target.value);
    setOptionIdx(0);
  };

  const selected = parsed.options[optionIdx] || null;
  const normalized = useMemo(() => {
    if (!selected) return null;
    return normalizeSnapshot(selected.snapshot, columns);
  }, [selected, columns]);

  const handleApply = () => {
    if (!normalized) return;
    onApply(normalized.filters);
  };

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
          border: `2px solid ${theme.accent}`,
          borderRadius: 8,
          padding: 24,
          maxWidth: 720,
          width: "90%",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...s.h2, color: theme.accent, marginBottom: 8 }}>
          Paste filters JSON
        </div>
        <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 10 }}>
          Paste the contents of a downloaded filter .txt — single version,
          lineage chain, or optimizer steps bundle. A fragment like just
          the inner <code>&quot;filters&quot;: &#123;...&#125;</code>{" "}
          (copied from a lineage chain entry) also works. Replaces the
          current filter setup when applied.
        </div>
        <textarea
          rows={10}
          autoFocus
          spellCheck={false}
          style={{
            width: "100%",
            background: theme.bg,
            color: theme.text,
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            padding: 8,
            fontFamily: "inherit",
            fontSize: 11,
            outline: "none",
            resize: "vertical",
            marginBottom: 10,
            boxSizing: "border-box",
          }}
          value={text}
          onChange={handleTextChange}
          placeholder='Paste here, e.g. {"filterGroups": [...], "dailyLossLimit": {...}, "overlap": {...}}'
        />

        {parsed.errors.length > 0 && (
          <div style={{ color: theme.red, fontSize: 11, marginBottom: 8 }}>
            {parsed.errors.map((e, i) => (
              <div key={i}>✗ {e}</div>
            ))}
          </div>
        )}

        {parsed.kind && parsed.options.length > 0 && (
          <div
            style={{
              fontSize: 11,
              color: theme.textMuted,
              marginBottom: 8,
            }}
          >
            Detected:{" "}
            <strong style={{ color: theme.text }}>{parsed.kind}</strong> ·{" "}
            {parsed.options.length} option
            {parsed.options.length === 1 ? "" : "s"}
          </div>
        )}

        {parsed.options.length > 1 && (
          <div style={{ marginBottom: 10 }}>
            <label style={s.label}>Pick a snapshot to apply</label>
            <select
              style={{ ...s.select, width: "100%" }}
              value={optionIdx}
              onChange={(e) => setOptionIdx(parseInt(e.target.value, 10))}
            >
              {parsed.options.map((o, i) => (
                <option key={i} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {normalized && normalized.warnings.length > 0 && (
          <div
            style={{
              border: `1px solid ${theme.gold}`,
              borderRadius: 4,
              padding: 8,
              marginBottom: 10,
              fontSize: 11,
              color: theme.gold,
              maxHeight: 160,
              overflow: "auto",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {normalized.warnings.length} warning
              {normalized.warnings.length === 1 ? "" : "s"}:
            </div>
            {normalized.warnings.map((w, i) => (
              <div key={i}>• {w}</div>
            ))}
            <div style={{ marginTop: 6, color: theme.textMuted }}>
              You can still apply — just rebind any unmapped columns
              afterwards.
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            style={{
              ...s.btn,
              opacity: normalized ? 1 : 0.5,
              cursor: normalized ? "pointer" : "not-allowed",
            }}
            disabled={!normalized}
            onClick={handleApply}
          >
            Apply filters
          </button>
          <button style={s.btnOutline} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
