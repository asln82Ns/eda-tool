# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run lint` — ESLint (flat config, `eslint.config.js`)
- `npm run preview` — preview production build

## Architecture

Single-page React app (Vite + React 19, no TypeScript, no router, no state library). No backend; all processing is client-side.

**Modules:**
- `src/App.jsx` — Free Mode (the original monolithic UI for ad-hoc filtering)
- `src/ProcedureMode.jsx` — walk-forward Procedure Mode with version history, OOS reveal, and auto-optimizer integration
- `src/autoOptimize.js` — pure search functions for the auto-optimizer (no React)
- `src/metrics.js` — pure shared helpers: `runPipeline`, `applyFilters`, `applyDailyLossLimit`, `applyOverlapFilter`, `buildReturnSeries(Dated)`, `calcMetrics`, date helpers. **Single source of truth** — Free Mode, Procedure Mode, and the optimizer all go through these
- `src/theme.js` — dark-theme inline-style constants and OPERATORS list
- `scripts/verifyOptimizer.mjs` — Node parity test for the optimizer (run via `node scripts/verifyOptimizer.mjs`)

**Pipeline order (every mode, every code path):**
`applyFilters → per-outcome { applyOverlapFilter(outcomeCol) → applyDailyLossLimit(outcomeCol) → buildReturnSeriesDated → calcMetrics }`. Overlap runs BEFORE DLL so a trade that would have been overlap-excluded (a prior trade was already open) cannot consume any of the daily-loss budget. Overlap and DLL both run inside the per-outcome loop and are passed the active outcome column. A row whose outcome cell is populated is treated as a winner for that outcome — its loss column is suppressed for DLL loss-event counting and for overlap exit-time selection. This matches `buildReturnSeries`'s "outcome wins" rule and keeps all three stages consistent on rows where loss + outcome are both populated. The optimizer never duplicates this math; it builds candidate filter snapshots and feeds them into `runPipeline`.

**Overlap entry-offset:** bar timestamps in source CSVs name the OPEN of the bar, but signal-based entries fire at bar close. The overlap filter accepts an `entryOffsetMinutes` (set to bar duration — 60 for 60-min bars, 90 for 90-min bars) that shifts the entry timestamp forward before checking against active trades. Exit timestamps come from absolute datetime columns and are NOT shifted.

**Procedure Mode:**
- Walk-forward IS/OOS windows with optional embargo. Each step rolls IS forward by one OOS step.
- Each commit creates a new immutable version (or reuses leading if filters unchanged). Deprecated versions are shadow-tracked on every subsequent step.
- Persisted to localStorage; CSV signature gates resume. Schema = `STORAGE_KEY` + `SCHEMA_VERSION` (currently 4; v1 → v2 → v3 → v4 migrations are automatic). v4 added the overlap entry-offset and flipped pipeline order to overlap → DLL.
- Equity chart on the complete screen seeds new versions at the predecessor's cumulative R so the line is continuous across version changes (not jumping back to 0). When the optimizer is enabled, an extra dashed-gold "AUTO" line is overlaid on the same chart.

**Auto-Optimizer (Procedure Mode only):**
- Configured at procedure setup (toggle + fixed filters + candidate parameters + weights + top-K).
- Runs at every step's commit, on the same IS rows. Per-outcome winners are saved alongside the manual version's results and replayed on OOS.
- Phases: (0) baseline = fixed filters only; (1) test each candidate individually with `minOccurrences` gate; (2) for each outcome, take top-K survivors and test all subsets of size ≥ 2 (deduped across outcomes).
- Scoring: percentile-rank within the candidate pool for each metric (RU/trade, Net RU, Max DD), weighted sum. Winner = highest score ≥ baseline; ties broken by fewer total conditions.
- Distinct-value enumeration is **IS-only and post-fixed-`applyFilters`** — never peeks at OOS, never tests values fixed filters already exclude.

**Key domain concepts:**
- Each CSV row is a trade event. Outcome columns hold win values; the loss column holds negative loss values. A row has either an outcome value OR a loss value, not both.
- `buildReturnSeries()` merges outcome + loss columns into a single return array per outcome strategy.
- `calcMetrics()` computes trading statistics (win rate, net return, drawdowns, etc.) from a return series. All values are in "risk units" (R-multiples), not dollars.
- Filters use `applyFilters()` with operators like equals, between, gte, etc. Conditions within a group are AND'd; groups are OR'd. Grouping uses `groupRows()` to break results by a descriptor column.

**Styling:** Dark theme via inline style objects (`theme` and `s` constants from `src/theme.js`). No CSS framework, no CSS modules.

## Lint Rules

- ESLint flat config with `react-hooks` and `react-refresh` plugins
- `no-unused-vars` ignores variables starting with uppercase or underscore (`varsIgnorePattern: '^[A-Z_]'`)
