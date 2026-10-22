---
name: metergraph-analyze
description: Take one classified Metergraph workload to a model-swap recommendation through the metergraph CLI or the Agent Access MCP server, checking readiness, sample count and provider credentials, confirming spend before starting an analysis, then polling the run and explaining the report. Use for analysis, cheaper-model or model-swap requests after setup is verified; use the metergraph skill first only when neither the CLI nor MCP can read the workspace.
---

# Analyze a workload for a model swap

This skill takes one classified workload to a recommendation: should this
workload move to a different model, and what would that do to quality and cost.
It is stage 4 of the `metergraph-model-swap` loop. Choosing the workload,
candidates and eval first (`metergraph-workloads`, `metergraph-candidates`,
`metergraph-evals`) makes the result easier to act on, but is not required.
It adds no tools, scopes or authority, and works the same through the
`metergraph` CLI or the Agent Access MCP server (step 0). Never ask for, echo,
store or print a key, token or provider credential, and never read `.env`
values aloud.

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

## 1. Check the tools and access

1. Confirm that `deployment_profile` is the installation the person means.
   Stop on a mismatch or an authorization error that neither path gets past.
2. Plan only from the tools step 0 listed. Reading needs
   `metergraph_list_classified_workloads`, `metergraph_get_workload_readiness`,
   `metergraph_get_model_readiness`, `metergraph_list_analysis_runs`,
   `metergraph_get_analysis_run`, `metergraph_list_reports` and
   `metergraph_get_report`. Starting needs `metergraph_start_analysis` and the
   `analysis_start` capability with `available: true`. Do not guess a tool name
   or substitute a dashboard API, replay, generic SQL or an ad hoc shell
   command.
3. Reading needs read access. Starting needs the Debug role plus **Allow
   analysis starts** (`agent:read` and `agent:analysis-run`), both part of loop
   access. The start capability is classed `replay` because the run sends
   captured content to providers, but it does not need `agent:replay`. Do not
   request replay, read trace content or report evidence, or replay a trace to
   reach a recommendation.

## 2. When start access is missing

`metergraph setup` and the default sign-in grant read access only. Starting
needs only the Debug role and **Allow analysis starts**; the evaluation
permissions belong to the full model-swap workflow, not to this step. If
`metergraph_start_analysis` is not listed or `analysis_start` is unavailable,
keep going with the read steps below, then tell the person once what to grant
for their deployment (`deployment_profile`):

- **Hosted** (`managed`). When the agent has a shell and `metergraph help
  login` lists `--access`, run `metergraph login --access loop` with the
  runtime and approval flags the `metergraph` skill uses for `login`; a
  workspace owner approves the request on the consent page. Otherwise a
  workspace owner creates a coding-agent key on the **Keys** page with the
  **Model-swap loop** access choice. The person saves it in their own editor
  as `export METERGRAPH_AGENT_TOKEN=…` in a private file outside the project
  (for example `~/.config/metergraph/agent.env`), runs
  `. ~/.config/metergraph/agent.env` in the shell that starts the agent, and
  restarts the agent.
- **Customer-local bundle** (`local`). The bundle's `bin/agent-key`, as
  `metergraph-local-bundle` describes. Explain what each grant allows; run
  `./bin/agent-key create --role debug --allow-analysis-starts --write-to ~/.config/metergraph/agent.env`
  (add `--allow-evaluation-writes --allow-evaluation-previews` only if they also
  want the agent to write and test evaluations)
  in the bundle directory (adding `--yes`) only after the person agrees to
  exactly that access, or let them run it in their own terminal. Never add a
  grant they did not agree to. They load the file and restart the agent as
  above. A bundle without the command uses its own **Keys** page.
- **Customer-owned AWS** (`byoc-core`) **or the open-source server.** Loop
  access is not offered there: there are no managed evaluations and no trace
  content. Say so once and stop before the start step.

The same `METERGRAPH_AGENT_TOKEN` serves the CLI and an MCP configuration that
references it; a client without a shell takes the key in its private connector
settings, as the `metergraph` skill describes. Do not ask them to paste the key
into chat, and never handle the token or write it to a file yourself. When
they come back, run step 0 again and confirm the start tool is now listed.
Until then, on a deployment that offers analyses, the run can also be started
from the analysis page in the Metergraph app.

