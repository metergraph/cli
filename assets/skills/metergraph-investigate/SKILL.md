---
name: metergraph-investigate
description: Investigate a failed or anomalous LLM trace, usage spike, cost question (which route, provider or model costs most, a daily trend, a change from the prior period), incident or whether a code change moved cost, reading through the metergraph CLI first (fewer tokens) or a connected Metergraph Agent Access MCP server, answering only from bounded, cited evidence. Use after setup is verified; use the metergraph skill first when neither the CLI nor MCP can read the workspace.
---

# Investigate with Metergraph evidence

This skill expands the bounded investigation section of the public `metergraph`
skill. It adds no tools, scopes or authority. Never ask for, echo or store a
key.

Read through the `metergraph` CLI when this agent has a shell and the CLI can
read the workspace. Its typed reads (`usage`, `routes`, `traces`) return the
same Metadata evidence as the tools in far fewer tokens, and when its help
lists `tools`, `metergraph tools call` reaches every other Agent Access tool
(incidents, ingestion health, reports, retained content and replay). The
Agent Access MCP server reaches the same tools in clients that have no shell.
Use whichever this agent has, and never tell the person one is missing when
the other works. Stop and use the `metergraph` skill for setup routing only
when neither can read the workspace, or the user has not chosen a client,
runtime and deployment.

## 1. Discover before reading data

**With the CLI** (preferred when `metergraph --help` lists `status`,
`capabilities` and `usage`; an older CLI can run but lack them):

1. Run `metergraph status --json`. Continue when it exits 0 with
   `data.authenticated: true` and `data.workspace.match: true`. When `match`
   is null because no workspace was pinned (a coding-agent key without
   `--workspace`), name the workspace it reached by name and slug
   (`metergraph context --json` shows both) and continue only after the
   person confirms it is the workspace they mean. When it prints
   `data.next_action` (for example sign in again, or the coding-agent Metadata
   key path for a remote session), follow it; never ask for the key in chat.
2. Run `metergraph capabilities --json` and build the plan from
   `data.result.agent` (each capability's `available`, `privacy_class` and
   `required_scope`) and `data.result.bounds` (`max_days`, `max_rows`).
3. Before using any option, check that `metergraph help <command>` lists it.
   An option an older CLI lacks is a reason to call the matching tool, not to
   guess a flag. Always pass `--json`: the evidence is under `data.result`,
   with `data.notices` and `data.next_action` beside it, and the exit code is
   the outcome (for example 14 when the deployment does not offer the read).
4. When `metergraph --help` lists `tools`, `metergraph tools list --json`
   names every tool this key can call, and
   `metergraph tools call <tool> --args '<json object>' --json` calls one and
   returns its result under `data.result`. A tool that writes, starts work or
   calls a provider (annotation `readOnlyHint: false` or
   `openWorldHint: true`) also needs `--yes`, which you add only after the
   person's explicit approval of that exact call. Exit code 18 with reason
   `confirmation_required` means `--yes` was missing: ask, never add it on
   your own. An older CLI without `tools` has only the typed reads; for any
   other tool use MCP when this agent has it, or say the read needs a newer
   metergraph CLI (`npx --yes metergraph-cli@latest`).

**With MCP** (no shell, or a CLI too old for the read):

1. Call `metergraph_get_workspace_context`, then `metergraph_get_capabilities`.
   Do not call any other Metergraph tool first.
2. Build the tool plan only from what the server returns: the workspace
   context's `access.scopes`, and each capability under the capabilities
   response's `agent` object with its `available`, `privacy_class` (metadata,
   content or replay), `required_scope`, `mutates` and `external_calls`, plus
   `bounds` (`max_days`, `max_rows`). Treat the tools your client lists as the
   only callable tools.

Either way, confirm with the user that the workspace name and slug and the
deployment profile match the installation they intend; compare workspace IDs
yourself and never show them. A staging or demo workspace is not their
production workspace. A mismatch, an authorization error, or revoked or
expired access belongs to that one path:
when the CLI cannot read the intended workspace but a connected MCP server
can (or the other way round), use the path that can. Stop and tell the human
to reconnect through their client's secure flow only when neither the CLI nor
MCP can verify the intended workspace. A capability that is absent, or
has `available: false`, is a blocker to report, not something to guess, retry
under another name or replace with a dashboard API, generic SQL or an ad hoc
shell command. Some deployments are content-blind or have no replay,
incidents, ingestion health or reports.

## 2. Fix the question and the bound

Restate the question, the route or workload if known, and an explicit UTC
window. For grouped usage, windows are UTC: `days: N` means the current UTC
day so far plus the `N - 1` whole UTC days before it, so today is always
partial; `since` (inclusive) and `until` (exclusive) give an exact window.
Plain `metergraph usage --days N` (no grouping) is instead the last N x 24
hours, rolling and not aligned to UTC days; say so when you report it. Keep
every window within 90 days and within the capabilities' `bounds.max_days`.
Default to the shortest window that answers the question. Then choose the
smallest tool that can answer:

