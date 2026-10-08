---
name: metergraph-report
description: Summarize a finished Metergraph analysis in a few lines with the link to its report in the app, say whether the evidence supports a switch, no switch or more testing, and tell the person exactly what to inspect in the app. Use after an analysis completes, when someone asks "what did the analysis find", "should we switch", "give me the report link", or stage 5 of the metergraph-model-swap loop.
---

# Summarize the report and hand off to the app

The coding agent gives the answer and the link. The app is where the person
reads the full report and inspects case-level evidence.

## 0. Confirm the connection

If this conversation has not already confirmed the workspace, call
`metergraph_get_workspace_context`, then `metergraph_get_capabilities`, before
anything else. Say which workspace you are connected to in one line, and plan
only with the tools the capabilities advertise.

## 1. Read it

1. `metergraph_get_analysis_run` with the run ID. Continue only when the status
   is final. If `report.available` is false on a completed run, the report is
   missing: say so and give the run's page (below).
2. `metergraph_get_report` with `report.analysis_id`. Read the `outcome`, each
   workload's `state`, `sample_count` and `reason`, each `model_swap`
   opportunity (`recommendation_status`, `quality_vs_reference`,
   `safe_switch_rate`, `cost_ratio`, `quality_grade_counts`,
   `evaluation_gate`, `savings_usd`), `spend_projection`,
   `analysis_generation_cost` and every warning.
3. Read evidence with `metergraph_get_report_evidence` only if the person asks
   about specific cases and the key has the Debug role. It returns captured
   content.

## 2. Write the summary

At most eight lines, in this order:

```
<Switch | Don't switch | Test more>: <workload> from <current model> to <candidate>.
Quality: <quality_vs_reference>, <safe_switch_rate> of cases safe to switch, graded on <n> samples against <eval revision or "default graders">.
Cost: <cost_ratio>× per call; about $<savings_usd>/month projected from <observed_days> days of traffic.
Runner-up: <candidate> — <one reason it lost>.
Caveats: <sample size, short window, partial coverage, failed candidates, no eval bound>.
Report: <link>
Inspect: <the one thing to look at in the app>
```

Rules:

- Every number comes from the report. Say "projected" for `spend_projection`
  figures; a projection from a few days of traffic is not observed savings.
- Keep quality failures, evaluator or execution failures and missing coverage
  apart. A candidate with missing results has not passed.
- If no eval was bound, say the grades came from default graders, not from the
  person's own quality bar, and point to `metergraph-evals`.
- `no_opportunities` is a real answer: the candidates did not beat the current
  model within the bar. `no_eligible_workloads` with `insufficient_samples`
  needs more traffic, not a rerun.
- If the person's code shows where this workload's model is set, name the file
  and line and suggest a canary experiment. Do not change code without a
  separate instruction.

## 3. Links

Use a link a tool returned (`metergraph_links`, `links`) exactly as given.
Otherwise build it from the origin of the Metergraph server the agent is
connected to (hosted is `https://app.metergraph.dev`; the customer-local bundle
is normally `http://127.0.0.1:8080`) and these app routes:

| Page | Route |
| --- | --- |
| Report | `<origin>/#analysis?report=<analysis_id>` |
| One workload's results in a report | `<origin>/#analysis/<analysis_id>/workloads/<workload_id>/model_evaluation` |
| Workload evidence | `<origin>/#workloads?pattern=<workload_id>&report=<analysis_id>` |
| Eval definition used | `<origin>/#analysis/<analysis_id>/workloads/<workload_id>/eval_definition` |
| All analyses and runs | `<origin>/#opportunities` |

Say that a built link was built, not returned, in a few words. If the person
says it does not open, give the Opportunities page instead.

## 4. What to inspect in the app

Name one or two concrete things, from what the report shows:

- cases where the candidate was graded worse than the current model, to judge
  whether the grader or the candidate is wrong;
- a check with a surprising pass rate, which may be a bad check;
- the cost of the cases that drive most of the spend.

Then ask the person to come back with what they found: grades they disagree
with, cases that should be added, or a candidate to drop. That is the input to
`metergraph-iterate`.
