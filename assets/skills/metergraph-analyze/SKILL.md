---
name: metergraph-analyze
description: Take one classified Metergraph workload to a model-swap recommendation through a connected Agent Access server, checking readiness, sample count and provider credentials, confirming spend before starting an analysis, then polling the run and explaining the report. Use for analysis, cheaper-model or model-swap requests after setup is verified; use the metergraph skill first when not connected.
---

# Analyze a workload for a model swap

This skill takes one classified workload to a recommendation: should this
workload move to a different model, and what would that do to quality and cost.
It is stage 4 of the `metergraph-model-swap` loop. Choosing the workload,
candidates and eval first (`metergraph-workloads`, `metergraph-candidates`,
`metergraph-evals`) makes the result easier to act on, but is not required.
It adds no tools, scopes or authority. When no Metergraph MCP server is
connected, stop and use the `metergraph` skill for setup routing. Never ask
for, echo, store or print a key, token or provider credential, and never read
`.env` values aloud.

## 1. Confirm the deployment and the tools

1. Call `metergraph_get_workspace_context`, then `metergraph_get_capabilities`.
   Confirm with the user that the workspace name, `provenance.workspace_id` and
   `deployment_profile` are the installation they mean. Stop on a mismatch or an
   authorization error.
2. Plan only from what the server advertises. Reading needs
   `metergraph_list_classified_workloads`, `metergraph_get_workload_readiness`,
   `metergraph_get_model_readiness`, `metergraph_list_analysis_runs`,
   `metergraph_get_analysis_run`, `metergraph_list_reports` and
   `metergraph_get_report`. Starting needs `metergraph_start_analysis` and the
   `analysis_start` capability with `available: true`. Do not guess a tool name
   or substitute a dashboard API, replay, generic SQL or a shell command.
3. Reading needs metadata only; starting adds `agent:analysis-run`. The start
   capability is classed `replay` because the run sends captured content to
   providers, but it does not need `agent:read` or `agent:replay`. Do not
   request those, read trace content or report evidence, or replay a trace to
   reach a recommendation.

## 2. When the start tool is missing

`metergraph_start_analysis` needs a coding-agent key with the Debug role and
**Allow analysis starts** (scope `agent:analysis-run`). `metergraph setup` and
the default OAuth sign-in cannot grant it. If the tool is absent or the
capability is unavailable, keep going with the read steps below, then tell the
user:

1. A workspace owner opens the **Keys** page in the Metergraph app, creates a
   coding-agent key with the Debug role and turns on **Allow analysis starts**.
2. The user puts the key in their MCP client configuration themselves, as an
   environment variable the configuration references (for example
   `METERGRAPH_AGENT_TOKEN`), and restarts the client.
3. They come back here; you repeat step 1 and confirm the tool is now listed.

Do not ask them to paste the key into chat, and do not write it to a file for
them. Until the tool appears, the run can also be started from the analysis
page in the Metergraph app.

## 3. Choose a workload and check readiness

1. `metergraph_list_classified_workloads` with a small limit. Each workload has
   a `display_name`, `classified_sample_count` and a `selection_reference`
   (`source_run_id`, `pattern_id`, `pattern_set_version`). Keep the selection
   reference exactly as returned; the name is a label, not identity. An empty
   list with `no_traces` or `classification_pending` means there is nothing to
   analyze yet: say so and point to sending more traffic.
2. For the workload the user cares about, `metergraph_get_workload_readiness`
   with that selection reference. Report `blocking_reasons`, the
   `counts` (classified, retained, eligible by capture metadata, missing) and
   the `retained_window`. `stale_checkpoint` means the classification is older
   than the current window.
3. **Check the sample count yourself.** An analysis evaluates a workload only
   when it has at least **10 samples** (`min_workload_samples`). Readiness may
   not block below that yet. With fewer than 10, the run still "completes", at
   no cost, with `no_eligible_workloads` and reason `insufficient_samples`.
   Below 10, do not start: explain the minimum, the current count and that the
   fix is more traffic for this workload. An analysis re-classifies the current
   capture window, so traces sent since the last classification count and the
   listed count may be stale; if the user says new traffic has arrived, say
   the count will be re-checked at launch rather than assuming it.
