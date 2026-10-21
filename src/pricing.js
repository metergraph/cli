import { send } from "./transport.js";
import { parseJsonObject } from "./http.js";
import { validDate } from "./pricing-args.js";
import { runReferencePricing, RATE_KEYS } from "./pricing-reference.js";

const fail = (
  outcome,
  reason,
  message = "Pricing could not be read. Check the reason and retry with supported inputs.",
) => ({ outcome, reason, message });
const text = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 500 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(v);
const currency = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const decimal = (v) => typeof v === "string" && /^(0|[1-9]\d{0,14})(\.\d{1,16})?$/.test(v);
const instant = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) &&
  validDate(v.slice(0, 10)) &&
  Number.isFinite(Date.parse(v));
const date = (v) => validDate(v) || instant(v);
const strings = (v) => Array.isArray(v) && v.length <= 10000 && v.every(text);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const source = (v) => {
  if (!text(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};
const units = (v) => {
  const [a, b = ""] = v.split(".");
  return BigInt(a) * 10n ** 16n + BigInt(b.padEnd(16, "0"));
};
function price(p) {
  return (
    object(p) &&
    ["id", "model_id", "channel", "region"].every((k) => text(p[k])) &&
    currency(p.currency) &&
    date(p.effective_from) &&
    (p.effective_to === null || (date(p.effective_to) && Date.parse(p.effective_to) > Date.parse(p.effective_from))) &&
    source(p.source_url) &&
    object(p.rules) &&
    RATE_KEYS.every((k) => p[k] === null || decimal(p[k]))
  );
}
export function validateModels(d) {
  return (
    object(d) &&
    instant(d.as_of) &&
    object(d.catalog) &&
    text(d.catalog.version) &&
    currency(d.catalog.currency) &&
    validDate(d.catalog.pricing_verified_at) &&
    ["formats", "providers", "channels", "regions", "service_tiers"].every((k) => strings(d[k])) &&
    Array.isArray(d.models) &&
    d.models.length <= 10000 &&
    new Set(d.models.map((m) => m?.model_id)).size === d.models.length &&
    d.models.every(
      (m) =>
        object(m) &&
        text(m.model_id) &&
        text(m.publisher) &&
        Array.isArray(m.aliases) &&
        m.aliases.every((a) => object(a) && ["provider", "model", "channel"].every((k) => text(a[k]))) &&
        Array.isArray(m.prices) &&
        m.prices.every(
          (p) =>
            object(p) &&
            text(p.channel) &&
            text(p.region) &&
            currency(p.currency) &&
            date(p.effective_from) &&
            strings(p.dimensions) &&
            strings(p.service_tiers),
        ),
    )
  );
}
export function validatePublicResult(d, action, q, now = Date.now()) {
  if (!object(d) || !Array.isArray(d.results) || d.results.length !== 1) return false;
  const r = d.results[0];
  if (
    !object(r) ||
    !["priced", "partial", "unpriced"].includes(r.status) ||
    !instant(r.effective_at) ||
    !strings(r.missing_dimensions) ||
    new Set(r.missing_dimensions).size !== r.missing_dimensions.length
  )
    return false;
  if (
    q.at ? Date.parse(r.effective_at) !== Date.parse(q.at) : Math.abs(Date.parse(r.effective_at) - now) > 15 * 60 * 1000
  )
    return false;
  if (r.status === "priced" && r.missing_dimensions.length) return false;
  if (r.status === "unpriced") {
    if (r.model_id !== null || r.price !== null || r.currency !== null) return false;
  } else if (
    !price(r.price) ||
    r.model_id !== r.price.model_id ||
    r.currency !== r.price.currency ||
    (q.channel && r.price.channel !== q.channel) ||
    (q.region && ![q.region, "global", "*"].includes(r.price.region)) ||
    Date.parse(r.price.effective_from) > Date.parse(r.effective_at) ||
    (r.price.effective_to !== null && Date.parse(r.price.effective_to) <= Date.parse(r.effective_at))
  )
    return false;
  if (action === "cost" || action === "calculate") {
    if (r.status === "unpriced") return r.cost === null && r.components === null;
    if (
      !decimal(r.cost) ||
      !object(r.components) ||
      Object.keys(r.components).sort().join() !== "cache_read,cache_write,input,output,request" ||
      !Object.values(r.components).every(decimal) ||
      Object.values(r.components).reduce((n, v) => n + units(v), 0n) !== units(r.cost)
    )
      return false;
    if (["input_tokens", "output_tokens"].some((k) => !Object.hasOwn(q, k) && !r.missing_dimensions.includes(k)))
      return false;
  }
  return true;
}
export function pricingPayload(o) {
  const q = o.query;
  const context = Object.fromEntries(
    ["provider", "channel", "region"].filter((k) => q[k] !== undefined).map((k) => [k, q[k]]),
  );
  if (q.at) context.at = `${q.at}T00:00:00Z`;
  if (q.batch) context.service_tier = "batch";
  if (o.action === "lookup") return { model: q.model, context };
  const usage = {};
  const put = (key, value) => {
    if (value !== undefined) usage[key] = value;
  };
  let trace;
  if (o.traceFormat === "anthropic.messages") {
    put("input_tokens", q.input_tokens);
    put("output_tokens", q.output_tokens);
    put("cache_read_input_tokens", q.cache_read_tokens);
    put("cache_creation_input_tokens", q.cache_write_tokens);
    if (q.cache_write_5m_tokens !== undefined || q.cache_write_1h_tokens !== undefined)
      usage.cache_creation = {
        ...(q.cache_write_5m_tokens === undefined ? {} : { ephemeral_5m_input_tokens: q.cache_write_5m_tokens }),
        ...(q.cache_write_1h_tokens === undefined ? {} : { ephemeral_1h_input_tokens: q.cache_write_1h_tokens }),
      };
    trace = { model: q.model, usage };
  } else if (o.traceFormat.startsWith("openai.")) {
    const chat = o.traceFormat === "openai.chat_completions";
    put(chat ? "prompt_tokens" : "input_tokens", q.input_tokens);
    put(chat ? "completion_tokens" : "output_tokens", q.output_tokens);
    if (q.cache_read_tokens !== undefined)
      usage[chat ? "prompt_tokens_details" : "input_tokens_details"] = { cached_tokens: q.cache_read_tokens };
    trace = { model: q.model, usage };
  } else {
    usage["gen_ai.request.model"] = q.model;
    put("gen_ai.usage.input_tokens", q.input_tokens);
    put("gen_ai.usage.output_tokens", q.output_tokens);
    put("gen_ai.usage.cache_read.input_tokens", q.cache_read_tokens);
    trace = { attributes: usage };
  }
  return { format: o.traceFormat, trace, context };
}
export async function runPricing(o) {
  if (o.api === "reference") return runReferencePricing(o);
  if (o.action === "history")
    return fail(
      "unsupported",
      "pricing_history_unavailable",
      "The public API documents no history endpoint. Historical charts remain available with --api reference and a loopback --url; no public history request was made.",
    );
  if (o.action === "market") return runPublicMarket(o);
  const path =
    o.action === "models"
      ? "/v1/pricing/models"
      : o.action === "lookup"
        ? "/v1/pricing/lookup"
        : "/v1/pricing/calculate";
  const res = await send(o.origin, path, {
    method: o.action === "models" ? "GET" : "POST",
    json: o.action === "models" ? null : pricingPayload(o),
    maxBytes: 1024 * 1024,
    signal: AbortSignal.timeout(o.timeoutMs),
    useGlobalAgent: true,
  });
  const failure = responseFailure(res);
  if (failure) return failure;
  const d = parseJsonObject(res);
  if (o.action === "models") {
    if (!validateModels(d)) return fail("verification_failed", "pricing_contract_mismatch");
    const q = o.query;
    const matches = d.models.filter(
      (m) =>
        (!q.model || m.model_id === q.model || m.aliases.some((a) => a.model === q.model)) &&
        (!q.provider || m.aliases.some((a) => a.provider === q.provider && (!q.channel || a.channel === q.channel))) &&
        (!q.channel || m.prices.some((p) => p.channel === q.channel && (!q.region || p.region === q.region))) &&
        (!q.region || m.prices.some((p) => p.region === q.region && (!q.channel || p.channel === q.channel))),
    );
    return {
      outcome: "ok",
      data: {
        api: "public",
        action: o.action,
        request: q,
        catalog: d.catalog,
        as_of: d.as_of,
        formats: d.formats,
        providers: d.providers,
        channels: d.channels,
        regions: d.regions,
        service_tiers: d.service_tiers,
        result: {
          models: matches.slice(0, q.limit),
          matched: matches.length,
          total_models: d.models.length,
          truncated: matches.length > q.limit,
        },
      },
    };
  }
  if (!validatePublicResult(d, o.action, o.query)) return fail("verification_failed", "pricing_contract_mismatch");
  const r = d.results[0];
  return {
    outcome: "ok",
    data: {
      api: "public",
      action: o.action,
      request: o.query,
      ...(o.action === "lookup" ? {} : { trace_format: o.traceFormat }),
      catalog: null,
      result: r,
    },
  };
}

function responseFailure(res) {
  if (res.kind === "error") return fail("connection_failed", res.reason);
  if (res.status >= 300 && res.status < 400) return fail("redirect_rejected", "pricing_redirect_rejected");
  if (res.status === 429) return fail("rate_limited", "pricing_rate_limited");
  if (res.status >= 500) return fail("unhealthy", "pricing_service_unhealthy");
  if ([401, 403, 404, 405].includes(res.status)) return fail("unsupported", "public_pricing_unavailable");
  if (res.tooLarge) return fail("unsupported", "pricing_response_too_large");
  if ([400, 422].includes(res.status)) return fail("invalid_input", "pricing_request_rejected");
  if (res.status !== 200) return fail("unsupported", "pricing_response_unsupported");
  return null;
}

async function runPublicMarket(o) {
  if (o.query.at)
    return fail(
      "unsupported",
      "market_date_unsupported",
      "The public market board uses current discovery and lookups. Use lookup --at for one historical price; historical board coverage is unavailable.",
    );
  const signal = AbortSignal.timeout(o.timeoutMs);
  const options = { signal, maxBytes: 1024 * 1024, useGlobalAgent: true };
  const discovery = await send(o.origin, "/v1/pricing/models", options);
  const error = responseFailure(discovery);
  if (error) return error;
  const d = parseJsonObject(discovery);
  if (!validateModels(d)) return fail("verification_failed", "pricing_contract_mismatch");
  const q = o.query;
  const matches = d.models.filter((m) => m.prices.some((p) => p.channel === q.channel && p.region === q.region));
  const selected = matches.slice(0, q.limit),
    items = new Array(selected.length);
  let next = 0,
    failure = null;
  const worker = async () => {
    while (!failure && next < selected.length) {
      const index = next++,
        model = selected[index].model_id;
      const request = { model, channel: q.channel, region: q.region };
      const res = await send(o.origin, "/v1/pricing/lookup", {
        ...options,
        method: "POST",
        json: { model, context: { channel: q.channel, region: q.region } },
      });
      const error = responseFailure(res);
      if (error) {
        failure = error;
        break;
      }
      const result = parseJsonObject(res);
      if (!validatePublicResult(result, "lookup", request)) {
        failure = fail("verification_failed", "pricing_contract_mismatch");
        break;
      }
      items[index] = { requested_model: model, ...result.results[0] };
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, worker));
  if (failure) return failure;
  return {
    outcome: "ok",
    data: {
      api: "public",
      action: "market",
      request: q,
      catalog: d.catalog,
      as_of: d.as_of,
      result: { items, matched: matches.length, truncated: matches.length > items.length, history_available: false },
    },
  };
}
