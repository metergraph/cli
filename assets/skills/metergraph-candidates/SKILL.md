---
name: metergraph-candidates
description: Choose the traces and candidate models for a Metergraph model-swap analysis - pick the environment and window, check provider readiness, shortlist candidates that fit the workload and the route's residency, and list the route settings (replay opt-out, limits) the person must change in the app. Use for "which models should we test", "set up the analysis", or stage 2 of the metergraph-model-swap loop.
---

# Choose traces and candidate models

Input: one classified workload and its `selection_reference` (from
`metergraph-workloads`). Output: a run plan the person can approve in one
reply.

## 1. Which traces

The server picks the sample and the capture window; an agent cannot set sample
size. What you can decide with the person:

- **Environment.** If the workload's routes carry both production and staging
  traffic, recommend production only and pass the same `environment` to
  `metergraph_get_workload_readiness` and `metergraph_query_traces`.
- **Representative traces.** `metergraph_query_traces` with `workload` set to
  the `pattern_id`, plus `source_run_id` and `pattern_set_version`, and a
  limit of 5. Look at status, model, tokens and latency. Read content with
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

Changing replay opt-out is a data decision: it lets Metergraph send this
route's captured prompts to the candidate providers. Ask for it explicitly, for
the routes in this workload only.

## 4. The run plan

End with this, filled in, and ask for one decision:

```
Workload: <display_name> (<n> samples, <environment>)
Candidates: <models> — add <…>, remove <…> on the Opportunities page
Route changes needed: <replay opt-out off for <route>> <limits> <residency check>
Blocked on: <the first unresolved item>
```
