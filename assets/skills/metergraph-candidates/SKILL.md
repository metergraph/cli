---
name: metergraph-candidates
description: Choose the traces and candidate models for a Metergraph model-swap analysis - pick the environment and window, check provider readiness, shortlist candidates that fit the workload and the route's residency, and list the route settings (replay opt-out, limits) the person must change in the app. Use for "which models should we test", "set up the analysis", or stage 2 of the metergraph-model-swap loop.
---

# Choose traces and candidate models

Input: one classified workload and its `selection_reference` (from
`metergraph-workloads`). Output: a run plan the person can approve in one
reply.

## 0. Discover what this agent can use

Skip this when the conversation has already done it. The `metergraph` CLI and
the Agent Access MCP server reach the same tools with the same key. Use
whichever this agent has, and never tell the person the other one is missing.

1. If `metergraph --help` lists `tools`, run `metergraph status --json` and
   `metergraph capabilities --json`, then `metergraph tools list --json`.
2. Otherwise, if Metergraph MCP tools are available, call
   `metergraph_get_workspace_context`, then `metergraph_get_capabilities`.
   Say nothing about the CLI.
3. If the CLI is installed without `tools` and there are no Metergraph MCP
   tools, check `npx --yes metergraph-cli@latest --help`. If it lists
   `tools`, use it as the prefix. If it does not, these stages need the
   Metergraph MCP connection: set it up with the `metergraph` skill and keep
   using the CLI for the reads it has. Do not tell the person to upgrade the
   CLI for `tools` unless a release's help lists it.
4. If one path cannot read the intended workspace, use the other. Use the
   `metergraph` skill for setup only when neither can.

Say in one line which workspace (name and slug, never its ID) and deployment
you reached, and stop if it is not the one the person means. Plan only with
the tools listed. The steps below name each tool once. From the CLI, call one
as `metergraph tools call <tool> --args '<json object>' --json` and read
`data.result`. A tool that writes, starts work or calls a provider (annotation
`readOnlyHint: false` or `openWorldHint: true`) also needs `--yes`: add it
only when this skill's approval rule for that exact call is met. Exit code 18
with reason `confirmation_required` means `--yes` was missing; ask the person.

Name missing access by the job it does. **Read access** is the Metadata role
(`agent:metadata`). **Loop access** is the Debug role (`agent:read`) plus
**Allow evaluation writes** (`agent:eval-write`), **Allow evaluation
previews** (`agent:eval-preview`) and **Allow analysis starts**
(`agent:analysis-run`). On the CLI, `data.jobs.read` and `data.jobs.loop` in
`metergraph status --json` say which this key has (`available`, and the
scopes still `missing`); over MCP, the capabilities' `available` flags do.
Only a workspace owner grants loop access; **Loop access** in
`metergraph-model-swap` says how on each deployment.

## 1. Which traces

The server picks the sample and the capture window; an agent cannot set sample
size. What you can decide with the person:

- **Environment.** If the workload's routes carry both production and staging
  traffic, recommend production only and pass the same `environment` to
  `metergraph_get_workload_readiness` and `metergraph_query_traces`.
- **Representative traces.** `metergraph_query_traces` with `workload` set to
  the `pattern_id`, plus `source_run_id` and `pattern_set_version`, and a
  limit of 5. From the CLI:
  `metergraph tools call metergraph_query_traces --args '{"workload": "<pattern_id>", "source_run_id": "<…>", "pattern_set_version": <…>, "limit": 5}' --json`.
  Look at status, model, tokens and latency. Read content with
  `metergraph_get_trace` only if the person wants it and the key has the Debug
  role. Exclude a spike window or failing traces from what you call typical.

## 2. Which candidate models

1. `metergraph_get_model_readiness`. It lists the deployment's candidate
   models, which are `selected`, `provider_readiness`, `missing_keys` and
   `provider_calls_verified`. Name any missing key by name, never value.
   `provider_calls_verified: false` means the key exists, not that it works.
2. Shortlist four to six candidates from what is offered. For each, give one
   reason:
   - a smaller model from the current model's family, which needs the least
     prompt rework and is the most likely winner;
   - one or two models from other vendors in the same price class;
   - one very cheap model as a floor;
   - optionally the current model's bigger sibling, only as a quality ceiling,
     never as a cost saving.
   Drop small models for long-context synthesis or long-output work; they
   rarely pass and each candidate adds replay cost.
3. Candidate selection is saved in the app's analysis configuration. No agent
   tool changes it. If the shortlist differs from what is `selected`, tell the
   person which models to add and remove on the **Opportunities** page before
   the run.

## 3. Route settings that block or change the run

Read them from `metergraph_list_routes` → `constraints` for the routes this
workload's traces come from.

| Setting | Why it matters | Who changes it |
| --- | --- | --- |
| `replay_opt_out` (default on) | Analysis replays captured prompts to candidates. With opt-out on, those traces are not eligible. Check `replay_eligible_calls`. | The person, per route, in the app |
| `residency_allow_list` (default `US`) | A candidate served outside the allowed region may win and still be unusable. Ask where each candidate is served before including it. | The person |
| `max_cost_per_call_usd`, `max_latency_ms` | Without them the report ranks models but cannot say which pass. Suggest about half today's cost per call and today's p95 latency. | The person |
| `provider_allow_list`, `model_allow_list`, `fixed_model` | Candidates outside these lists are excluded. | The person |

When `residency_allow_list` is set, always name it in the run plan and list
which selected candidates need a hosting-region check. Model readiness does not
say where a model is served.

Changing replay opt-out is a data decision: it lets Metergraph send this
route's captured prompts to the candidate providers. Ask for it explicitly, for
the routes in this workload only.

## 4. The run plan

End with this, filled in, and ask for one decision:

```
Workload: <display_name> (<n> samples, <environment>)
Candidates: <models> — add <…>, remove <…> on the Opportunities page
Route changes needed: <replay opt-out off for <route>> <limits>
Residency: <allowed regions> — check where <candidates> are served
Blocked on: <the first unresolved item>
```
