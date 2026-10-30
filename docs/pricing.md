# Public pricing CLI preview

The default `--api public` uses the deployed Pricing API at
`https://app.metergraph.dev` without a workspace, account or credential:

| CLI | HTTP |
| --- | --- |
| `pricing models` | `GET /v1/pricing/models` |
| `pricing lookup` | `POST /v1/pricing/lookup` |
| `pricing calculate` (`cost` alias) | `POST /v1/pricing/calculate` |
| `pricing market` | Current discovery plus at most `--limit` lookup requests |
| `pricing history` | Unsupported publicly; no HTTP request |

The public contract is different from the earlier reference adapter's proposed
GET endpoints. The CLI does not call public `/cost`, `/market` or `/history`
endpoints. The historical charts and HTML export are preserved behind explicit
local reference mode, described below.

## Public commands

```sh
metergraph pricing models --limit 10
metergraph pricing models --provider anthropic --region global --json
metergraph pricing lookup --model gpt-5 --provider openai --region global --json
metergraph pricing calculate --model claude-sonnet-5 --provider anthropic \
  --region global --input-tokens 1000 --cache-read-tokens 800 --output-tokens 200
metergraph pricing cost --model gpt-5 --provider openai --input-tokens 1000 \
  --cache-read-tokens 800 --output-tokens 200 --trace-format openai.chat_completions
metergraph pricing market --channel openai-api --limit 5
```

All commands accept `--url ORIGIN`, `--timeout-ms N` and `--json`. Origins are
bare HTTPS or HTTP on loopback. Timeout defaults to 10 seconds (100–30000 ms).
The CLI sends no authorization or cookies, follows no redirects and retries no
requests. Its response budget is 1 MiB per request, with strict UTF-8 and JSON
content-type checks. No provider API is called and no local cache is written.

### Models

`models` returns current discovery metadata: catalog version, currency and
verification date; supported formats, providers, channels, regions and service
tiers; canonical model IDs, aliases and price dimensions. Price entries in this
response do **not** contain numeric rates. Use `lookup` for prices.

`--model`, `--provider` or `--channel`, and `--region` filter this data locally;
`--limit` defaults to 20 (1–100). Output reports total canonical models, matching
models, displayed models and truncation. Alias/provider combinations and price
entries are not additional canonical models. `models --at` is unsupported:
current discovery cannot establish a historical catalog's completeness.

### Lookup

`--model` is required. Choose `--provider` for the API's provider mapping or
`--channel` for an exact billing route; they are mutually exclusive. `--region`
is optional. When provided, `--at YYYY-MM-DD` becomes `context.at` at UTC midnight;
otherwise the API chooses the effective time, which is printed in the result.
Provider/channel/region selectors are lowercased; model identifiers are preserved.

The POST body is nested as the service expects:

```json
{"model":"gpt-5","context":{"provider":"openai","region":"global"}}
```

The service returns `{ "results": [ ... ] }`. This CLI sends one lookup and
requires exactly one result. It preserves the resolved model ID, price row,
currency, effective timestamp, status and missing dimensions. Date-only effective
windows and decimal-string rates are accepted. A price must be active at the
returned effective time and on the requested explicit channel. The CLI allows
and discloses a regional fallback to `global` or `*`; it does not claim the
requested region was priced exactly when the returned row says otherwise.

Lookup has no cost or component breakdown. It does not return catalog version,
hash, verification stamp or request echo; the CLI does not invent those fields.

### Calculate and cost

`calculate` and `cost` call the same `/calculate` endpoint. They accept lookup
selectors plus `--input-tokens`, `--output-tokens`, `--cache-read-tokens`,
`--cache-write-tokens`, `--cache-write-5m-tokens`, `--cache-write-1h-tokens` and
`--batch`. Counts are whole numbers 0–999999999999. Omitted input/output counts
stay unknown rather than becoming zero. Aggregate and duration-specific cache
writes cannot be combined. Batch becomes `context.service_tier: "batch"`.

The CLI constructs a metadata-only trace from these explicit flags. It does not
load original responses, retained traces, prompts or content from project files.
It never computes prices locally. The API performs normalization and pricing.

`--trace-format` selects the usage shape sent to the API:

