# Changelog

`metergraph-cli` is published on npm. Preview versions use the `next` dist-tag;
`latest` stays on the last stable version, currently `0.2.2`.

## Unreleased

- One key for an agent. The read commands and `experiments` accept a coding-agent key
  with the Debug role and the workflow permissions a workspace owner grants (Allow
  evaluation writes, Allow evaluation previews, Allow analysis starts) as well as a
  Metadata key, and still send only their Metadata requests with it. `experiments start`
  accepts a Debug key with all three permissions. A key with Replay access is still
  refused.
- `tools list` and `tools call TOOL --args JSON` reach every Agent Access tool the
  credential can use, through the service's MCP endpoint, with the same sign in or key
  and checks as the read commands: classified workloads, readiness, evaluations, analysis
  runs and reports. A tool that writes, starts work or calls a model provider runs only
  with `--yes`; without it the command exits 18 and calls nothing.
- `login --role debug` signs in with the Debug role, and `--allow-evaluation-writes`,
  `--allow-evaluation-previews` and `--allow-analysis-starts` add those workflow
  permissions, the same flags `bin/agent-key` takes. A workspace owner approves them on
  the consent page, so no key needs creating or saving. The reads, `tools` and `status`
  use the grant, and `login --json` reports it in `data.access` as `status` does. Signing
  in again with another role or other permissions replaces the grant for the same
  workspace.
- `--workspace` takes a workspace's slug or name, as well as its ID, for `login`, the read
  commands, `tools` and `experiments`. `login` sends it to a consent page that can match it
  and offers approval for that workspace alone; an unknown or ambiguous name ends sign in
  with the slug to use. Text output names the workspace as "Name (slug)", never by ID;
  JSON adds `slug` and `name` beside `id`.
- JSON output escapes C1 control and bidirectional characters as `\uXXXX`.
- `status` reports the credential's role and each permission in `data.access`
  (`role`, `permissions` with one boolean per permission, and `permissions_offered`,
  false where the deployment offers no managed evaluations) and, in text, how to grant
  Debug with all three permissions on this deployment.

## 0.2.3 (prepared; not yet published)

- At a terminal, `setup` asks for what its flags leave out instead of failing one flag
  at a time: where Metergraph runs (offering a customer-local bundle it finds on
  `http://localhost:8080`), a non-hosted installation's address and workspace, whether
  its prerequisites are done, and which client gets the skill. The answers become
  ordinary flags, and the full command is printed before it runs, only once it parses. A
  project's saved route resumes without the deployment questions (setup still asks for
  the client when none is given), and Ctrl-C or Ctrl-D exits 17 `cancelled` with
  nothing changed. Only a person at a terminal is asked: with `--json`,
  a pipe or `CI`, setup keeps its flag errors and handoffs, and a remote session sends
  no request before its handoff.

- A successful customer-local setup returns `data.agent_access`. Setup grants the agent
  Metadata access only; a bundle that ships `bin/agent-key` can issue a key with the
  Debug role, which reads captured prompts and responses, and permission to write
  evaluations and start analyses, without a sign in, writing the key to a private file
  without printing it. The command text is fixed in the CLI, never taken from the service. At a terminal,
  setup offers to run that bundle's `bin/agent-key` once the person types the bundle
  directory and confirms the program's full path, then prints how to connect Claude Code
  or Codex. On Windows it prints the command to run inside WSL instead.

- Add public `pricing models`, `lookup`, `calculate` (`cost` alias), and a current
  market board using the documented GET/POST Pricing API. Preserve decimal strings,
  partial/unpriced results and regional fallback. Historical terminal charts and
  HTML exports remain available through an explicit loopback reference adapter;
  public history is unsupported.

