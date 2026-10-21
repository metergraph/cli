import { DEFAULT_ORIGIN } from "./constants.js";
import { parseOrigin } from "./origin.js";
export const PRICING_ACTIONS = ["models", "lookup", "calculate", "cost", "history", "market"];
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
  "--api",
  "--trace-format",
  "--contract-version",
  "--web-search-requests",
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
  if (!action)
    return fail("missing_subcommand", "pricing requires models, lookup, calculate, cost, history or market.");
  const origin = parseOrigin(values["--url"] ?? DEFAULT_ORIGIN);
  if (!origin) return fail("invalid_url", "--url requires a bare HTTPS origin, or HTTP on loopback.");
  const api = values["--api"] ?? "public";
  if (!["public", "reference"].includes(api)) return fail("invalid_pricing_api", "--api must be public or reference.");
  if (api === "reference" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))
    return fail(
      "reference_requires_loopback",
      "The reference pricing API is local development tooling; use a loopback --url.",
    );
  const cost = action === "cost" || action === "calculate";
  if (api === "reference" && ["models", "calculate"].includes(action))
    return fail(
      "reference_action_unsupported",
      "The reference adapter supports lookup, cost, history and market.",
      "unsupported",
    );
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
  if (!["market", "models"].includes(action) && !query.model) return fail("missing_model", "--model is required.");
  if (query.provider && query.channel)
    return fail("conflicting_selector", "Choose --provider or --channel; channel selects the exact billing route.");
  if (action === "market" && (query.model || query.provider || !query.channel))
    return fail(
      "invalid_market_selector",
      "market requires --channel and accepts --region; use lookup for a model or provider.",
    );
  if (action === "history" && !query.channel)
    return fail("missing_channel", "history requires --channel to keep one billing route per chart.");
  if (values["--at"] !== undefined || api === "reference")
    query.at = values["--at"] ?? new Date().toISOString().slice(0, 10);
  if (query.at !== undefined && !validDate(query.at))
    return fail("invalid_date", "--at must be a real UTC date, YYYY-MM-DD.");
  if (["history", "market"].includes(action)) query.region ??= "global";
  if (values["--limit"] !== undefined && !["models", "market"].includes(action))
    return fail("unexpected_limit", "--limit is supported only by models and market.");
  if (["market", "models"].includes(action)) {
    const v = values["--limit"] ?? "20";
    if (!/^[1-9]\d?$|^100$/.test(v)) return fail("invalid_limit", "--limit must be 1 to 100.");
    query.limit = Number(v);
  }
  for (const k of TOKEN_KEYS) {
    const v = values[`--${k.replaceAll("_", "-")}`];
    if (v !== undefined) {
      if (!cost || !/^(0|[1-9]\d{0,11})$/.test(v))
        return fail(
          "invalid_usage",
          "Token counts are supported only by cost and must be whole numbers from 0 to 999999999999.",
        );
      query[k] = Number(v);
    }
  }
  if (flags.has("--batch")) {
    if (!cost) return fail("invalid_usage", "--batch is supported only by cost.");
    query.batch = true;
  }
  if (
    query.cache_write_tokens !== undefined &&
    (query.cache_write_5m_tokens !== undefined || query.cache_write_1h_tokens !== undefined)
  )
    return fail("conflicting_usage", "Use an aggregate cache-write count or duration-specific counts, not both.");
  if (action === "models" && query.at !== undefined)
    return fail(
      "models_date_unsupported",
      "models returns current discovery data; --at is not supported.",
      "unsupported",
    );
  const traceFormat =
    values["--trace-format"] ??
    (query.provider === "anthropic" || query.channel === "anthropic-api"
      ? "anthropic.messages"
      : query.provider === "openai" || query.channel === "openai-api"
        ? "openai.responses"
        : "otel.gen_ai");
  if (values["--trace-format"] !== undefined && (!cost || api !== "public"))
    return fail("unexpected_trace_format", "--trace-format is supported only by public calculate/cost.");
  if (!["openai.responses", "openai.chat_completions", "anthropic.messages", "otel.gen_ai"].includes(traceFormat))
    return fail(
      "invalid_trace_format",
      "Use openai.responses, openai.chat_completions, anthropic.messages or otel.gen_ai.",
    );
  if (api === "public" && cost) {
    if (
      (traceFormat.startsWith("openai.") || query.provider === "openai" || query.channel === "openai-api") &&
      query.cache_read_tokens !== undefined &&
      (query.input_tokens === undefined || query.cache_read_tokens > query.input_tokens)
    )
      return fail("invalid_cached_input", "OpenAI cached input must not exceed the supplied total input tokens.");
    if (
      traceFormat !== "anthropic.messages" &&
      TOKEN_KEYS.filter((k) => k.startsWith("cache_write")).some((k) => query[k] !== undefined)
    )
      return fail(
        "cache_write_format_unsupported",
        "Use --trace-format anthropic.messages for cache-write counts; other mappings are not verified.",
        "unsupported",
      );
  }
  if (values["--contract-version"] !== undefined && (!cost || api !== "public"))
    return fail("unexpected_contract_version", "--contract-version is supported only by public calculate/cost.");
  const contractVersion = Number(values["--contract-version"] ?? "2");
  if (!["1", "2"].includes(values["--contract-version"] ?? "2"))
    return fail("invalid_contract_version", "--contract-version must be 1 or 2.");
  if (values["--web-search-requests"] !== undefined) {
    const count = values["--web-search-requests"];
    if (!cost || api !== "public" || traceFormat !== "anthropic.messages" || !/^(0|[1-9]\d{0,11})$/.test(count))
      return fail("invalid_search_usage", "--web-search-requests requires public Anthropic calculate/cost and a whole count from 0 to 999999999999.");
    query.web_search_requests = Number(count);
  }
  const raw = values["--timeout-ms"] ?? "10000";
  if (!/^\d+$/.test(raw) || Number(raw) < 100 || Number(raw) > 30000)
    return fail("invalid_timeout", "--timeout-ms must be 100 to 30000.");
  return {
    ok: true,
    command: "pricing",
    action,
    origin,
    query,
    format,
    api,
    traceFormat,
    contractVersion,
    timeoutMs: Number(raw),
    json,
  };
}
