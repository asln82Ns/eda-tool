// Shared UI constants: color palette, reusable style objects, filter
// operator labels. Imported by both App.jsx (Free Mode) and
// ProcedureMode.jsx. Byte-for-byte copies of the original definitions.

export const theme = {
  bg: "#0f1117",
  surface: "#1a1d27",
  surfaceAlt: "#222636",
  border: "#2e3348",
  text: "#e2e4eb",
  textMuted: "#8b8fa3",
  accent: "#4f8ff7",
  green: "#34d399",
  red: "#f87171",
  gold: "#fbbf24",
};

export const s = {
  page: { background: theme.bg, color: theme.text, minHeight: "100vh", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", fontSize: 13, padding: 24 },
  card: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 20, marginBottom: 16 },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 4, letterSpacing: "-0.02em", color: theme.text },
  h2: { fontSize: 14, fontWeight: 600, marginBottom: 12, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" },
  h3: { fontSize: 13, fontWeight: 600, marginBottom: 8, color: theme.accent },
  label: { fontSize: 11, color: theme.textMuted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" },
  select: { background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 4, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", outline: "none", minWidth: 120 },
  input: { background: theme.surfaceAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 4, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", outline: "none", width: 120 },
  btn: { background: theme.accent, color: "#fff", border: "none", borderRadius: 4, padding: "7px 16px", fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: 600 },
  btnOutline: { background: "transparent", color: theme.accent, border: `1px solid ${theme.accent}`, borderRadius: 4, padding: "6px 14px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" },
  btnDanger: { background: "transparent", color: theme.red, border: `1px solid ${theme.red}`, borderRadius: 4, padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  tag: { display: "inline-block", background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 4, padding: "3px 8px", fontSize: 11, marginRight: 6, marginBottom: 4 },
  row: { display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", padding: "8px 12px", borderBottom: `2px solid ${theme.border}`, color: theme.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" },
  td: { padding: "6px 12px", borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" },
  file: { background: theme.surfaceAlt, border: `2px dashed ${theme.border}`, borderRadius: 8, padding: "24px 16px", textAlign: "center", cursor: "pointer", color: theme.textMuted, fontSize: 12 },
  chip: (active) => ({ padding: "6px 14px", borderRadius: 4, fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, border: `1px solid ${active ? theme.accent : theme.border}`, background: active ? theme.accent : "transparent", color: active ? "#fff" : theme.textMuted }),
};

export const OPERATORS = [
  { value: "equals", label: "=" },
  { value: "not_equals", label: "≠" },
  { value: "greater_than", label: ">" },
  { value: "less_than", label: "<" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
  { value: "between", label: "between" },
  { value: "not_empty", label: "has value" },
  { value: "empty", label: "is empty" },
  // Day-of-week operators — the value column should be a date column.
  // The actual day-of-week (Sun..Sat) is derived from the row's date,
  // not stored in the CSV.
  { value: "dow_equals", label: "day of week =" },
  { value: "dow_not_equals", label: "day of week ≠" },
];

// Operators whose value field is a fixed enum (rendered as a select rather
// than a free-text input).
export const DOW_OPERATORS = ["dow_equals", "dow_not_equals"];