| Format | CLI token mapping |
| --- | --- |
| `anthropic.messages` | `usage.input_tokens`, `output_tokens`, additive `cache_read_input_tokens`; aggregate `cache_creation_input_tokens` or duration-specific `cache_creation` |
| `openai.responses` | `usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens` (cached is part of total input) |
| `openai.chat_completions` | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` (cached is part of total prompt) |
| `otel.gen_ai` | `attributes.gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens` |

Direct Anthropic/OpenAI selectors infer their native format; other selectors
default to `otel.gen_ai`. Explicit formats are useful for gateway-routed calls.
Discovery lists all API-supported formats, including formats this flag-based CLI
does not construct. It is not a generic original-response uploader.

OpenAI cached input must not exceed the supplied total input. That check runs
before networking, including with an explicit OpenAI trace format. Anthropic
cached counts are additive and may exceed uncached input. Cache-write flags are
accepted publicly only with `anthropic.messages`; other write mappings are
unverified and explicitly refused instead of silently discarded. Reference mode
retains its existing core-specific flags.

For example, 1000 input, 800 cached and 200 output mean different things:

- Anthropic: 1000 **uncached** input + 800 cache reads + 200 output.
- OpenAI: 1000 **total** input includes 800 cached, leaving 200 uncached.

The API returns decimal strings for `cost` and components; JSON preserves those
strings. Components must sum exactly to the cost, checked with integer decimal
arithmetic. The API may return null cost/components for an unpriced result.
It does not report a `reasons` list on this contract; human output says so rather
than manufacturing reasons.

## Status, completeness and provenance

HTTP 200 and CLI exit 0 mean a supported response was read, **not** that the model
was priced or the figure was complete. Read `data.result.status` and
`missing_dimensions`:

- `priced`: an applied price and no missing dimensions.
- `partial`: a known subtotal; missing dimensions remain visible. Missing usage
  can produce `0.00000000` with input/output missing. This is not labelled free
  or complete.
- `unpriced`: no resolved price/currency, and calculation may have null cost and
  components. Missing channel and unknown models remain unpriced.

Public JSON uses the existing CLI envelope. `data` contains `api: "public"`,
`action`, the validated client `request`, and the API result as `result`.
`request` is what the client sent, not a server echo. Lookup/calculation set
`catalog: null` because those responses do not carry catalog metadata. Models
and market include discovery's catalog and `as_of`. No content hash or core
version is claimed for a public result.

This is a bounded exploratory preview with valid inputs. Command checks do not
independently verify every supplier rate, all formats/provider combinations,
historical completeness, privacy/storage claims or production rate limits.
The API has accepted cached counts exceeding total input as priced in an OpenAI
edge case; the CLI rejects that malformed input before sending it.

## Market board and preserved history visualizations

The public market board reads current discovery, selects matching exact
channel/region metadata and performs at most `--limit` individual lookups. It
uses at most three concurrent lookups under one total command deadline. It
stops scheduling on a failure, makes no retries, and does not return an incomplete
board as complete. Empty discovery matches make no lookup requests.

Rows retain each lookup's status, missing dimensions, decimal rates and resolved
region. Discovery and lookups are separate reads, so this is not an atomic
snapshot. There is no cheapest-model ranking or historical coverage claim.
`--at` is unsupported on the public board; use `lookup --at` for one historical
price. No public historical returns, change percentages or sparklines are
fabricated from current metadata.

The existing event-sparkline market board, stock-style history chart, source
links and self-contained script-free HTML export remain available locally:

```sh
python3 -m venv /tmp/pricing-venv
/tmp/pricing-venv/bin/pip install metergraph-core==0.5.0
/tmp/pricing-venv/bin/python scripts/pricing-server.py --port 8765
# In another terminal:
node bin/metergraph.js pricing market --channel openai-api \
  --api reference --url http://127.0.0.1:8765
node bin/metergraph.js pricing history --model openai/gpt-5.6-terra \
  --channel openai-api --api reference --url http://127.0.0.1:8765
node bin/metergraph.js pricing history --model openai/gpt-5.6-terra \
  --channel openai-api --api reference --url http://127.0.0.1:8765 \
  --format html > history.html
