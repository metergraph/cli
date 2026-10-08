---
name: metergraph-investigate
description: Investigate a failed or anomalous LLM trace, usage spike or incident through an already connected Metergraph Agent Access server, answering only from bounded, cited evidence. Use after setup is verified; use the metergraph skill first when not connected.
---

# Investigate with Metergraph evidence

This skill expands the bounded investigation section of the public `metergraph`
skill. It adds no tools, scopes or authority. When no Metergraph MCP server is
connected, or the user has not chosen a client, runtime and deployment, stop and
use the `metergraph` skill for setup routing. Never ask for, echo or store a
key.

## 1. Discover before reading data

1. Call `metergraph_get_workspace_context`, then `metergraph_get_capabilities`.
   Do not call any other Metergraph tool first.
2. Confirm with the user that `provenance.workspace_id`, the workspace name and
   `provenance.deployment_profile` match the installation they intend. A staging
   or demo workspace is not their production workspace. Stop on a mismatch,
   an authorization error, or revoked or expired access, and tell the human to
   reconnect through their client's secure flow.
3. Build the tool plan only from what the server returns: the workspace
   context's `access.scopes`, and each capability under the capabilities
   response's `agent` object with its `available`, `privacy_class` (metadata,
   content or replay), `required_scope`, `mutates` and `external_calls`, plus
   `bounds` (`max_days`, `max_rows`). Treat the tools your client lists as the
   only callable tools. A tool or capability that is absent, or has
   `available: false`, is a blocker to report, not something to
   guess, retry under another name or replace with a dashboard API, generic SQL
   or a shell command. Some deployments are content-blind or have no replay,
   incidents, ingestion health or reports.

## 2. Fix the question and the bound

Restate the question, the route or workload if known, and an explicit window in
whole days (tools accept `days` from 1 to 90; default to the shortest window
that answers the question). Then choose the smallest tool that can answer:

| Question | First tool | Bound |
| --- | --- | --- |
| How much, how many, which route costs most | `metergraph_get_usage` | `days`, small `limit` |
| Which routes exist or are replay eligible | `metergraph_list_routes` | none needed |
| Is data arriving | `metergraph_get_ingestion_health` | `days` |
| Known alert or anomaly | `metergraph_list_incidents` | small `limit` |
| One failed, slow or costly call | `metergraph_query_traces` with `status`, `route`, `trace_id` or `request_id` | `limit` 1 to 5 |
| A finished analysis | `metergraph_list_reports`, then `metergraph_get_report` | small `limit` |

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
  the trace, the overrides and the timeout. Replay is non-persistent: it does not
  change production telemetry, prove a fix or substitute for an evaluation run.

Read access never grants evaluation writes, analysis launch, dashboard changes,
key rotation or production configuration changes. Refuse those requests and
point to the human action in the Metergraph app instead.

## 4. Answer only from returned evidence

Every answer cites, from the tool responses you actually received:

- **Workspace**: workspace name and `provenance.workspace_id`, plus
  `deployment_profile`.
- **Window**: `window.since` to `window.until` (or `days`) for each read.
- **Provenance**: the tool name, `provenance.source` and `generated_at`.
- **Evidence and completeness**: `evidence.rows`, `evidence.complete`,
  `page.truncated` and whether a `next_cursor` was left unread.
- **Warnings**: every returned `warnings[].code` with its message. Say "no
  warnings returned" when the list is empty.
- **Identifiers and links**: trace, request, incident or analysis IDs, and
  `metergraph_links` values exactly as returned. Never construct a link.

Keep these states distinct and name the one that applies: no data in the
window, incomplete or truncated evidence, capability unavailable in this
deployment, classification pending, ambiguous request match
(`request_match.ambiguous`), failed analysis, and missing report. An empty page
does not prove there was no traffic; check ingestion health or a longer bounded
window before saying so. Do not round, extrapolate or invent totals.

## 5. Worked workflow: one failed trace

1. Discover: context, then capabilities. Confirm the workspace with the user.
2. Find: `metergraph_query_traces` with `status` set to the failure status, the
   agreed `days` and `limit` 1. If the user gave a request ID and the match is
   ambiguous, list the candidates and ask which one.
3. Explain from metadata: route, model, provider, tokens, cost, latency, status
   and span count, with the citations above. If metadata is enough, stop here.
4. Optional content: with consent, `metergraph_get_trace` for that one trace to
   read the error, tool calls and root-cause classification.
5. Optional replay: only with explicit approval and when the trace is replay
   eligible, run one bounded `metergraph_replay_trace`, report the returned
   status and comparison, and state that nothing in production changed.
6. Close with what is known, what is unknown, and the next bounded check.