| Question | CLI (check its help first) | Tool | Bound |
| --- | --- | --- | --- |
| Which route, provider or model costs most; spend with one provider or model; a daily trend | `metergraph usage --group-by ... --json` with `--route`, `--provider`, `--model` or `--environment` | `metergraph_get_usage_aggregates` with `group_by` and the same exact filters | `--days`/`days` or `--since`/`--until`, small limit |
| Daily cost per route, when grouped usage is unavailable | `metergraph usage --days N --json` | `metergraph_get_usage` | days, small limit |
| Which routes exist or are replay eligible | `metergraph routes --json` | `metergraph_list_routes` | none needed |
| Is data arriving | `metergraph tools call metergraph_get_ingestion_health --args '{"days": 1}' --json` | `metergraph_get_ingestion_health` | `days` |
| Known alert or anomaly | `metergraph tools call metergraph_list_incidents --args '{"limit": 5}' --json` | `metergraph_list_incidents` | small `limit` |
| Cost or calls for one prompt, workflow or other tag value | `metergraph usage --group-by metadata.KEY --json`, or `--metadata KEY=VALUE` | `metergraph_get_usage_aggregates` with `group_by` including `metadata.<key>`, or `metadata` (exact pairs) | days, small limit |
| One failed call | `metergraph traces --status error --limit 1 --json` (also `--route`, `--metadata`) | `metergraph_query_traces` with `status` set to the failure status, and `route`, `trace_id`, `request_id` or `metadata` | limit 1 to 5 |
| One costly call (it may have succeeded) | `metergraph traces --route NAME --limit 5 --json` with no `--status`, then compare cost on that page | `metergraph_query_traces` with `route`, `trace_id`, `request_id` or `metadata`, no `status` | limit 1 to 5 |
| Which routes are slow (route level, not one call) | `metergraph usage --group-by route --sort p95-latency --json`; CLI `traces` returns no latency | `metergraph_get_usage_aggregates` grouped by route | days, small limit |
| One slow call | CLI `traces` returns no latency: ask for its trace or request ID, then `metergraph tools call metergraph_query_traces --args '{"trace_id": "<id>", "limit": 1}' --json`, or send the person to the trace in the app | `metergraph_query_traces` with that `trace_id` or `request_id` | limit 1 |
| A finished analysis | `metergraph tools call metergraph_list_reports --args '{"limit": 5}' --json`, then `metergraph_get_report` the same way | `metergraph_list_reports`, then `metergraph_get_report` | small `limit` |

A `metergraph tools call` row needs a CLI whose help lists `tools`; see
section 1 for what to do with an older one. Use grouped usage
(`metergraph usage --group-by`, or `metergraph_get_usage_aggregates`) only
when capabilities list `usage_aggregates` as available. On an older
deployment it is absent: say so, answer what `metergraph usage --days N` or
`metergraph_get_usage` can (cost per route and day), and do not rebuild
provider or model totals by paging traces.

### Cost questions

