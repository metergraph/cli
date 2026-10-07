---
name: metergraph
description: Route Metergraph setup by client, execution runtime and deployment, then perform bounded evidence-backed investigation when already authenticated.
---

# Use Metergraph with your agent

Public setup: https://www.metergraph.dev/docs/guides/agent-access/
Connection and troubleshooting: https://www.metergraph.dev/docs/guides/agent-access/

## Confirm setup before producing instructions

Ask for or confirm these non-secret choices. Do not guess from the agent brand:

1. Client: Claude Desktop, Claude Code, ChatGPT, Codex or Cursor.
2. Execution runtime: customer machine or cloud. Codex local app/CLI/IDE is distinct from cloud execution. Claude Desktop remote connectors execute in Anthropic's cloud; Desktop local MCP is a separate mechanism. ChatGPT MCP apps execute in the cloud.
3. Deployment: Metergraph hosted cloud, the signed commercial customer-local bundle, a customer-owned AWS installation (`byoc-core`), or the open-source self-hosted server. These have different addresses, accounts and credentials. Staging is not a customer setup path.
4. Fresh workspace/installation or connecting an existing workspace. Ask for the intended workspace name and deployment origin, never a token.

Use the routing below with those four choices. Follow the matching credential and client configuration instructions in the connection guide.

