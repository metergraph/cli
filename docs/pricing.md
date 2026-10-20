# Public pricing commands (proposed service contract)

`metergraph pricing` reads public model catalog prices without a workspace,
login, project files or credentials. It does not call a model provider.

**Release status:** the CLI and loopback reference adapter are implemented.
The hosted `metergraph.pricing/v1` HTTP endpoints below are a proposed integration
contract, not a verified deployed service. The default origin is
`https://app.metergraph.dev`; a deployment without this contract exits 6
`public_pricing_unavailable`. Do not advertise hosted readiness until a packed
CLI has passed against that deployment. This document is not evidence of service
availability. The Python package's public API is distinct from HTTP availability.

## Commands

```sh
metergraph pricing lookup --model openai/gpt-6-sol --channel openai-api --json
metergraph pricing cost --model openai/gpt-6-sol --provider openai \
  --input-tokens 1000 --output-tokens 200
metergraph pricing market --channel openai-api --limit 20
metergraph pricing history --model openai/gpt-5.6-terra --channel openai-api
metergraph pricing history --model openai/gpt-5.6-terra --channel openai-api \
  --format html > history.html
```

All four take `--url ORIGIN`, `--at YYYY-MM-DD`, `--timeout-ms N` and `--json`.
The date defaults to today's UTC date **at midnight**, and may be a historical or
future date. No local-time interpretation is used. A future query reads only
already recorded catalog windows; it is not a forecast. Timeout defaults to
10 seconds and accepts 100–30000 ms. HTTPS origins and HTTP loopback origins
follow the CLI's existing origin validation.

- **lookup**: `--model` is required. Choose `--channel` for an exact billing route,
  or `--provider` for core's direct-provider mapping. They are mutually exclusive.
  `--region` is optional; omitting it preserves core's missing-region semantics.
  Missing channel information and unknown models remain `unpriced`.
- **cost**: lookup selectors plus `--input-tokens`, `--output-tokens`,
  `--cache-read-tokens`, `--cache-write-tokens`, `--cache-write-5m-tokens`,
  `--cache-write-1h-tokens` and `--batch`. Counts are integers 0–999999999999.
  Do not combine aggregate and duration-specific cache writes. Omitted input or
  output counts remain unknown; a `partial` cost is the known subtotal. Cache
  inclusion, long-context, batch and request-fee arithmetic stay in core.
  Token counts follow the selected provider's usage shape (for example OpenAI
  prompt totals include cached reads). This estimates one call, not an invoice;
  usage discounts and unrepresented tool fees are not assumed.
- **history**: requires `--model` and `--channel`; region defaults to `global`.
  One exact model/channel/region series, through `--at`. Aliases resolve at that
  date; canonical IDs can retrieve an ended model's history. A region fallback
  used by lookup is not silently applied to a history series. `--format chart`
  (default), `table` or `html`. HTML prints a self-contained, script-free document
  to stdout; the shell redirection writes the file. No browser is launched.
- **market**: requires `--channel`; accepts `--region` (default `global`) and
  `--limit` (default 20, 1–100). The reference adapter lists active models ordered
  by most recent effective start, then descending model ID. The response names
  matched models and truncation. This is a recent-change board, not an exhaustive
  ranking of cheapest or highest-quality models.

`--json` cannot be combined with `--format`. Success uses the existing CLI JSON
envelope with `command: "pricing ACTION"`; `data` is the validated service
document. A successful query may contain `priced`, `partial` or `unpriced`: inspect
`data.result.status` and `missing_dimensions` before using a cost.

## Two visualization directions

The market board is designed for a quick terminal scan. It shows currency,
base input/output rates, the last input-price change between **contiguous**
recorded windows, and an event sparkline. The sparkline's horizontal spacing is
by event, not elapsed time. `n/a` means insufficient comparable history (including
a zero prior rate), not an unchanged price. Request a larger limit when truncated.

The history card is designed for sharing. It plots base input and output rates
on a linear UTC axis, with one horizontal segment per effective window. Gaps are
unknown; missing rates are not plotted. Exact windows and source links accompany
the plot. Terminal and HTML views use the same validated data. Rates exclude
conditional rules; use `cost` for a concrete usage estimate. HTML has an accessible
SVG description and a source-linked data table. No external assets, tracking or
signup wall are included. A footer links to Metergraph's actual usage analysis.

Catalog history may record corrections rather than observed market events.
Effective dates are not observation timestamps. The last change is not a daily
return. The catalog-wide verification stamp does not prove each rate was checked
on that date. These views are not stock prices, financial returns or a forecast.

## Run end to end locally

The reference adapter is development tooling in this checkout, not part of the
npm package or a production server. It binds only `127.0.0.1`, loads core once at
startup, and has no auth, storage, refresh scheduler, TLS, or production rate
limiting. Restart it to load a new catalog/package. It never fetches provider pages.

```sh
python3 -m venv /tmp/pricing-venv
/tmp/pricing-venv/bin/pip install metergraph-core==0.5.0
/tmp/pricing-venv/bin/python scripts/pricing-server.py --port 8765
# In another terminal:
node bin/metergraph.js pricing market --channel openai-api --url http://127.0.0.1:8765
node bin/metergraph.js pricing cost --model openai/gpt-6-sol --provider openai \
  --input-tokens 1000 --output-tokens 200 --url http://127.0.0.1:8765 --json
PRICING_PYTHON=/tmp/pricing-venv/bin/python node scripts/pricing-smoke.mjs
```

