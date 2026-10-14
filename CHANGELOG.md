# Changelog

`metergraph-cli` is published on npm. Preview versions use the `next` dist-tag;
`latest` stays on the last stable version, currently `0.2.1`.

## Unreleased

- `usage` answers cost questions with grouped usage from the service: `--group-by`
  any of provider, model, route and UTC day, plus one `metadata.KEY`, exact `--route`,
  `--provider`, `--model`, `--environment` and `--metadata` filters, and a UTC window
  (`--days N`, `--today`, or `--since` with `--until`). Groups are attributed per call, totals cover every matching call,
  and coverage, pricing and attribution are shown in text and JSON. `--sort` ranks by
  cost, cost per call, calls, errors, mean latency or estimated p95 latency (labelled
  as an estimate) and says when a ranking covers only the listed groups. `--compare
  previous` adds the prior period and warns when a partial current UTC day is
  compared with a whole one; `--compare previous-same-time` compares equal lengths.
  A deployment without grouped usage exits 14 with a `next_action` naming the read
  it does support. Plain `usage` without these options is unchanged. `usage --help`
  lists tested examples, also in `--help --json`.
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
