# Changelog

`metergraph-cli` is published on npm. Preview versions use the `next` dist-tag;
`latest` stays on the last stable version, currently `0.1.0`.

## Unreleased

- Non-hosted `setup` (`--deployment customer-local|byoc|oss`) refuses an SSH, cloud
  workspace or CI session before it contacts the service or reads
  `--agent-token-file`. Previously it checked the route, and could read and send the
  agent token, before refusing.
- Every non-hosted setup handoff now carries `data.next_action` as an object with
  `kind`, `prerequisite` and `url`. Some handoffs returned a bare string.
- An unreachable customer-local origin points to the `bundle_started_verified`
  prerequisite, and an unreachable BYOC origin to `check_private_network`, instead of
  the general connection guide.

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
