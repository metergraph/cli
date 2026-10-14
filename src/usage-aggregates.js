import { GROUP_KEY } from "./read-contract.js";

// Ranking and prior-period comparison for grouped usage. Both work on reports
// already validated by usageAggregatesReport and say when the returned groups
// are not every group, so a ranking or a change is never presented as
// complete when it is not.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A group's value for one dimension. A metadata dimension's value is
// metadata_value, and the group of calls without one is told apart from an
// empty string.
const valueOf = (item, dimension) =>
  dimension.startsWith("metadata.") ? (item.has_value ? item.metadata_value ?? "" : null) : item[dimension];
// Groups are joined by the raw group values the validator kept (GROUP_KEY),
// never by display values, which can be null for text that is unsafe to show.
const byKey = (groupBy) => (item) =>
  item[GROUP_KEY] ?? JSON.stringify(groupBy.map((dimension) => valueOf(item, dimension) ?? null));
const desc = (pick) => (a, b) => {
  const left = pick(a);
  const right = pick(b);
  // Unknown values (null) rank last, whichever direction.
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};
const then = (...orders) => (a, b) => {
  for (const order of orders) {
    const result = order(a, b);
    if (result !== 0) return result;
  }
  return 0;
};

// The service orders groups by cost, then calls, then group key. Every other
// order is applied here over the returned groups.
const ORDERS = {
  cost: [desc((item) => item.cost_usd), desc((item) => item.calls)],
  "cost-per-call": [desc((item) => item.cost_per_call_usd), desc((item) => item.cost_usd)],
  calls: [desc((item) => item.calls), desc((item) => item.cost_usd)],
  errors: [desc((item) => item.error_calls), desc((item) => item.error_rate), desc((item) => item.calls)],
  "avg-latency": [desc((item) => item.latency.avg_ms), desc((item) => item.calls)],
  "p95-latency": [desc((item) => item.latency.p95_ms), desc((item) => item.calls)],
  day: [(a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0), desc((item) => item.cost_usd)],
};

// What each order means, for JSON and text output.
export const SORT_LABELS = Object.freeze({
  cost: "cost, highest first",
  "cost-per-call": "cost per call (cost_usd / calls), highest first",
  calls: "calls, most first",
  errors: "error calls, most first",
  "avg-latency": "mean latency over calls that reported one, highest first",
  "p95-latency": "estimated p95 latency (fixed histogram), highest first",
  day: "UTC day, oldest first",
});