- `experiments list`, `estimate`, `start` and `get` replay a workload's last 10 to 40
  production calls on 1 to 3 treatments (a provider, model and settings) and report
  cost, latency and output statistics per treatment next to production on the same
  calls. `estimate` prices it against the service's budget and writes nothing; `start`
  takes the same arguments; `get` says when to poll and, once finished, prints the
  statistics, which show differences and never judge them. The reads use the saved
  Metadata grant or a Metadata key and never read inputs or outputs. `start` needs a
  separate coding-agent key with Debug access and Allow analysis starts, checked for
  exactly that and used only for the start request. A service refusal (budget, daily
  cap, experiments running, an unpriced model) exits with the new code 19, `refused`;
  a start the service may have recorded without confirming it exits with the new code
  20, `unconfirmed`, and says to list experiments before starting again.

## 0.2.2

- The bundled skills, and the setup skill in the Python `metergraph-skills` package
  (0.1.5), now come from [metergraph/skills](https://github.com/metergraph/skills) at
  `39411ce`. The setup skill gives one CLI sequence per place the agent runs,
  including the deployment, address and workspace for customer-local and
  customer-owned AWS setup and a Metadata key for remote agents, sends the open
  source server to its MCP route, and keeps workspace identity out of public
  repositories and CI logs. A key used without `--workspace` continues once the
  person confirms the verified workspace. The investigation skill answers cost questions with grouped `usage`, splits
  cost by prompt with exact metadata rather than by route, and never judges a code
  change's cost impact from its diff alone. The analysis skill shows an analysis
  run's stages as a timeline.
- `usage` answers cost questions with grouped usage computed per call by the service:
  `--group-by provider,model,route,day`, exact `--route`, `--provider`, `--model` and
  `--environment` filters, an explicit UTC window (`--days N`, `--today`, or
  `--since`/`--until`), `--sort` by cost, cost per call, calls, errors, mean or p95
  latency or day, and `--compare previous|previous-same-time` with the change per
  group. `--compare previous` warns when a window ending part way through today is
  compared with a whole prior period. Help lists six worked examples. Without any of
  these options `usage` keeps its route-by-day listing. A service that does not
  offer grouped usage to the grant exits `capability_unavailable`
  (`usage_aggregates_unavailable`), reads nothing and, when the grant has the
  route-by-day read, points to `metergraph usage --days 7`.

- The browser page shown after a sign-in or setup approval now matches the service's consent
  page (Metergraph band and card) instead of a bare line of text, and says plainly that the
  command finishes in the terminal. The pages stay static and script-free; the policy is still
  `default-src 'none'`, with the one inline stylesheet allowed by its hash.
- A budget refusal met by the `--json --no-browser` background waiter is no longer lost. The
  waiter records what it is doing with an approval in `.metergraph/setup-refusal.json`; the agent's
  rerun waits while it is still redeeming (`setup_in_progress`) and then reports `retry_later` or
  `revoke_keys` instead of asking the person for another approval. Foreground runs report refusals
  directly and record nothing, and any successful run clears the record.
- Setup treats a partially numeric `Retry-After` (such as `60junk` or `1.5`) as unusable and does not
  wait on it.
- `setup` handles the service's ingest-key issuance budget. A short `Retry-After` is waited out
  and the same approval is redeemed again, so the person does not approve twice. A budget that
  stays exhausted exits `rate_limited` with a `retry_later` next action, and a workspace at its
  cap of active CLI setup keys exits `conflict` (`setup_key_limit`) with a `revoke_keys` next
  action pointing to the Keys page.
- A first `setup` that has to sign in now needs one browser approval instead of two
  when the service supports it: the sign-in consent also approves the project's
  ingest key and names both. The sign-in grant and the ingest key stay separate
  credentials with separate PKCE verifiers and separate revocation. Services without
  support, projects already signed in, `--repair` and replacement keep the separate
  ingest-only approval. With `--json --no-browser`, a first setup then takes two
  runs instead of three.
- `usage` and `traces` carry the service's coverage, pricing and cost attribution
  evidence when it is reported: requested and read window, completeness with reasons,
  whole-window totals separate from the returned rows, known zero prices apart from
  missing or unknown ones, and mixed-provider traces whose cost is never split by
  provider. A read the service reports as incomplete stays `complete: false` even on
  a last page without a cursor. Existing JSON fields are unchanged.
- Read commands (`status`, `context`, `capabilities`, `usage`, `routes`, `traces`)
  accept a coding-agent key with Metadata access from `METERGRAPH_AGENT_TOKEN`, or
  from a private file named by `--agent-token-file`, when browser sign in cannot
  finish where the agent runs. The key is verified (origin, workspace, exactly the
  Metadata scope, no content access) before any read, is never accepted as an
  argument, and is never written or printed. New options `--url` and `--workspace`
  pin where it is sent and which workspace it must be for; output adds `credential`
  and `environment`.
- `login`, `setup` and the read commands tell a local container from an SSH session,
  a cloud workspace and CI. Where sign in cannot finish they return a structured
  `use_agent_key` (or, for setup, `run_on_local_machine`) next action with the
  person's steps, the Keys page and the commands to run afterwards.
- `usage` and `traces` take `--metadata KEY=VALUE` (repeatable, up to 5 keys, all must
  match) and `--metadata-json JSON` to keep only calls whose SDK tags have exactly
  those string values. `usage --group-by-metadata KEY` groups the window by one key,
  highest cost first, through the service's usage aggregates; calls without the key
  or with a non-string value form one group with no value, and the window totals
  cover every call. The service must echo the applied filters in its coverage
  evidence; an older service that does not is refused with
  `metadata_filter_unsupported`. A grouping where no call has the key says so in one
  line.
- Help keeps a gap between every option and its description, however long the option.
- Human `usage` and `traces` output no longer repeats a notice that restates a printed
  Coverage or Pricing line, and prints service warning codes once. `--json` is
  unchanged.
- Human output (without `--json`) has a status headline with an icon, aligned fields
  and arrowed next steps. Color appears only on a terminal and respects `NO_COLOR`
  and `FORCE_COLOR`. Prose wraps to the terminal width; piped output keeps one line
  per message. `--json` output is unchanged.
- `login --runtime cloud` now explains that `--runtime` names where the terminal runs,
  not which Metergraph service, and prints `metergraph login --runtime local` as the
  command to sign in from your own machine.

## 0.2.1

- The bundled skills fall back to `npx --yes metergraph-cli@latest` instead of
  `@next`, which now carries prereleases only. The explicit `@latest` keeps npx from
  running an older globally installed copy. The README examples use `@latest` for the
  same reason.

## 0.2.0

First stable release of the 0.2.0 line, on `latest`. It is `0.2.0-preview.6` with no
code changes. Compared with `0.1.0`, it adds `setup`, `login`, `logout`, `status`,
`verify`, `usage`, `traces`, `routes`, `context`, `capabilities` and `skills`; see the
preview entries below. The README now installs from `latest` instead of `next`.

## 0.2.0-preview.6

- The bundled skill pack adds `metergraph-local-bundle`. It walks a coding agent
  through standing up the signed customer-local bundle on the person's own machine
  (verify the release signature and archive digest before extracting, create `.env`
  without printing its passwords, reuse an existing `.env` or database volume, run
  `bin/start`) and then hands over to `setup --deployment customer-local`. Remote,
  cloud and CI sessions get the `run_on_customer_machine` handoff instead. The
  bundled `metergraph` and `metergraph-onboarding` skills now point to it.
- The bundled agent skill, and the copy in the Python `metergraph-skills` package, now
  come from [metergraph/skills](https://github.com/metergraph/skills) at `dda4d5f`.
  The skill tells the agent what to do when `login` or `setup` with
  `--json --no-browser` exits 18: show `data.next_action.url` to the person and run
  the command again after they approve. On older CLIs that exit 6, the person runs
  setup in their own terminal. `skill update` upgrades unchanged earlier installs.
- `skill install|update` and `skills install|update` default `--runtime` to `local`,
  the runtime `setup` already installs the skill for, so
  `metergraph skills install --client claude` works without it. `--runtime cloud` and
  the `cloud-no-shell` handoff work as before. `metergraph-skills install|update` in
  the Python package gets the same default.
- `login --json --no-browser` and `setup --json --no-browser` no longer exit 6
  `no_browser_requires_terminal` when approval is needed. They exit within seconds
  with the new exit code 18 `action_required`, reason `browser_approval_required` and
  `data.next_action: {"kind": "open_url", "url", "timeout_seconds", "message"}`, so a
  coding agent can show the URL to the person. A detached background process keeps
  the loopback listener open until approval or `--timeout-ms` and saves what the
  approval completes. Run the same command again after approval to continue. The URL
  is the authorization request and carries no credential. The `run_in_terminal` next
  action is gone.
- Non-hosted `setup` (`--deployment customer-local|byoc|oss`) refuses an SSH, cloud
  workspace or CI session before it contacts the service or reads
  `--agent-token-file`. Previously it checked the route, and could read and send the
  agent token, before refusing.
- Every non-hosted setup handoff now carries `data.next_action` as an object with
  `kind`, `prerequisite` and `url`. Some handoffs returned a bare string.
- An unreachable customer-local origin points to the `bundle_started_verified`
  prerequisite, and an unreachable BYOC origin to `check_private_network`, instead of
  the general connection guide.
- Non-hosted setup handoffs add `data.next_action.message`, fixed guidance for the
  next step. Without `--json`, setup prints each pending prerequisite with what to
  do, for example how to start and check the customer-local bundle, and that the
  registry pull credential never goes to this CLI.
- A customer-local or BYOC setup rerun can omit `--deployment`, `--url`,
  `--workspace` and `--confirm-prerequisites`. It resumes the saved route and checks
  the live service again. Previously a plain rerun failed with
  `deployment_profile_mismatch`.
- `setup` refuses an existing `METERGRAPH_APP_TOKEN` it did not issue before sign in,
  instead of after a browser approval.

## 0.2.0-preview.5

- New `skills install`, `skills update` and `skills list` commands install the
  Metergraph workflow skills bundled with the CLI: the model-swap loop
  (`metergraph-model-swap`, `-workloads`, `-candidates`, `-evals`, `-analyze`,
  `-report`, `-iterate`) plus `metergraph-investigate` and `metergraph-onboarding`.
  Each skill gets its own ownership receipt in `.metergraph/skills/`, with the same
  ownership rules as `skill install`. No network access. `--client claude-desktop`
  writes nothing and points to the `metergraph/skills` plugin marketplace.
- The bundled agent skill now comes from
  [metergraph/skills](https://github.com/metergraph/skills) at a pinned commit, and CI
  fails if the npm or Python copy drifts from it. The skill points agents to the other
  Metergraph skills, and to `metergraph-model-swap` for model-swap questions.

## 0.2.0-preview.4

- The bundled agent skill tells the agent to use the ingest key that `setup` already
  wrote to the project's env file, instead of asking for a separate ingest credential,
  and to look up the documentation when it is stuck.

## 0.2.0-preview.3

- A `verify` deadline that expires after the service reported the trace as pending now
  returns `trace_not_found_within_bounds`, the same result as running out of attempts,
  instead of `verification_timeout`.
- `setup --json --no-browser` returns a `run_in_terminal` next action when approval is
  needed.
- `login` and `setup` use a pre-registered CLI client when the service names one in
  `metergraph_cli_client_id`, instead of registering a new client, and still register
  one on services that do not.

## 0.2.0-preview.2

- `verify` exits 11 `verification_failed` when its deadline expires after the service
  reported the trace as pending.
- `login` and `setup` reruns that need no approval succeed with `--json --no-browser`.
- `verify --open` reports why it did not launch a browser.

## 0.2.0-preview.1

- `setup` writes the SDK service root as `METERGRAPH_INGEST_URL` and, after checking
  the saved key, repairs the full ingest endpoint that `0.2.0-preview.0` wrote.
- Metadata reads keep validated, workspace-bound trace links.

## 0.2.0-preview.0

- Adds `login`, `logout`, `setup`, `verify`, `status`, `context`, `capabilities`,
  `usage`, `routes` and `traces`.
- Adds exit codes 10 to 17.

## 0.1.0

- First release: `doctor`, `skill install` and `skill update`. No sign in commands.