```

Reference mode is restricted to loopback origins. Its adapter is development
checkout tooling, not part of the npm runtime or a public endpoint. It loads core
once and never fetches providers; restart it after updating core/catalog. It
retains the earlier `metergraph.pricing/v1` reference document format and GET
lookup/cost/history/market contract. That format is not asserted to be the
public API schema. `models` and `calculate` are public-only action names; use
`cost` with the reference adapter.

Reference charts show effective-dated base catalog windows, with gaps left
unknown. Event sparklines space by event, not time; the last contiguous window
change is not a daily return. The HTML view has a source-linked table and optional
Metergraph link. Exporting it does not publish a site or collect leads. This
work does not restart or replace any separate website, digest or growth project.

## Validation and networking

```sh
node --test test/pricing-public.test.js test/pricing.test.js
npm run test:package
# Opt-in real public service checks (no credentials/provider requests):
PRICING_PUBLIC_ORIGIN=https://app.metergraph.dev node scripts/pricing-public-smoke.mjs
# Isolated reference checks against actual core:
PRICING_PYTHON=/tmp/pricing-venv/bin/python node scripts/pricing-smoke.mjs
```

`PRICING_BIN` can select an installed packed CLI for either smoke script. The
public script is opt-in and not a live-service dependency of CI. Reference CI
uses immutable public core commit `62fb9fcee7e49280f924d7c1ccfbc37f442555a4`
(0.5.0). If the package version is unavailable on PyPI, install that checkout's
`./core` into the isolated environment. No different release is substituted.

Public pricing opts into Node's global HTTP agent to honor configured Node
proxy support. In a proxy-only Node 24+ environment, preserve its proxy/CA
settings and enable `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`). Existing
workspace/auth transports retain their prior isolated-agent behavior. Older
Node runtimes still work with direct service connectivity; a proxy-only runtime
without Node proxy support needs a supported environment. TLS verification stays
on and credentials are never read from project files or sent by pricing.

Invalid arguments exit 2 without a request. API 400/422 returns
`pricing_request_rejected` (2); network/timeout 4; 5xx 5; unsupported endpoint or
oversize body 6; redirects 7; malformed/inconsistent documents 11; rate limiting
16. Responses and headers are not echoed on failure. The CLI does not retry
POST calculations. No merge, package publication or deployment is performed by
these tests.

## Search fee contract preview

Public calculation now requests `contract_version: 2`. The server must acknowledge
that version. This prevents a server that ignores the new request field from
silently returning a token subtotal as a complete tool cost. With a server that
only supports the original contract, explicitly use `--contract-version 1`.
Lookup and discovery are unchanged.

| Client | Original server | Updated server |
| --- | --- | --- |
| Original CLI (five components) | Supported | Supported in default v1; search omissions are partial |
| Updated CLI, default v2 | Contract mismatch; select v1 explicitly | Supported, six components and itemized fees |
| Updated CLI, `--contract-version 1` | Supported token subtotal | Supported token subtotal; search omissions are partial |

Rollout order: review and land server support first, then release the updated CLI.
These changes do not publish a package or deploy a server. No automatic retry or
version downgrade is performed.

For Anthropic, supply the provider's **billable** counter. Zero is a measured zero;
omitting the flag leaves search usage unspecified. Failed searches excluded by
the supplier must not be included in this counter.

```sh
metergraph pricing calculate --model claude-sonnet-5 --provider anthropic \
  --input-tokens 0 --output-tokens 0 --web-search-requests 5 --json
```

The metadata-only request includes:

```json
{"contract_version":2,"format":"anthropic.messages","trace":{"model":"claude-sonnet-5","usage":{"input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":5}}},"context":{"provider":"anthropic"}}
```

The CLI currently constructs search usage only for `anthropic.messages`.
`--web-search-requests` requires an integer from 0 through 999999999999.
It does not synthesize OpenAI tool actions or infer search counts from citations.

V2 adds `components.search`, a `fees` array, and `uncaptured_fees`. Each fee carries
operation, tool, billing channel, unit, integer quantity, decimal-string
`rate_per_1k`, currency, decimal-string cost, price ID, source URL, effective
window, region, catalog version and hash. The CLI validates active dates,
channel, region fallback, fee arithmetic, the fee sum and the full component sum.
For example five searches at $10 per thousand contribute exactly `0.05000000`.
Search-content tokens remain in the provider's token accounting; they are not
charged again by this flag.

Read `status`, `missing_dimensions` and `uncaptured_fees` before treating a
subtotal as complete. Unsupported billing channels, tool versions, rates and
search-content token accounting remain explicitly partial. The independent
`request` component retains flat fees per model request and is never relabelled
as a fee per search. JSON output preserves all fee provenance returned by the API.

The client also binds each returned search quantity to the count it sent. A
positive count requires exactly one matching `web_search` fee, or an explicitly
partial/unpriced result with a specific missing search dimension. Zero cannot
be charged as a positive quantity, and a response cannot add a positive search
fee when the CLI sent no search usage. Duplicate fee lines and unsupported fee
operations or units are refused. Lookup responses have no fee fields.

Provenance validation checks field structure, active dates, billing channel,
region fallback, and arithmetic consistency. The returned catalog version,
hash, and source URL identify the server's stated catalog; these checks do not
cryptographically authenticate that catalog or independently verify supplier
usage. Costs are list-price calculations from supplied usage, not verified
invoices, and unknown dimensions remain visible.

Version 2 also requires an `assumptions` array. This flag-based CLI never sends
`context.search_content_tokens_included`, so it requires an empty array in
responses. A server cannot introduce an accounting assertion that this client
did not supply. Nonempty assumptions are refused as a contract mismatch, even
when their names are recognized.

Raw native API callers can explicitly supply search-content accounting evidence.
The API labels an inclusion assertion as `search_content_tokens_included` and
an excluded fixed-block scenario as
`search_content_tokens_excluded_fixed_block`. Those are caller-supplied
conditions, not independently verified provider facts. The excluded mini-model
scenario prices each search as 8,000 uncached input tokens; cache eligibility
for that block is not independently verified. `priced` means the catalog
calculation is complete **conditional on the supplied usage and assumptions**.
It does not certify that a provider reported the usage or that an actual
invoice has been reconciled. This CLI does not construct these native search
accounting assertions.
