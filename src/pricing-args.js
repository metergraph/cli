import { DEFAULT_ORIGIN } from "./constants.js";
import { parseOrigin } from "./origin.js";
export const PRICING_ACTIONS = ["lookup", "cost", "history", "market"];
const SELECTORS = ["model", "provider", "channel", "region"];
export const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
];
export const PRICING_OPTIONS = [
  "--url",
  "--timeout-ms",
  "--format",
  "--at",
  "--limit",
  ...SELECTORS.map((k) => `--${k}`),
  ...TOKEN_KEYS.map((k) => `--${k.replaceAll("_", "-")}`),
];
export function validDate(v) {
  return (
    typeof v === "string" &&
    !v.startsWith("0000-") &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v
  );
}
export function parsePricing(action, values, flags, json, fail) {
  if (!action) return fail("missing_subcommand", "pricing requires lookup, cost, history or market.");
  const origin = parseOrigin(values["--url"] ?? DEFAULT_ORIGIN);
  if (!origin) return fail("invalid_url", "--url requires a bare HTTPS origin, or HTTP on loopback.");
  const format = values["--format"] ?? (action === "history" ? "chart" : "table");
  if (
    !["table", "chart", "html"].includes(format) ||
    (format !== "table" && action !== "history") ||
    (json && values["--format"] !== undefined)
  ) {
    return fail("invalid_format", "Use table, or chart/html for history. --json cannot be combined with --format.");
  }
  const query = {};
  for (const k of SELECTORS) {
    const v = values[`--${k}`];
    if (v !== undefined) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(v))
        return fail("invalid_selector", "Pricing selectors require 1 to 200 identifier characters.");
      query[k] = k === "model" ? v : v.toLowerCase();
    }
  }
  if (action !== "market" && !query.model) return fail("missing_model", "--model is required.");
  if (query.provider && query.channel)
    return fail("conflicting_selector", "Choose --provider or --channel; channel selects the exact billing route.");
  if (action === "market" && (query.model || query.provider || !query.channel))
    return fail(
      "invalid_market_selector",
      "market requires --channel and accepts --region; use lookup for a model or provider.",
    );
  if (action === "history" && !query.channel)
    return fail("missing_channel", "history requires --channel to keep one billing route per chart.");
  query.at = values["--at"] ?? new Date().toISOString().slice(0, 10);
  if (!validDate(query.at)) return fail("invalid_date", "--at must be a real UTC date, YYYY-MM-DD.");
  if (["history", "market"].includes(action)) query.region ??= "global";
  if (values["--limit"] !== undefined && action !== "market")
    return fail("unexpected_limit", "--limit is supported only by market.");
  if (action === "market") {
    const v = values["--limit"] ?? "20";
    if (!/^[1-9]\d?$|^100$/.test(v)) return fail("invalid_limit", "--limit must be 1 to 100.");
    query.limit = Number(v);
  }
  for (const k of TOKEN_KEYS) {
    const v = values[`--${k.replaceAll("_", "-")}`];
    if (v !== undefined) {
      if (action !== "cost" || !/^(0|[1-9]\d{0,11})$/.test(v))
        return fail(
          "invalid_usage",
          "Token counts are supported only by cost and must be whole numbers from 0 to 999999999999.",
        );
      query[k] = Number(v);
    }
  }
  if (flags.has("--batch")) {
    if (action !== "cost") return fail("invalid_usage", "--batch is supported only by cost.");
    query.batch = true;
  }
  if (
    query.cache_write_tokens !== undefined &&
    (query.cache_write_5m_tokens !== undefined || query.cache_write_1h_tokens !== undefined)
  )
    return fail("conflicting_usage", "Use an aggregate cache-write count or duration-specific counts, not both.");
  const raw = values["--timeout-ms"] ?? "10000";
  if (!/^\d+$/.test(raw) || Number(raw) < 100 || Number(raw) > 30000)
    return fail("invalid_timeout", "--timeout-ms must be 100 to 30000.");
  return { ok: true, command: "pricing", action, origin, query, format, timeoutMs: Number(raw), json };
}
