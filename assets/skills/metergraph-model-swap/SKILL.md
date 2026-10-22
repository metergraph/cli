---
name: metergraph-model-swap
description: Run the Metergraph model-swap loop from a coding agent - choose a workload, choose traces and candidate models, define or refine the eval, start the analysis, summarize the report with its app link, then refine and rerun. Use when someone asks whether a workload could use a cheaper or better model, asks to plan or run a model swap analysis, asks "what should my largest workload run on", or comes back after inspecting a Metergraph report. Works through the metergraph CLI or the Agent Access MCP server; use the metergraph skill first only when neither can read the workspace.
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

## Start every session the same way

1. Run step 0.
2. Check loop access once, as **Loop access** below describes, and say what is
   missing before stage 1 rather than when a stage needs it.
3. Call `metergraph_list_analysis_runs` with a small limit (from the CLI,
   `metergraph tools call metergraph_list_analysis_runs --args '{"limit": 5}' --json`).
   If a run already exists for this workload, the person is probably on stage
   6: read its report first instead of starting over, and give the report link
   (`<origin>/#analysis?report=<analysis_id>`, as in `metergraph-report`).
4. Plan only with the tools step 0 listed. When a stage needs a tool that is
   not listed, say what it needs (loop access, or a deployment that offers
   it), keep the selection you have, and hand that step to the app page named
   in the stage skill. Never invent a tool, call a dashboard API with an agent
   key, or drive the app in a browser unless the person asks for that
   specific change.

## Loop access

Read access covers choosing the workload and candidates, checking readiness
and reading reports. Reading and testing evals, saving them and starting runs
need loop access. Check it from `data.jobs.loop` in `metergraph status --json`,
or over MCP from the `available` flags of `analysis_start` and the evaluation
capabilities. When it is missing, tell the person once what to grant for their
deployment (`deployment_profile`), then carry on with the stages read access
allows:

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
  `./bin/agent-key create --role debug --allow-evaluation-writes --allow-evaluation-previews --allow-analysis-starts --write-to ~/.config/metergraph/agent.env`
  in the bundle directory (adding `--yes`) only after the person agrees to
  exactly that access, or let them run it in their own terminal. Never add a
  grant they did not agree to. They load the file and restart the agent as
  above. A bundle without the command uses its own **Keys** page.
- **Customer-owned AWS** (`byoc-core`) **or the open-source server.** Loop
  access is not offered there: there are no managed evaluations and no trace
  content. Say so once and stop the loop.

The same `METERGRAPH_AGENT_TOKEN` serves the CLI and an MCP configuration that
references it; a client without a shell takes the key in its private connector
settings, as the `metergraph` skill describes. Never ask for the key in chat,
and never read, print or store it yourself. After the restart, run step 0
again.

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
  exact confirmation to get. A connected key, loop access, a configured
  provider key or an earlier yes for a different run is not approval.
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
workspace: <name> (<slug>) at <origin>
workload: <display_name>  source_run_id=<…> pattern_id=<…> pattern_set_version=<…>
environment: <production|…>  window: <from>–<to>
candidates: <model ids>
eval: <suite or rubric revision id, or "rubric in chat, not saved">
runs: <run_id> (<status>) → report <analysis_id> <link>
decision: <switch | no switch | more testing> because <reason>
next: <the one next step>
```

Never put keys, `.env` values or captured prompt or response text in it.
