# EDA Tool

Exploratory Data Analysis tool for trading event data. Client-side web app — upload CSVs, configure outcome columns, apply filters and groupings, and get standardized performance metrics. No backend, no database, everything runs in the browser.

## Features

- **Free Mode** — ad-hoc filtering and grouping on one or two datasets (IS + OOS) with tab switching
- **Procedure Mode** — walk-forward validation with immutable version history, OOS reveal at every step, and shadow-tracking of deprecated versions
- **Auto-Optimizer** — runs alongside Procedure Mode, searches user-configured candidate filters on each step's IS, picks per-outcome winners, replays them on OOS automatically
- **Multiple outcome columns** — each outcome column (exit strategy) gets its own metrics
- **Filter system** — filter rows by any column using operators (=, >, <, between, etc.). Conditions within a group are AND'd; groups are OR'd. Click any filter tag to copy its values into the creation fields for quick duplication across groups
- **Group by column** — break results down by any descriptor column (e.g., group by date, level, etc.)
- **Group by hour** — checkbox option that extracts the hour from a time column (e.g., 930 → 9, 1415 → 14) for hourly performance breakdowns
- **Daily loss limit** — set a date column and max losses per day. After N losses on a given date, all remaining events for that date are excluded (simulates "stop trading after N losses" rule)
- **Overlap filter** — exclude trades that overlap in time with already-active trades (per-outcome, with multiple modes)
- **Verification bar** — always shows source row count, filtered row count, and dropped rows

## Metrics

For every filter/group combination, the tool calculates:

| Metric | Description |
|---|---|
| Events | Total rows in the group |
| Wins / Losses / BE | Counts by outcome type |
| Win % | Wins / Events |
| Net Return | Sum of all returns (wins + losses) |
| Gross Win / Gross Loss | Sums by side |
| Avg R/Trade | Net Return / Events |
| Max DD | Largest peak-to-trough drawdown |
| Longest DD | Most consecutive events between equity highs |
| Avg DD Length | Average events per drawdown period |

All values are in risk units (R-multiples) as provided in the source CSV.

## How the Data Works

Each CSV row is one event (trade observation):

- **Descriptor columns** — date, time, price level, range rank, or any context variable
- **Outcome columns** — each represents a different exit strategy result, populated with a value (in risk units) when that exit triggered
- **Loss column** — populated with a negative value when the event was a loss. A row has either an outcome value or a loss value, not both

## Workflow

1. **Upload** — load in-sample CSV (required) and out-of-sample CSV (optional)
2. **Configure** — select outcome columns and the loss column
3. **Filter & Group** — add filter rules, set grouping, configure daily loss limit if needed
4. **Analyze** — review the metrics tables
5. **Validate** — switch to out-of-sample tab to run the same analysis against holdout data

## Filter Logic

Filters use an OR-of-AND-groups model:

- Each **group** contains conditions that are all AND'd together
- Multiple **groups** are OR'd — a row passes if it matches all conditions in any group

For complex overlapping conditions, expand into all valid combinations. Example: if you want (A OR B) AND (C OR D), create 4 groups: A+C, A+D, B+C, B+D. Click existing filter tags to quickly copy their values when building duplicate conditions across groups.

## Procedure Mode

Walk-forward validation. Define IS length, OOS step length, and optional embargo at setup; the procedure rolls IS forward by one OOS step at every commit.

- Committing the IS filters creates a new immutable **version** (or reuses the leading version if filters are unchanged). Replaced versions are deprecated but **shadow-tracked** — they continue running on every subsequent OOS step so you can see what would have happened.
- The complete-screen equity chart shows one line per version. New versions begin at their predecessor's cumulative R (not zero) so the chart is continuous across version changes.
- Persisted to localStorage; reloading the page resumes the procedure if the same CSV is uploaded.
- Per-version CSV export emits trades that survived the version's pre-overlap pipeline (filters + DLL), tagged by step.

## Auto-Optimizer

Optional, opt-in at procedure setup. Runs alongside the manual procedure on every step's commit and produces one **per-outcome winner** per step.

**You configure:**
- **Fixed filters** — applied at every step before search; never touched by the optimizer (overlap, persistent exclusions)
- **Candidate parameters** — what to search:
  - *Categorical (one value at a time)* — tests `column = each distinct value`
  - *Categorical (all OR-subsets)* — tests `column ∈ subset` for every non-empty subset (only use on small categorical columns, V ≤ ~12)
  - *Range ≥ / Range ≤* — tests `column ≥/≤ v` from 0 to max in increments
  - *Daily Loss Limit* — tests DLL value 0..max
- **Min Occurrences** — per parameter; candidates whose post-pipeline row count is below this for an outcome are discarded
- **Weights** — RU/trade, Net RU, Max DD (defaults equal). Higher = better, except Max DD where lower is better
- **Top-K** — how many of the best individual filters to combine in Phase 2 (default 8)

**How it picks a winner per outcome:**
1. **Phase 0** — baseline = fixed filters only.
2. **Phase 1** — every candidate is run individually through the same pipeline manual mode uses; thin candidates (< minOccurrences) are dropped; survivors that beat the baseline composite are kept.
3. **Phase 2** — top-K survivors are AND-combined; every non-singleton subset is run.
4. **Score** — for each metric, candidates are percentile-ranked within the pool; composite = weighted sum. Highest score that's at least baseline wins. **Tiebreaker: fewer total conditions wins** (Occam's razor).

**Distinct-value enumeration is IS-only and post-fixed-`applyFilters`** — the optimizer never peeks at OOS data and never tests values that fixed filters already exclude.

The optimizer's track appears as a dashed gold line on the main equity chart, alongside manual versions. Per-outcome aggregate metrics, per-step picks, and a CSV export for each outcome are in the "Auto-Optimizer Summary" section at the bottom of the complete screen.

## Running Locally

Requires Node.js v18+.

```bash
npm install
npm run dev
```

Opens at http://localhost:5173.

```bash
npm run build    # production build to dist/
npm run preview  # preview production build
```

## Limitations

- Client-side only. Practical CSV limit is ~50K rows.
- No data persistence — refreshing clears everything (intentional).
- No validation that in-sample and out-of-sample files are actually different datasets.
