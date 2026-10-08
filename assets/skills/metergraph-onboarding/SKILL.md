---
name: metergraph-onboarding
description: Guide a coding agent from an empty local or hosted MeterGraph workspace to a verified application trace, then hand off to workload and eval selection.
---

# Set up MeterGraph through the first usable trace

Confirm the user's deployment choice, application repository, target workspace,
coding client and whether they want SDK instrumentation or an existing supported
import. Use the actual MeterGraph origin the user selected. Do not guess an
origin from a credential. Record client/version, application revision, setup
start time and fixture source. Keep demo, synthetic, import and application
traffic distinct.

## Establish the deployment and workspace

For hosted MeterGraph, connect with OAuth. No operator-issued key is needed.
Add the hosted endpoint as an HTTP MCP server with no credential or headers,
for example `claude mcp add --transport http metergraph
https://app.metergraph.dev/v1/agent/mcp`. Then use the client's own
authentication step (in Claude Code, `/mcp`, choose `metergraph`, then
Authenticate). The human completes browser sign-in and consent in the browser,
in the workspace they intend to use, and confirms the workspace shown on the
consent page. The consent page names the requested role; a client following
the server's challenge requests Metadata. If the client cannot
complete OAuth, or the user needs retained content or replay, describe the
Keys-page scoped connection as a manual alternative and obtain the user's
choice. Never silently fall back to a key.

For the first application trace, check the installed Metergraph CLI's version
and help before naming commands. `metergraph-cli@0.1.0` has `doctor` and project
skill installation; a later installed version may offer `login`, `setup` and
`verify`. Use only commands present in that installation. Otherwise follow
https://www.metergraph.dev/docs/start/first-trace/ and its manual setup steps.
Do not infer that a server endpoint or source-only CLI command has shipped.

For customer-local MeterGraph, use the released bundle and its included
README, signed manifest and verification files. The human obtains the current
pull-only registry credential; registry access is not yet universally self-serve.
Use password-stdin and the local secret store for registry login. Verify the
archive before running its scripts. Configure the bundle's local settings,
start with `./bin/start`, and inspect `./bin/status` and the reported readiness.
Use the bundle's printed loopback URL. Record bundle version and image digests.
The human sets their local admin/database passwords and signs in. Reuse the
bundle's startup/recovery instructions; do not replace them with an ad-hoc
Compose stack. First boot may ingest a demo trace, which is synthetic evidence.

## Connect the coding client

For hosted OAuth, the connection is the URL-only server added above. For a
keyed or customer-local connection, reuse the Keys page's client-specific
instructions, documented in
https://www.metergraph.dev/docs/guides/agent-access/. The endpoint is
`<origin>/v1/agent/mcp`; the stdio bridge is `metergraph-mcp` with
`METERGRAPH_URL` and `METERGRAPH_AGENT_TOKEN` in its environment. Verify
`tools/list`, then `metergraph_get_workspace_context` and
`metergraph_get_capabilities`. Record the selected origin separately: `managed` identifies the hosted profile
and does not distinguish staging from production. Match the returned workspace ID and deployment
to the user's selection before reading traces. Capabilities and required scopes
from this connection are authoritative. Do not infer write authority from
`agent:read` or provider authority from a healthy MCP connection.

Keep these credentials separate:

| Credential | Destination and purpose | Human step |
| --- | --- | --- |
| Registry pull credential | Image registry only | Obtain/refresh through the supported distribution channel |
| Ingest credential | Application SDK or supported import connector | Create an ingest key for the selected workspace |
| Agent Access credential | Coding client's supported OAuth/secret configuration | Sign in/consent or create a scoped connection |
| Model-provider credential | Deployment's supported runner/provider configuration | Set the provider key and approve paid execution |

Never ask for secrets in chat, commit them, put them in a shared MCP file or
save them in verification evidence. A read connection is sufficient for this
onboarding verification. Replay, eval previews and analyses make separate
authorization and cost decisions.

## Instrument or import application traffic

Reuse the appropriate language/provider instructions and the repository prompt
at https://www.metergraph.dev/docs/agents/instrument-a-repo/#verify-one-application-call, or a supported
connector under https://www.metergraph.dev/docs/import/overview/. Inspect the real
application entry points first. Exclude tests, fixtures, mock libraries, demos
and validation jobs from production traffic claims. Keep provider base URLs,
gateway credentials and application behavior intact. Review instrumentation
changes with the user, including calls that could not be captured.