## 3. Choose a workload and check readiness

1. `metergraph_list_classified_workloads` with a small limit. Each workload has
   a `display_name`, `classified_sample_count` and a `selection_reference`
   (`source_run_id`, `pattern_id`, `pattern_set_version`). Keep the selection
   reference exactly as returned; the name is a label, not identity. An empty
   list with `no_traces` or `classification_pending` means there is nothing to
   analyze yet: say so and point to sending more traffic, or see
   `metergraph-workloads` step 5 on starting a classification.
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
   one. From the CLI, `--yes` stands for the confirmation in section 4; never
   add it before that:

   ```sh
   metergraph tools call metergraph_start_analysis --args '{"request_key": "analyze-<pattern_id>-<date>", "pinned_workload": <selection_reference>}' --yes --json
   ```
2. Keep `run.run_id`, the returned `pinned_inputs` (capture window, profile,
   `execution_limits`) and every warning. `request.replayed: true` means the
   same request already existed; that is the same run, not a new one.
3. If the response is uncertain (timeout, transport error), retry with the
   **same** `request_key` and the same arguments. Never reuse a key with
   changed arguments (`idempotency_conflict`). On `analysis_active`, follow
   the returned run instead of starting another. On `precondition_failed`,
   report the `reason` and stop.
4. Poll `metergraph_get_analysis_run` with the `run_id` (from the CLI,
   `metergraph tools call metergraph_get_analysis_run --args '{"run_id": "<run_id>"}' --json`)
   at a modest interval (about every 30 to 60 seconds). Do not restart a run because it is slow.
   Stop polling when the status is final, and say if it failed, with its
   `error_code`.
5. After the start and after every poll, write a progress report in the
   shape shown under "Show run progress" before you wait, set a timer or
   schedule the next check. The start response already carries
   `run.stages`, so the reply that starts the run has one too. A one-line
   status such as "The run is exporting; I'll check again in a minute" is
   not a progress report. The graphic is required every time.

## Show run progress

Draw the stages from `run.stages.items`, in the order returned. Use each
item's `state` exactly as given. Never decide a stage's state from `status`,
trace names or the report.

Render one line with a marker per state: `✓` completed, `●` current, `✗`
failed, `–` skipped, `○` not started. For example:

```
✓ queued → ✓ exporting → ✓ analyzing → ● classified → ○ importing → ○ completed
```

If the client can draw a richer inline graphic, you may use one. Keep the
same order and states, and make the states distinct without relying on
colour alone.

Under the graphic, always write a plain-text line that says the same thing:
the stages that are done, the current stage, and the stages still to come.

Every check-in, including the reply that starts the run, has this shape:

````
Run 3f2a… at 19:34 UTC:

```
✓ queued → ✓ exporting → ✓ analyzing → ● classified → ○ importing → ○ completed
```
Done: queued, exporting, analyzing. Now: classified, since 19:23 UTC
(11 minutes, unchanged since the last check). Still to come: importing,
completed. No error, no report yet. Next check in about a minute.
````

- **Time in the current stage.** Take it from the current item's
  `entered_at` and the response's `provenance.generated_at`, which is the
  check time. Say when you last checked, and say plainly when the stage has
  not changed since the last check. Never give a percentage, an ETA or a
  time remaining. The run data supports neither.
- **Finished.** On `completed`, draw the items as returned, like any other
  check: the stages the run passed through are `✓`, and a stage it never
  entered stays `–` skipped. When `report.available` is true, read the
  report (step 6) and give any link it returns exactly as given. When it is
  false, say plainly that no report exists yet.
- **Failed.** On `failed`, mark the stage it stopped in with `✗`, give the
  `error_code`, and leave the later stages `○`.
- **No stage data.** When `run.stages.available` is false, or `stages` is
  missing, show no graphic. Say the stage breakdown is unavailable for this
  run (`unavailable_reason`, when present). Report the `status`, the
  timestamps, the `error_code` if the run failed, and whether a report
  exists. Never mark stages complete by inference.

## 6. Read the report and recommend

When `report.available` is true, call `metergraph_get_report` with
`report.analysis_id`. While it is false, do not look for a report under
another or guessed ID. Use the summary format and report link in
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