// Orders the report's items and numbers them. A ranking other than by cost
// over a cut list (the service returns the top groups by cost) is not a
// ranking of every group, and says so.
export function rankReport(report, sort, notices) {
  const key = byKey(report.group_by);
  const order = then(...ORDERS[sort], (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const items = [...report.items].sort(order).map((item, index) => ({ rank: index + 1, ...item }));
  const rankingComplete = sort === "cost" || !report.truncated;
  if (!rankingComplete) notices.add("ranking_partial");
  return {
    ...report,
    items,
    sort: { by: sort, meaning: SORT_LABELS[sort], complete: rankingComplete },
  };
}

// The window to compare with, from the current window the service read.
// "previous" is the whole period before: for a preset of N UTC days, the N
// whole UTC days before the current UTC day's start, even though the current
// window ends part way through today. "previous-same-time" ends the prior
// window at the same elapsed time, so both windows are the same length.
export function priorWindow(window, mode) {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const length = window.preset === "utc_days" ? window.days * DAY_MS : until - since;
  const priorSince = since - length;
  const priorUntil = mode === "previous" ? since : priorSince + (until - since);
  return { since: new Date(priorSince).toISOString(), until: new Date(priorUntil).toISOString() };
}

// The service reports amounts to 8 decimals; keep that precision and take the
// percentage from the unrounded difference.
const change = (now, before) => {
  if (now === null || before === null) return { delta: null, percent: null };
  const raw = now - before;
  return {
    delta: Math.round(raw * 1e8) / 1e8,
    percent: before === 0 ? null : Math.round((raw / before) * 1000) / 10,
  };
};
// A cost change is known only when both sides' cost is exact: a lower bound
// can hide a larger true cost and reverse the direction.
const exact = (pricing) => pricing?.cost === "exact";
const costChange = (now, before, nowPricing, beforePricing) =>
  exact(nowPricing) && exact(beforePricing) ? change(now, before) : { delta: null, percent: null };

const sideOf = (item) => ({ calls: item.calls, error_calls: item.error_calls, cost_usd: item.cost_usd, pricing: item.pricing });

// Joins the current and prior reports group by group. A group missing from a
// window whose groups are all listed had no calls there (zero); missing from
// a cut window it is unknown (null), never zero.
export function compareReports(current, prior, mode, notices) {
  const key = byKey(current.group_by);
  const priorByKey = new Map(prior.items.map((item) => [key(item), item]));
  const currentKeys = new Set(current.items.map(key));
  // No calls in a fully listed window: zero, and exactly so.
  const zero = {
    calls: 0, error_calls: 0, cost_usd: 0,
    pricing: { priced_calls: 0, zero_cost_calls: 0, partial_calls: 0, unpriced_calls: 0, unknown_calls: 0, cost: "exact" },
  };
  const absent = (report) => (report.truncated ? null : zero);
  const group = (item) => Object.fromEntries(current.group_by.flatMap((dimension) =>
    dimension.startsWith("metadata.")
      ? [["metadata_key", item.metadata_key], ["metadata_value", item.metadata_value], ["has_value", item.has_value]]
      : [[dimension, item[dimension]]]));
  const row = (item, now, before) => ({
    ...group(item),
    current: now,
    prior: before,
    cost_change: costChange(now?.cost_usd ?? null, before?.cost_usd ?? null, now?.pricing, before?.pricing),
    calls_change: change(now?.calls ?? null, before?.calls ?? null),
  });
  const items = current.items.map((item) => {
    const match = priorByKey.get(key(item));
    return row(item, sideOf(item), match === undefined ? absent(prior) : sideOf(match));
  });
  const onlyPrior = prior.items
    .filter((item) => !currentKeys.has(key(item)))
    .map((item) => row(item, absent(current), sideOf(item)));
  const currentHours = current.window.hours;
  const priorHours = prior.window.hours;
  // A window that ends part way through the current UTC day compared with a
  // longer prior period: totals are not like for like.
  const unequal = Math.abs(currentHours - priorHours) > 0.01;
  const partialAgainstFull = unequal && current.window.partial_days.length > 0;
  if (partialAgainstFull) notices.add("partial_day_comparison");
  const complete = current.complete && prior.complete;
  if (!complete) notices.add("comparison_incomplete");
  const totals = (report) => ({
    calls: report.totals.calls,
    error_calls: report.totals.error_calls,
    cost_usd: report.totals.cost_usd,
  });
  const likeForLike = partialAgainstFull ? priorWindow(current.window, "previous-same-time") : null;
  return {
    mode,
    prior: {
      window: prior.window,
      totals: prior.totals,
      coverage: prior.coverage,
      pricing: prior.pricing,
      attribution: prior.attribution,
      evidence: prior.evidence,
      warnings: prior.warnings,
      truncated: prior.truncated,
      complete: prior.complete,
      rows: prior.rows,
      matched_groups: prior.matched_groups,
    },
    hours: { current: currentHours, prior: priorHours },
    partial_day_compared_with_full: partialAgainstFull,
    like_for_like_window: likeForLike,
    complete,
    totals: {
      current: totals(current),
      prior: totals(prior),
      cost_change: costChange(current.totals.cost_usd, prior.totals.cost_usd, current.pricing, prior.pricing),
      cost_change_known: exact(current.pricing) && exact(prior.pricing),
      calls_change: change(current.totals.calls, prior.totals.calls),
    },
    items: [...items, ...onlyPrior],
  };
}