`metergraph_get_usage_aggregates` groups calls by any ordered subset of
`provider`, `model`, `route` and `day` (the call's UTC calendar day), plus at
most one `metadata.<key>`. Cost is
attributed per call, so a trace that used two providers adds each call's cost
to that call's provider. Groups come back highest cost first, at most `limit`
of them; `totals` cover every matching call whatever the limit. From a shell,
the `metergraph` CLI sends the same read and prints the same evidence. Check
`metergraph help usage` first: use these commands only when it lists
`--group-by`. An older CLI has only `metergraph usage --days N` (cost per route
and day); call the tool instead, through `metergraph tools call` or MCP,
whichever this agent has, and when neither has it, say this needs a newer
metergraph CLI.

| Question | Tool arguments | CLI |
| --- | --- | --- |
| Most expensive route today | `{"group_by": ["route"], "days": 1}` | `metergraph usage --group-by route --today --json` |
| Spend with one provider | `{"group_by": ["provider"], "provider": ["<name>"], "days": 7}` | `metergraph usage --group-by provider --provider <name> --days 7 --json` |
| Spend by model | `{"group_by": ["model"], "days": 7}` | `metergraph usage --group-by model --days 7 --json` |
| One route's daily trend | `{"group_by": ["day"], "route": ["<route>"], "days": 14}` | `metergraph usage --route <route> --group-by day --days 14 --json` |
| Cost by prompt ID | `{"group_by": ["metadata.prompt_id"], "days": 7}` | `metergraph usage --group-by metadata.prompt_id --days 7 --json` |
| Today against yesterday | two reads: `days: 1`, then `since`/`until` for the prior UTC day | `metergraph usage --group-by route --today --compare previous --json` |

Rank only what was returned. When `coverage.rows.truncated` is true (more
groups matched than `limit`), a ranking by calls, errors or latency covers
only the listed groups. Before naming a "top" group, raise `limit` to
`coverage.rows.matched` when that is at most 200 and at most the
capabilities' `bounds.max_rows`; otherwise narrow the read. Name the latency
you report:
`latency.avg_ms` is the mean over `latency.samples` calls that reported one,
and `latency.p95_ms` is an estimate from a fixed histogram
(`p95_method: histogram_estimate`), not an exact percentile.

A "costs most" answer needs exact pricing. When `pricing.cost` is
`lower_bound` (the overall `pricing`, or a group's own), some calls are not
fully priced, so a group with more unpriced calls can look cheaper than it is.
Name the group with the highest recorded cost as a lower bound and say the
ranking is not definitive until pricing is exact; never call it the most
expensive outright.

A prior-period comparison needs two reads with stated windows. Comparing
today so far with all of yesterday is not like for like: say so, or compare
with yesterday up to the same UTC time (`--compare previous-same-time` in the
CLI). A group missing from a truncated window is unknown, not zero.

A route is not a prompt. One route (for example `support-reply`) can carry
several prompt IDs in its metadata (SDK tags), and one prompt ID can run on
several routes. To answer "which prompt costs most", group by the metadata key
alone, so each prompt is one row across every route. Add `route` to `group_by`
only to show how a route splits by prompt. Keep the same `days` on every
follow-up read, so the examples come from the window you just summarised:

```json
{"name": "metergraph_get_usage_aggregates", "arguments": {"days": 7, "group_by": ["metadata.prompt_id"]}}
{"name": "metergraph_query_traces", "arguments": {"days": 7, "metadata": {"prompt_id": "reply-v3"}, "limit": 3}}
```

Metadata values are exact, case-sensitive opaque strings: `reply-v3` does not
match `reply-v30`, a call without the key never matches a filter, and several
filter keys must all match. In a read grouped by a metadata key, calls in the
window that have no value for the grouped key form the group whose value is
`null`, and `coverage.reasons` names `metadata_key_missing` (or
`metadata_value_ineligible` for a non-string or oversize value). Report that
group rather than dropping it. If you also filtered on that same key, no such
calls remain, so there is no `null` group. A `metadata_key_mostly_missing`
warning means most calls or cost have no value for the key; say so, and
suggest checking the key's spelling. `metadata_groups.unlisted` accounts for
every call not listed with a value: `other_values` (values past the limit, with
a group count), `missing_key` and `ineligible_value`. Report the spend in
`missing_key` plus `ineligible_value` as not attributed to any value of the
key, so a prompt ranking never reads as the whole spend. When
`coverage.rows.truncated` is true, the listed groups are not the whole window:
quote `totals` for the window and `coverage.rows.matched` as the number of
matched groups. That counts groups, not distinct values of the key: with
`group_by: ["route", "metadata.prompt_id"]` one prompt used on three routes is
three groups. For a count of distinct values, read with the metadata key as
the only dimension.

The CLI can run the same reads (`metergraph usage --group-by
metadata.prompt_id --days 7 --json`, where `--group-by-metadata prompt_id` is
the same dimension and the way to give a key that contains a comma, and
`metergraph traces --days 7 --metadata prompt_id=reply-v3 --json`) only in versions that
have these options. Check that `metergraph usage --help` lists `--group-by`
(and `metergraph traces --help` lists `--metadata`) before you suggest them,
and otherwise call the tools above through `metergraph tools call` or MCP.

Follow `next_cursor` only while you are still inside the agreed bound, and say
how many pages you read. Never request every trace, every report or unbounded
history.

## 3. Escalate privacy classes one step at a time

- Metadata tools answer most questions. Stay there unless the answer needs
  captured prompts, outputs, tool calls or report evidence.
- `metergraph_get_trace` and `metergraph_get_report_evidence` return captured
  content (`agent:read`). Ask the user before calling them, name the single trace
  or workload you will read, and do not quote more captured content than the
  answer needs. Never paste secrets you find in content.
- `metergraph_replay_trace` (`agent:replay`) sends a captured trace to a model
  provider and can spend money. It needs separate, explicit approval that names
  the trace, the overrides and the timeout; from the CLI, `--yes` stands for
  that approval and nothing else. Replay is non-persistent: it does not
  change production telemetry, prove a fix or substitute for an evaluation run.

Read access never grants evaluation writes, analysis launch, dashboard changes,
key rotation or production configuration changes. Refuse those requests and
point to the human action in the Metergraph app instead.

## 4. Answer only from returned evidence

Every answer cites, from the CLI results or tool responses you actually
received (a CLI result carries the same fields under `data.result`, plus
`data.notices`):

- **Workspace**: its name and slug, plus `deployment_profile`. Check that
  `provenance.workspace_id` is the confirmed workspace, but do not show it.
- **Window**: `window.since` to `window.until` in UTC (or `days`) for each
  read, and whether the last day is partial.
- **Provenance**: the tool or CLI command, `provenance.source` and
  `generated_at`.
- **Evidence and completeness**: `evidence.rows`, `evidence.complete`,
  `page.truncated` and whether a `next_cursor` was left unread; for usage,
  `coverage.completeness` with its `reasons`, `coverage.rows.matched` against
  the rows returned, and whether a total is the whole population
  (`totals.scope`) or only the returned rows.
- **Pricing and attribution**: `pricing.cost` (`exact` or a `lower_bound`) and
  `attribution.level`. A trace cost is a whole-trace total and is never split
  by provider.
- **Warnings**: every returned `warnings[].code` with its message. Say "no
  warnings returned" when the list is empty.
- **Identifiers and links**: trace, request, incident or analysis IDs, and
  `metergraph_links` values exactly as returned. Never construct a link.

Keep these states distinct and name the one that applies: no data in the
window, incomplete or truncated evidence, capability unavailable in this
deployment, classification pending, ambiguous request match
(`request_match.ambiguous`), failed analysis, and missing report. An empty page
does not prove there was no traffic; check ingestion health or a longer bounded
window before saying so. Do not round, extrapolate or invent totals. Never
attribute a cost change, or the absence of one, to a code change from source
code or a git diff; see section 5.

## 5. Code changes and cost: never decide from the diff

When the question is whether a commit, pull request, deploy or config change
raised, lowered or did not change cost, a git diff is never the evidence. Read
it to form a hypothesis (a different model, a longer prompt, a new retry loop, a
changed `max_tokens`, an added tool call), then say it is a hypothesis. Do not
answer "this commit increased cost", "this commit saved money" or "this commit
has no cost impact" from code alone, including a diff that touches no model or
prompt code: wrappers, retries, caching, routing, traffic and provider prices
change spend without appearing in the diff.

A cost conclusion needs returned Metergraph usage evidence:

1. Establish when the change reached the traffic Metergraph observes, from
   recorded commit or deployment identity (a deploy record, or the commit the
   telemetry itself carries). Merge time is not deploy time. Without that
   record, any before-and-after reading is only a time correlation: call it
   that, give the windows, and do not attribute the difference to the commit.
   If no one knows when it shipped, say the comparison cannot be anchored.
2. Read usage for the same route or workload over comparable, bounded UTC
   windows before and after that point (`metergraph usage --group-by ...
   --since ... --until ... --json` or `metergraph_get_usage_aggregates`, with
   explicit `since` and `until` and the same filters, or
   `metergraph_get_usage` where grouped usage is unavailable), and cite both
   reads as in section 4. Windows of equal length avoid comparing a partial
   day with a whole one. Filter both reads to the environment the deployment
   record names (`environment`), so traffic in another environment that
   shares the route is not credited to the change. If that environment
   cannot be isolated (for example the grant or deployment has no
   environment filter), say the cost impact is unknown.
3. Compare per-call cost and token counts as well as totals, so a traffic
   change is not mistaken for a code change. Name what else changed in the
   window when you know it (traffic, provider prices, other deploys).
4. If either window is incomplete, truncated or warned, if the windows are not
   comparable, or if the returned data cannot separate traffic by the change,
   state that the cost impact is unknown and name the next bounded check. Do
   not fill the gap from the diff.

Present the diff and the usage evidence separately: what the code suggests,
and what Metergraph measured.

## 6. Worked workflow: one failed trace

1. Discover: `metergraph status --json` and `metergraph capabilities --json`
   (or the context and capabilities tools). Confirm the workspace with the user.
2. Find: `metergraph traces --status error --days N --limit 1 --json` (or
   `metergraph_query_traces` with `status` set to the failure status, the
   agreed `days` and `limit` 1). If the user gave a request ID and the match is
   ambiguous, list the candidates and ask which one.
3. Explain from metadata: route, model, provider, tokens, cost, status and
   span count, plus latency only when the read returns it (CLI `traces` does
   not; never infer it from timestamps), with the citations above. If metadata is enough, stop here.
4. Optional content: with consent, `metergraph_get_trace` for that one trace to
   read the error, tool calls and root-cause classification.
5. Optional replay: only with explicit approval and when the trace is replay
   eligible, run one bounded `metergraph_replay_trace`, report the returned
   status and comparison, and state that nothing in production changed.
6. Close with what is known, what is unknown, and the next bounded check.
