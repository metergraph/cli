---
name: metergraph-iterate
description: Refine and rerun a Metergraph model-swap analysis after the person has inspected the report in the app - turn their findings into a specific change (eval revision, cases, candidates, traffic or route settings), start a new approved run linked to the previous one, and compare the two honestly. Use when someone returns with "the grader is wrong on these cases", "drop that model", "rerun it", "what changed since last run", or stage 6 of the metergraph-model-swap loop.
---

# Refine and rerun

A rerun is a new run with one deliberate change. The earlier run, report and
eval revision stay as they are.

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

## 1. Recover where the loop is

1. Read the loop record (in the conversation or `.metergraph/model-swap.md`). If
   there is none, `metergraph_list_analysis_runs` and `metergraph_get_report`
   on the latest run for this workload, and rebuild it.
2. Confirm the workload's `selection_reference` still exists with
   `metergraph_list_classified_workloads`. A newer classification may have
   replaced it; say so and pick the matching workload by its traces, not by its
   name alone.

## 2. Turn the finding into one change

Ask what the person saw in the app, then map it:

| Finding | Change | Skill |
| --- | --- | --- |
| A grade is wrong on some cases | Fix the check or rubric criterion; save a new eval revision; add the cases as reference cases | `metergraph-evals` |
| The bar is missing something important | Add a check or criterion, test it on the preview, save a new revision | `metergraph-evals` |
| A candidate is clearly out, or one is missing | Change candidate selection on the Opportunities page | `metergraph-candidates` |
| Too few samples, or `insufficient_samples` | More production traffic for this workload, then rerun | `metergraph-workloads` |
| Traces were skipped | Replay opt-out or residency on a route; the person changes it in the app | `metergraph-candidates` |
| The winner looks right | No rerun. Plan the code change and a canary instead | — |

Change one thing per rerun when you can, so the comparison means something.
If several must change, list them all in the confirmation.

## 3. Rerun only with a new yes

A rerun spends money and sends captured prompts to providers again. Get the
same explicit confirmation as the first run (see `metergraph-analyze`), plus
what changed. If the request already names the change and approves a budget and
time, that is the confirmation: restate it, make the change (for an eval fix,
save the new revision first, as in `metergraph-evals`), then start. Then call `metergraph_start_analysis` with:

- a **new** `request_key`, for example `rerun-<pattern_id>-<yyyymmdd>-<n>`;
- the same `pinned_workload`, unless the workload itself changed;
- `rerun_of_run_id` set to the previous run ID;
- `reference_binding_id` when reference cases were bound.

Starting needs loop access. If it is missing, say what to grant, as
`metergraph-analyze` describes; until it is granted, the person can start the
rerun from the analysis page in the app. From the CLI, `--yes` stands for the
new confirmation and nothing earlier:

```sh
metergraph tools call metergraph_start_analysis --args '{"request_key": "rerun-<pattern_id>-<yyyymmdd>-<n>", "pinned_workload": <selection_reference>, "rerun_of_run_id": "<previous run_id>"}' --yes --json
```

Poll and read the report as in `metergraph-analyze` and `metergraph-report`.

## 4. Compare honestly

Show the two runs side by side only for what is comparable:

```
            run <a> (<date>)        run <b> (<date>)
eval        <revision a>            <revision b>
samples     <n>                     <n>
<candidate> <grade, cost ratio>     <grade, cost ratio>
```

If the eval revision, the sample or the candidate set changed, say that a
different grade may come from the change, not from the model. Then give the
decision line from `metergraph-report` with the new report link, and update the
loop record.