4. `metergraph_get_model_readiness`. If `provider_readiness.ready` is false or
   `missing_keys` is non-empty, name the missing key names (never values) and
   stop before starting. On a customer-local install the provider credential is
   `AI_GATEWAY_API_KEY` in the bundle's `.env`, set by the user and followed by
   a restart. `provider_calls_verified: false` means the key is configured, not
   proven to work. Note which candidate models are `selected`.

## 4. Confirm before starting

An analysis sends captured content of the sampled traces to the configured
model providers and spends money. Before calling the start tool, show the user
and get an explicit yes on:

- the workload (display name plus the selection reference) and its sample count;
- the selected candidate models and provider readiness;
- the expected cost and time: a single-workload run has taken about 6 minutes
  and cost about $0.22, but the server owns the limits and the real figure
  depends on the sample size and candidates;
- that only one analysis can run at a time in a workspace.

A configured provider key is not spend approval. A healthy connection is not
spend approval. If the user's request already names the workload and approves
a cost and time budget at or above these figures, that is the confirmation;
restate what you are starting and proceed. Otherwise ask and wait.

## 5. Start once, then poll

1. Choose a stable `request_key` (letters, digits, `.`, `_`, `:`, `-`), for
   example `analyze-<pattern_id>-<date>`, and keep it. Call
   `metergraph_start_analysis` with `request_key` and `pinned_workload` set to
   the selection reference. Add `reference_binding_id` only if the user chose
   one.
2. Keep `run.run_id`, the returned `pinned_inputs` (capture window, profile,
   `execution_limits`) and every warning. `request.replayed: true` means the
   same request already existed; that is the same run, not a new one.
3. If the response is uncertain (timeout, transport error), retry with the
   **same** `request_key` and the same arguments. Never reuse a key with
   changed arguments (`idempotency_conflict`). On `analysis_active`, follow
   the returned run instead of starting another. On `precondition_failed`,
   report the `reason` and stop.
4. Poll `metergraph_get_analysis_run` with the `run_id` at a modest interval
   (about every 30 to 60 seconds) and tell the user the status as it changes.
   Do not restart a run because it is slow. Stop polling when the status is
   final, and say if it failed, with its `error_code`.

## 6. Read the report and recommend

When `report.available` is true, call `metergraph_get_report` with
`report.analysis_id`. Use the summary format and report link in
`metergraph-report` when it is installed. Present:

- the report `outcome`: `opportunities`, `no_opportunities`,
  `partial_coverage` or `no_eligible_workloads`;
- for the workload: `state`, `sample_count` and any `reason`;
- each `model_swap` opportunity: candidate model, `recommendation_status`,
  `quality_vs_reference`, `safe_switch_rate`, `cost_ratio`,
  `quality_grade_counts`, any `evaluation_gate` effect, and `savings_usd`;
- `spend_projection`, `analysis_generation_cost` (what the run itself cost),
  every warning, and any returned links exactly as given.

State the caveats with the numbers: the sample size behind the grades; that a
projection from a short capture window is an extrapolation, not observed
savings; partial coverage; and that quality was judged by graders, not by the
user's own tests. Say whether the evidence supports a switch, no switch or more
testing. If the user's codebase shows where this workload's model is set, name
that call site and suggest a validation experiment; changing code is a separate
instruction.

## 7. Empty or ineligible results

Explain the result from its reasons; never retry blindly. `no_eligible_workloads`
with `insufficient_samples` means the workload had fewer than 10 samples in the
window: rerunning alone gives the same result, so the fix is more traffic first. `no_opportunities` means the
candidates did not beat the current model within the quality bar, which is a
real answer. `partial_coverage` and failed workloads name what was not
evaluated. A completed run with `report.available: false` is a missing report:
say so and point to the run in the Metergraph app.

A rerun is a new, separately approved run. Start it with a new `request_key` and
`rerun_of_run_id` set to the earlier run, and say what changed (more samples,
a different reference, new candidates). Nothing in this workflow changes
production traffic or configuration.