Use the selected deployment's ingestion destination and the ingest credential,
not its MCP URL or Agent Access key. Use that deployment's SDK/connector setup
instructions to choose the complete ingest URL. Set capture/retention as the
workspace owner intends; metadata-only telemetry does not prove retained
inputs/outputs needed for eval replay. Do not silently enable content capture.
Avoid treating received HTTP acceptance as worker processing completion.

With user authorization, trigger one normal application request/job and record
its application-owned trace ID and time. For an import, record the supported
connector, source trace identity and imported time window. Do not create an LLM
connection, paid eval rule or provider invocation just to manufacture proof.

## Verify and hand off

1. Read bounded `metergraph_get_ingestion_health` if available. Preserve pending,
   processed and failed states and receive/process timestamps. Counts apply to
   a workspace window; they do not identify the batch that contains one trace.
2. Read bounded `metergraph_query_traces` in the same workspace/time window and
   locate the exact application/import trace ID. Continue bounded pagination
   when advertised. An empty page is a setup state, not proof of no ingestion.
3. If the user permits a content-class read and `trace_content` is available,
   inspect one `metergraph_get_trace` for retained usable input/output and capture
   warnings. Record availability and omissions, never the content in setup logs.
4. When advertised, use classified-workload and model-readiness tools to explain
   available cohorts, capture eligibility, supported checks and missing provider
   credentials. A configured credential is not proof of a successful provider
   call. Missing capability is an explicit handoff blocker.
5. Return workspace/profile, bundle/app/client revisions, source label, exact
   trace ID/time window, ingestion and capture evidence, warnings, human steps
   still needed and the next eval selection action. A synthetic demonstration
   does not meet real application or hosted pilot acceptance.

Verify the named trace through the connected client's advertised MCP tools,
with an explicit source label and the same workspace/deployment before and
after any permitted content read. The older trace-debug contract has no
workspace envelope, so confirm its tenant-bound connection separately. Trace
discovery is not analysis readiness. Keep retained content out of setup reports.

## Recovery

| State | Next action |
| --- | --- |
| Signup, sign-in or OAuth consent required | Hand the browser step to the human, then reconnect and verify workspace identity |
| Registry access expired/denied | Refresh the pull credential through the supported distribution channel, repeat registry login, retain local data |
| Local startup or bootstrap failure | Inspect `bin/status` and the bundle's named logs/readiness checks; follow its recovery instructions |
| Runner unavailable | Use the bundle's runner health instructions; do not claim MCP health proves analysis readiness |
| Empty data | Check application environment, correct ingest destination/key, flush/import window and worker status; exclude demos/mocks |
| Received but pending/failed | Inspect ingestion failure classes and the existing retry/recovery flow before changing instrumentation |
| Missing/retained content unavailable | Explain capture policy, retention and omission; collect a new permitted application trace |
| Agent credential revoked or insufficient scope | Reconnect/re-authorize through the workspace owner's supported path; do not use an ingest key |
| Provider key absent or candidate unsupported | Complete the runner/provider setup or choose an available candidate; defer paid execution |
| API capability unavailable | State the unsupported deployment boundary and the specific supported next step |

Do not run destructive `down --volumes` as recovery. The bundle warns that raw
payload persistence differs from database persistence; prefer its stop/start
procedure and preserve existing data. Refine and rerun evals only through the
separately authorized workflow. Packaging this skill belongs to the distribution
workflow; this source does not assert that plugin OAuth/configuration or hosted
onboarding has already shipped.

Use the public skill's current client/runtime/deployment table at
https://www.metergraph.dev/SKILL.md. An unimplemented cloud/OAuth client path
is blocked even if server code exists. Query an exact SDK trace ID, or resolve a
provider request ID only when that argument is advertised. Ambiguous request IDs
need confirmation from the application; never select the first match. Preserve
checkpoint source run, pattern and pattern-set identities in workload queries and
cursor continuation. Missing/fallback IDs and expired records leave incomplete
evidence. Read classification availability separately from failed analysis and
report availability. Discovery must not launch or spend on classification or analysis.
