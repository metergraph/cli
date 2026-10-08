---
name: metergraph-workloads
description: Choose which Metergraph workload to analyze - list classified workloads, rank them by spend with the source of each number stated, flag anomalies and suspect data, check readiness, and hand off when classification has not run. Use for "what is my largest workload", "list my workloads", "which workload should we optimize", or stage 1 of the metergraph-model-swap loop.
---

# Choose a workload

The goal is one classified workload, its exact `selection_reference`, and a
one-sentence reason it was chosen.

## 0. Confirm the connection

If this conversation has not already confirmed the workspace, call
`metergraph_get_workspace_context`, then `metergraph_get_capabilities`, before
anything else. Say which workspace you are connected to in one line, and plan
only with the tools the capabilities advertise.

## 1. Read what exists

1. `metergraph_list_classified_workloads` with a small limit (10). Each item
   has a `display_name`, `classified_sample_count` and a `selection_reference`
   of `source_run_id`, `pattern_id` and `pattern_set_version`. Keep the
   reference exactly as returned. The name is a label.
2. `metergraph_list_routes` and `metergraph_get_usage` with `days: 30`. These
   give cost, calls, tokens, latency and errors per route per UTC day, plus
   each route's `constraints` and `replay_eligible_calls`.
3. `metergraph_list_reports` with a small limit. If a recent report exists,
   `metergraph_get_report` gives each workload's `spend_projection`.

## 2. Rank by spend, and say where each number came from

There are two kinds of spend number. Do not mix them in one column.

| Number | Source | Meaning |
| --- | --- | --- |
| Observed cost | `metergraph_get_usage` | What was ingested in the window. Per route, not per workload. |
| Projected spend | a report's `spend_projection` (`daily_rate_usd`, `projected_monthly_cost_usd`, `population`) | An extrapolation the analysis made. Per workload. |

The app's pages can show projected numbers. If the person quotes figures from
the app that do not match what you read, say which source each one is before
ranking, and ask which one they mean. Never rank on classified sample counts:
they are the sample, not the traffic.

Rank on a typical day, not the total. Compute each route's median daily cost
over the window. If one day or one hour dominates a route's total, call it out
as a spike and investigate it with `metergraph_list_incidents` and
`metergraph_query_traces` (status and error counts) before treating that route
as large. A runaway loop or retry storm is a bug to fix, not a model to swap.

Present at most the top five, one line each: workload, current model(s), typical
daily cost, share of typical spend, and one reason it is or is not a good
candidate. Opus-class models on extraction, classification or short-output
work are the usual best candidates. Workloads already on small models, or
under about 5% of spend, rarely repay an analysis.

## 3. Check the data is real

Say so before planning when any of these hold, with the numbers:

- the workspace or all its data is only hours old, or arrived in one ingest
  batch (`metergraph_get_ingestion_health`);
- incidents or usage disagree with each other for the same day;
- traces are labeled synthetic or demo, or a route mixes staging and
  production. Ask which environment the analysis should use.

An analysis of seeded data proves the pipeline works and says nothing about
real costs.

## 4. Check readiness of the chosen workload

`metergraph_get_workload_readiness` with the selection reference and the
chosen environment. Report `blocking_reasons`, the counts and the
`retained_window` in one or two lines. An analysis needs at least **10
samples**. Below that it completes with `no_eligible_workloads`; the fix is
more traffic, not a rerun. `stale_checkpoint` means the classification is
older than the current window.

## 5. When nothing is classified yet

An empty list with `classification_pending` or `no_traces` means classification
has not run. No agent tool starts classification on its own. Tell the person:

1. Open the **Opportunities** page in the Metergraph app and choose **Find
   opportunities**.
2. Choose to pick a specific workload rather than the automatic option. That
   run classifies the traffic and then waits for them to choose a workload,
   before any candidate model is called.
3. The automatic option classifies and then immediately analyzes the largest
   workloads with the saved candidate models, which sends captured prompts to
   those providers and spends money. Point this out before they click.

When they are back, list classified workloads again and continue. Do not click
through the app yourself unless the person asks you to and has approved what
the button will do.