For a first application trace, check the installed CLI's version and help before
using it. `metergraph-cli@0.1.0` supports `doctor` and project skill
installation; later versions may also offer `login`, `setup` and `verify`.
Use those commands only if the installed package lists them. Use the [first
trace guide](https://www.metergraph.dev/docs/start/first-trace/) for steps the
package does not support. A CLI login or health probe alone does not prove
application traffic. Verification needs an exact trace or request ID from an
application invocation, its time window and the intended workspace.

## Route honestly

| Client and runtime | Hosted | Customer-local bundle | Customer AWS | Open source self-hosted |
| --- | --- | --- | --- | --- |
| Claude Code or Codex on the customer machine | Keyed HTTP at `https://app.metergraph.dev/v1/agent/mcp` | Keyed HTTP at the installed local address, normally `http://127.0.0.1:8080/v1/agent/mcp` | Keyed HTTP at the customer's reachable installation address | Static `MG_AGENT_TOKENS` bearer at the OSS server address, normally `http://localhost:8787/v1/agent/mcp` |
| Cursor on the customer machine | Project skill supported; MCP connection not validated in this guide | Project skill supported; MCP connection not validated in this guide | Project skill supported; MCP connection not validated in this guide | Project skill supported; MCP connection not validated in this guide |
| Claude Desktop remote connector on an individual account | Custom connector with a scoped bearer key if Request headers are available for the account; verify tools before claiming success | Cannot reach localhost from Anthropic's cloud | Default private installation is unreachable from Anthropic's cloud; no validated public route in this guide | Cannot reach localhost from Anthropic's cloud |
| Claude Desktop local MCP | Separate local extension required; not supported by this guide | Docker does not install a host extension | Separate local extension required; not supported by this guide | Docker does not install a host extension |
| ChatGPT MCP app or cloud execution | Separate cloud client configuration; not supported by this guide | Cannot reach localhost | Default private installation is unreachable | Cannot reach localhost |

For Cursor, the published CLI can install a project skill with
`metergraph skill install --client cursor --runtime local` when installed.
Confirm Cursor discovers the skill. This does not configure MCP or sign in.
Use the first trace guide for instrumentation, and report the read connection
as unverified until a supported Cursor MCP route is tested.

For hosted Claude Desktop on an individual account, guide the human through Customize → Connectors → Add custom connector with `https://app.metergraph.dev/v1/agent/mcp`. They create a coding-agent key in the intended hosted workspace. If Request headers are available, choose No sign-in and enter a required header named `Authorization` with value `Bearer <key>` in the connector's private settings, never in chat. Request headers are in beta and may be unavailable for the account; do not claim the route works without them. They must enable the connector in a conversation. Team and Enterprise connectors may share fixed credentials across users, so do not put one person's workspace key in a shared connector. Do not present OAuth server code, a tool listing, local CLI installation or a saved configuration as connection success. Do not invent a released plugin, extension, tunnel or signup path. If a route is blocked, name the blocker and offer the customer-machine Claude Code/Codex keyed HTTP route or hosted deployment as appropriate. Do not expose localhost publicly or disable authentication as a workaround.

For a fresh hosted workspace, first ask whether the human already has a Metergraph account and workspace. Direct them to https://app.metergraph.dev/ and the signup, invitation or sign-in flow actually offered. The hosted UI can offer "Get a free API key" for self-service signup, but do not assume that button or a workspace invitation is available to everyone. If access is unavailable, direct them to their workspace owner or Metergraph. Confirm the workspace before creating a coding-agent key.

For the commercial customer-local bundle, direct them to https://www.metergraph.dev/docs/self-host/local/#the-customer-local-bundle and the signed public release. They need a separate pull-only registry credential from Metergraph to pull the images; the public bundle download does not grant registry access. Verify the release before installation. Local admin credentials from the bundle's private configuration provide dashboard sign-in; create a coding-agent key in that installation's Keys page. Do not substitute hosted signup or a hosted key. Do not clone the private implementation or run development seed commands.

For customer-owned AWS, direct them to https://www.metergraph.dev/docs/self-host/aws/. An operator provisions the installation, identity and membership. There is no public signup. Ask for the installation's actual reachable address and use a coding-agent key from its Keys page. Its default internal load balancer is private, and its Agent Access surface excludes trace content and replay.

For the open-source self-hosted server, direct them to https://www.metergraph.dev/docs/self-host/local/#the-open-source-server. No Metergraph account, commercial release, registry credential or Keys page is needed. The operator configures static `MG_AGENT_TOKENS` separately from ingestion `MG_TOKENS`. Agent Access is content-blind and does not provide replay, incidents, ingestion health or pipeline reports. Use the actual local server address; do not ask them to mint a hosted coding-agent key.

## Keep credentials outside chat

Direct the human to the correct workspace's Keys page and private client configuration. Leave replay disabled unless separately authorized. Never ask for, quote, log or include raw keys in a prompt. Registry pull, ingestion, Agent Access and model/provider credentials are different credentials. Use the client's supported secure environment/settings input. Keep token-bearing configuration out of shell history and committed project files. Rotation/revocation happens in Keys; a revoked token must be rejected on the next request.

## Answer capability and documentation questions

Use https://www.metergraph.dev/docs/ for public product documentation and https://www.metergraph.dev/docs/guides/mcp-server/ for Agent Access tool details. Explain what the docs say about an edition, then use `metergraph_get_capabilities` to confirm what the connected workspace actually supports. Cite the public page you used and distinguish a missing capability from an empty workspace. Do not read retained content or run replay just to answer a documentation question.

## When already connected: bounded investigation

1. Call `metergraph_get_workspace_context` and `metergraph_get_capabilities` first. Verify the intended workspace, deployment profile, available tools, required scopes and privacy classes. Stop on wrong workspace, unavailable capabilities or failed authorization.
2. Confirm the question, route and explicit time window. Choose the smallest available tool: bounded usage/route metadata for aggregate questions, incidents for known anomalies, or `metergraph_query_traces` with a small limit (start with 1) for a failed/anomalous trace. Follow cursors only within the agreed bound. Never request generic SQL or unbounded data.
3. Start with metadata. Retained-content debugging and report evidence are separate content-bearing tools; confirm the user's content intent and capability before calling them. Replay is a separate scope and can send data to a provider and spend money. Obtain explicit bounded execution/data-egress authority before any replay. Read access grants no eval-write, analysis-run or production-mutation authority.
4. Explain the failure or anomaly using only returned evidence. Cite workspace, time window, provenance, trace/report IDs, completeness/coverage, warnings and working app links when returned. Do not fabricate links. Distinguish no data, incomplete evidence, unavailable capability, classification pending, stale/mismatched identity, failed analysis and missing report. An empty result alone does not prove absence of traffic.
5. An optional approved replay must be eligible, bounded and non-persistent. Do not claim that it changed production telemetry or fixed the application. Refuse autonomous dashboard mutations or production configuration changes.

For an empty workspace, use https://www.metergraph.dev/docs/agents/instrument-a-repo/ after confirming the ingestion destination and obtaining a separate ingest credential securely. Do not initiate provider calls or paid work merely to validate setup. Ingestion accepted, processed, retained content, classification readiness and analysis readiness are distinct states. Label synthetic/demo fixtures; they do not prove a first real application trace.
