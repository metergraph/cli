---
name: metergraph-model-swap
description: Run the Metergraph model-swap loop from a coding agent - choose a workload, choose traces and candidate models, define or refine the eval, start the analysis, summarize the report with its app link, then refine and rerun. Use when someone asks whether a workload could use a cheaper or better model, asks to plan or run a model swap analysis, asks "what should my largest workload run on", or comes back after inspecting a Metergraph report. Use the metergraph skill first when Metergraph is not connected.
---

# Model-swap loop

This skill is the map. Each stage has its own skill; load it when you reach the
stage. The person stays in the coding agent for choosing, defining and
rerunning, and goes to the Metergraph app to read the detailed report and
inspect evidence.

```
choose workload → choose traces and models → define or refine eval
      → run analysis → summary + report link → (person inspects evidence in the app)
      → refine and rerun ↺
```

| Stage | Skill | Ends with |
| --- | --- | --- |
| 1. Choose workload | `metergraph-workloads` | One classified workload, with its `selection_reference` and why it was picked |
| 2. Choose traces and models | `metergraph-candidates` | A run plan: environment, window, candidate models, route settings that must change |
| 3. Define or refine the eval | `metergraph-evals` | A saved eval revision bound to the workload, or a written rubric the person enters in the app |
| 4. Run the analysis | `metergraph-analyze` | A run ID, polled to a final state |
| 5. Summarize | `metergraph-report` | A short summary and the report link |
| 6. Refine and rerun | `metergraph-iterate` | What changed and a new, separately approved run |

## Start every session the same way

1. Call `metergraph_get_workspace_context`, then `metergraph_get_capabilities`.
   Say which workspace and deployment you are connected to in one line. Stop if
   it is not the one the person means.
2. Call `metergraph_list_analysis_runs` with a small limit. If a run already
   exists for this workload, the person is probably on stage 6: read its report
   first instead of starting over, and give the report link
   (`<origin>/#analysis?report=<analysis_id>`, as in `metergraph-report`).
3. Write down the tools that are advertised. Plan only with those. When a stage
   needs a tool that is not advertised, say which one, keep the selection you
   have, and hand that step to the app page named in the stage skill. Never
   invent a tool, call a dashboard API with an agent key, or drive the app in a
   browser unless the person asks for that specific change.

## Rules that hold across stages

- **Workloads are not routes.** Routes are labels on traffic. An analysis runs
  on a classified workload, identified by `source_run_id`, `pattern_id` and
  `pattern_set_version`. Do not rank or plan on routes and then discover this at
  the start step.
- **Check the data before planning.** A workspace created today, data that all
  arrived in one batch, fewer than 10 samples, or totals that disagree between
  tools and the app all change the plan. Say so first, with the numbers.
- **One decision at a time.** End each turn with the single decision you need
  from the person, not a list of everything that could be configured.
- **Spending and data egress need a yes.** Starting an analysis sends copies of
  captured prompts to other model providers and costs money. Stage 4 has the
  exact confirmation to get. A connected key, a configured provider key or an
  earlier yes for a different run is not approval.
- **Settings are the person's.** Replay opt-out, data residency, candidate
  models, cost and latency limits and the size floor are changed in the app.
  Explain the change and give the page; do not make it for them.
- **Keep answers short.** Lead with the answer or the blocker. Tables only for
  three or more rows. Give confidence once, where it matters.

## Keep a loop record

Keep these values in the conversation, and, if you can write files in the
person's project and they agree, in `.metergraph/model-swap.md`. They are not
secret. They let a later session pick up at stage 6.

```
workspace: <name> (<workspace_id>) at <origin>
workload: <display_name>  source_run_id=<…> pattern_id=<…> pattern_set_version=<…>
environment: <production|…>  window: <from>–<to>
candidates: <model ids>
eval: <suite or rubric revision id, or "rubric in chat, not saved">
runs: <run_id> (<status>) → report <analysis_id> <link>
decision: <switch | no switch | more testing> because <reason>
next: <the one next step>
```

Never put keys, `.env` values or captured prompt or response text in it.
