import { send } from "./transport.js";
import { parseJsonObject } from "./http.js";
import { validDate } from "./pricing-args.js";
export const PRICING_SCHEMA = "metergraph.pricing/v1";
const fail = (outcome, reason) => ({
  outcome,
  reason,
  message: "Pricing could not be read. Check the reason and the pricing service contract.",
});
const text = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 500 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(v);
const currency = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const decimal = (v) =>
  v === null || (typeof v === "string" && /^(0|[1-9]\d{0,14})(\.\d{1,16})?$/.test(v) && Number.isFinite(Number(v)));
const instant = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) &&
  validDate(v.slice(0, 10)) &&
  Number.isFinite(Date.parse(v));
const source = (v) => {
  if (!text(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};
export const RATE_KEYS = [
  "input_per_mtok",
  "output_per_mtok",
  "cache_read_per_mtok",
  "cache_write_5m_per_mtok",
  "cache_write_1h_per_mtok",
  "batch_input_per_mtok",
  "batch_output_per_mtok",
  "request_fee_per_1k",
];
function price(p) {
  return (
    p &&
    ["id", "model_id", "channel", "region"].every((k) => text(p[k])) &&
    currency(p.currency) &&
    instant(p.effective_from) &&
    (p.effective_to === null ||
      (instant(p.effective_to) && Date.parse(p.effective_to) > Date.parse(p.effective_from))) &&
    source(p.source_url) &&
    RATE_KEYS.every((k) => decimal(p[k])) &&
    p.rules &&
    typeof p.rules === "object" &&
    !Array.isArray(p.rules)
  );
}
function series(s, q) {
  if (
    !s ||
    !["model_id", "channel", "region"].every((k) => text(s[k])) ||
    s.channel !== q.channel ||
    s.region !== q.region ||
    !currency(s.currency) ||
    !Array.isArray(s.points) ||
    s.points.length < 1 ||
    s.points.length > 1000
  )
    return false;
  return s.points.every(
    (p, i) =>
      price(p) &&
      p.model_id === s.model_id &&
      p.channel === s.channel &&
      p.region === s.region &&
      p.currency === s.currency &&
      Date.parse(p.effective_from) <= Date.parse(`${q.at}T00:00:00Z`) &&
      (i === 0 ||
        (Date.parse(s.points[i - 1].effective_from) < Date.parse(p.effective_from) &&
          s.points[i - 1].effective_to !== null &&
          Date.parse(s.points[i - 1].effective_to) <= Date.parse(p.effective_from))),
  );
}
export function validatePricing(d, action, q) {
  if (
    !d ||
    d.schema_version !== PRICING_SCHEMA ||
    d.action !== action ||
    !d.request ||
    JSON.stringify(Object.keys(d.request).sort()) !== JSON.stringify(Object.keys(q).sort()) ||
    !Object.keys(q).every((k) => d.request[k] === q[k]) ||
    !d.catalog ||
    !text(d.catalog.version) ||
    typeof d.catalog.content_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(d.catalog.content_hash) ||
    !validDate(d.catalog.pricing_verified_at) ||
    !instant(d.catalog.served_at) ||
    !text(d.catalog.core_version)
  )
    return false;
  const r = d.result;
  if (!r) return false;
  if (action === "market" || action === "history") {
    if (
      !Array.isArray(r.series) ||
      r.series.length > (action === "history" ? 1 : q.limit) ||
      !r.series.every((s) => series(s, q)) ||
      typeof r.truncated !== "boolean" ||
      !Number.isSafeInteger(r.matched) ||
      r.matched < r.series.length ||
      r.truncated !== r.matched > r.series.length ||
      (action === "history" && r.truncated)
    )
      return false;
    if (
      action === "market" &&
      r.series.some(
        (s) =>
          s.points.at(-1).effective_to !== null &&
          Date.parse(s.points.at(-1).effective_to) <= Date.parse(`${q.at}T00:00:00Z`),
      )
    )
      return false;
    const ids = r.series.map((s) => `${s.model_id}|${s.channel}|${s.region}`);
    return new Set(ids).size === ids.length;
  }
  if (
    !["priced", "partial", "unpriced"].includes(r.status) ||
    !Array.isArray(r.missing_dimensions) ||
    new Set(r.missing_dimensions).size !== r.missing_dimensions.length ||
    !r.missing_dimensions.every((k) => ["region", "channel", "input_tokens", "output_tokens"].includes(k)) ||
    !instant(r.effective_at) ||
    Date.parse(r.effective_at) !== Date.parse(`${q.at}T00:00:00Z`)
  )
    return false;
  if (r.status === "unpriced") {
    if (r.price !== null || r.model_id !== null) return false;
  } else if (
    !price(r.price) ||
    r.model_id !== r.price.model_id ||
    (q.channel && r.price.channel !== q.channel) ||
    (q.region && ![q.region, "global", "*"].includes(r.price.region)) ||
    Date.parse(r.price.effective_from) > Date.parse(r.effective_at) ||
    (r.price.effective_to !== null && Date.parse(r.price.effective_to) <= Date.parse(r.effective_at))
  )
    return false;
  if (r.status === "priced" && r.missing_dimensions.length) return false;
  if (action === "cost") {
    if (!decimal(r.cost) || !Array.isArray(r.reasons) || !r.reasons.every(text)) return false;
    if (r.status === "priced" && r.reasons.length) return false;
    if (
      r.status !== "unpriced" &&
      ["input_tokens", "output_tokens"].some((k) => !Object.hasOwn(q, k) && !r.missing_dimensions.includes(k))
    )
      return false;
    if (r.status === "unpriced") return r.cost === null && r.components === null && r.currency === null;
    if (
      r.cost === null ||
      r.currency !== r.price.currency ||
      !r.components ||
      !["input", "output", "cache_read", "cache_write", "request"].every(
        (k) => r.components[k] !== null && decimal(r.components[k]),
      )
    )
      return false;
    // Validate the engine's rounded breakdown using integer decimal arithmetic.
    const units = (value) => {
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole) * 10n ** 16n + BigInt(fraction.padEnd(16, "0"));
    };
    if (
      Object.keys(r.components).sort().join() !== "cache_read,cache_write,input,output,request" ||
      Object.values(r.components).reduce((sum, v) => sum + units(v), 0n) !== units(r.cost)
    )
      return false;
  }
  return true;
}
export async function runPricing(o) {
  const query = new URLSearchParams(Object.entries(o.query).map(([k, v]) => [k, String(v)]));
  const res = await send(o.origin, `/v1/pricing/${o.action}`, {
    query,
    maxBytes: 1024 * 1024,
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  if (res.kind === "error") return fail("connection_failed", res.reason);
  if (res.status >= 300 && res.status < 400) return fail("redirect_rejected", "pricing_redirect_rejected");
  if (res.status === 429) return fail("rate_limited", "pricing_rate_limited");
  if (res.status >= 500) return fail("unhealthy", "pricing_service_unhealthy");
  if ([401, 403, 404, 405].includes(res.status)) return fail("unsupported", "public_pricing_unavailable");
  if (res.tooLarge) return fail("unsupported", "pricing_response_too_large");
  if (res.status !== 200) return fail("unsupported", "pricing_response_unsupported");
  const data = parseJsonObject(res);
  if (!validatePricing(data, o.action, o.query)) return fail("verification_failed", "pricing_contract_mismatch");
  return { outcome: "ok", data };
}