If that package version is not yet published, install `./core` from a checkout
of the public `PioneerSquareLabs/metergraph` repository at a reviewed commit
containing core 0.5.0, and record that commit with validation. Do not silently
substitute a different core release. The smoke test starts its own adapter on
an ephemeral port and shuts it down. `PRICING_BIN` can point to the installed
CLI bin to repeat all checks against an npm-packed artifact. No paid calls occur.
`--catalog PATH` on the adapter selects a local core-validated catalog for testing.

## HTTP contract to implement

Four unauthenticated, read-only GET endpoints:

| Path | Query |
| --- | --- |
| `/v1/pricing/lookup` | `model`, `at`, optional `provider` or `channel`, `region` |
| `/v1/pricing/cost` | lookup keys plus optional `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_5m_tokens`, `cache_write_1h_tokens`, `batch=true` |
| `/v1/pricing/history` | `model`, `channel`, `region`, `at` |
| `/v1/pricing/market` | `channel`, `region`, `at`, `limit` |

Every query key appears once. Unknown keys and invalid values return 400. The
CLI supplies `at`, history/market `region`, and market `limit` explicitly. No
credential or cookie is read or sent. The client makes one request, with no
redirects, automatic retries or credential fallback. The total response budget
is 1 MiB, including headers-reported size enforcement; encoding must be identity,
content type application/json, and text valid UTF-8. No local cache is used. CI runs both source and packed CLI smoke checks against
public core commit `62fb9fcee7e49280f924d7c1ccfbc37f442555a4` (0.5.0).

Every 200 document has:

```json
{
  "schema_version": "metergraph.pricing/v1",
  "action": "lookup",
  "request": {"model":"example/model","channel":"example-api","at":"2026-10-20"},
  "catalog": {
    "version":"2026-10-20",
    "content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "pricing_verified_at":"2026-10-20",
    "served_at":"2026-10-20T12:00:00Z",
    "core_version":"0.5.0"
  },
  "result": {
    "status":"unpriced", "model_id":null, "price":null,
    "effective_at":"2026-10-20T00:00:00Z", "missing_dimensions":[]
  }
}
```

`request` echoes the validated request (channel, provider and region are lowercased by the CLI): token counts/limit as JSON integers,
batch as boolean, selectors/date as strings. It is checked for exact keys and
values. Catalog version is independent of core version. The hash describes the
loaded catalog bytes (or canonical JSON for a document-loaded catalog).

A price row has `id`, `model_id`, `channel`, `region`, three-letter `currency`,
UTC `effective_from`, nullable exclusive `effective_to`, HTTPS `source_url`,
`rules` object, and these nullable **non-negative fixed-decimal strings**:
`input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`,
`cache_write_5m_per_mtok`, `cache_write_1h_per_mtok`, `batch_input_per_mtok`,
`batch_output_per_mtok`, `request_fee_per_1k`. Exponent notation is not accepted.
Precision limit: 15 integer and 16 fractional digits. Rates are per million
tokens except the request fee, which is per thousand requests. `null` is unknown.

Lookup result fields are shown above. Priced/partial results include the resolved
model ID and row, which must be active at `effective_at`. Priced results have no
missing dimensions. Core can report `region`, `channel`, `input_tokens` and
`output_tokens` as missing. Cost adds `cost` (decimal string/null), `currency`
(string/null), `reasons` (fixed identifiers) and `components` (null or decimal
strings keyed `input`, `output`, `cache_read`, `cache_write`, `request`).
Components must sum exactly to the returned subtotal; the CLI checks with integer
decimal arithmetic. Unpriced results have no applied price, cost or components.

History/market result is `{series: [...], matched: N, truncated: boolean}`.
Each series is `{model_id, channel, region, currency, points: [price rows]}`.
Points are strictly ascending by start, non-overlapping, no later than `at`,
with at most 1000 windows per series. Currency/channel/region stay constant.
History has zero or one complete series; no truncation is accepted. Market has
at most `limit` distinct series; `matched` counts all matching active models and
`truncated` must agree. `global` and specific regional series are never mixed.

## Errors and release gate

| Condition | Exit / reason |
| --- | --- |
| Invalid input | 2, no request |
| Network failure/timeout | 4, fixed transport reason |
| 5xx | 5 `pricing_service_unhealthy` |
| 401/403/404/405 | 6 `public_pricing_unavailable` |
| Unsupported status | 6 `pricing_response_unsupported` |
| Oversized response | 6 `pricing_response_too_large` |
| Redirect | 7 `pricing_redirect_rejected` |
| Invalid document or request mismatch | 11 `pricing_contract_mismatch` |
| 429 | 16 `pricing_rate_limited`, no automatic retry |

Before release, agree the contract with the hosted implementation, test the
packed CLI against the unauthenticated deployed origin, verify history coverage,
and define freshness and rate-limit policy. Local reference checks do not prove
production availability. Broader funnel experiments (watchlists, a hosted page,
change digests, opt-in conversion measurement) can follow these two previews;
this PR does not publish a website or collect leads.
