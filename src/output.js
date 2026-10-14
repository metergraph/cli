import {
  CONNECTION_GUIDE_URL,
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  EXIT_CODE_MEANINGS,
  EXIT_CODES,
  HANDOFF_SKILL_CLIENTS,
  LOGIN_DEFAULT_TIMEOUT_MS,
  LOGIN_MAX_TIMEOUT_MS,
  LOGIN_MIN_TIMEOUT_MS,
  LOGIN_RUNTIMES,
  MAX_TIMEOUT_MS,
  METADATA_SCOPE,
  MIN_TIMEOUT_MS,
  PACKAGE_NAME,
  READ_DEFAULT_DAYS,
  READ_DEFAULT_LIMIT,
  READ_DEFAULT_TIMEOUT_MS,
  READ_MAX_DAYS,
  READ_MAX_LIMIT,
  READ_MAX_TIMEOUT_MS,
  READ_MIN_TIMEOUT_MS,
  SCHEMA_VERSION,
  TRACES_DEFAULT_LIMIT,
  SKILL_CLIENTS,
  SKILL_RUNTIMES,
  SUPPORTED_PROFILES,
  VERSION,
} from "./constants.js";
import { PLAIN, fields, headline, paragraph, render, section, steps, toneFor } from "./style.js";

// Every JSON result, success or failure, has the same top-level keys:
//   schema_version, command, ok, outcome, exit_code, data, error
// error is null when ok is true, otherwise { code, reason, message } where
// code equals outcome. All strings come from this package, never from input
// or from a server.
export function envelope({ command, outcome, data = null, reason = null, message = null }) {
  const ok = outcome === "ok";
  return {
    schema_version: SCHEMA_VERSION,
    command,
    ok,
    outcome,
    exit_code: EXIT_CODES[outcome],
    data,
    error: ok ? null : { code: outcome, reason, message },
  };
}

export function toJsonLine(result) {
  return `${JSON.stringify(result)}\n`;
}

const DOCTOR_OPTIONS = [
  {
    name: "--url",
    value: "ORIGIN",
    summary: `Origin to probe. Default ${DEFAULT_ORIGIN}.`,
  },
  {
    name: "--timeout-ms",
    value: "N",
    summary: `Total time allowed for the whole probe, ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}. Default ${DEFAULT_TIMEOUT_MS}.`,
  },
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

const SKILL_OPTIONS = [
  {
    name: "--client",
    value: "CLIENT",
    summary: "Required. codex (.agents/skills), claude (.claude/skills) or cursor (.cursor/skills).",
  },
  {
    name: "--runtime",
    value: "RUNTIME",
    summary: "local (default) or cloud: where the client runs. Recorded, not detected.",
  },
  { name: "--project", value: "DIR", summary: "Existing project directory. Default: the current directory." },
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

const SKILL_USAGE = [
  "metergraph skill install --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]",
  "metergraph skill update --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]",
];

const SKILLS_USAGE = [
  "metergraph skills install --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]",
  "metergraph skills update --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]",
  "metergraph skills list [--project DIR] [--json]",
];

const SKILLS_LIST_OPTIONS = [
  { name: "--project", value: "DIR", summary: "Existing project directory. Default: the current directory." },
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

const SKILLS_STATE_LABELS = {
  not_installed: "not installed",
  installed: "installed",
  outdated: "older revision; run skills update",
  modified: "changed since install; left alone",
  missing: "receipt only; run skills install",
  not_owned: "not installed by this CLI; left alone",
  receipt_invalid: "receipt not valid",
  unsafe_path: "unsafe path",
};

// How a coding agent gets an approval URL from login or setup. Many agent
// shells show output only after the command exits, which is too late.
const AGENT_APPROVAL_HELP = [
  "From a coding agent: with --json --no-browser, a step that needs approval exits at once",
  "with exit 18 action_required and the URL in data.next_action.url, while a background",
  "process keeps waiting for the approval until --timeout-ms. Show the URL to the person,",
  "and after they approve, run the same command again to continue.",
];

const CONFIG_DIR_OPTION = {
  name: "--config-dir",
  value: "DIR",
  summary:
    "Private per-user directory for the saved grant. Default: METERGRAPH_CONFIG_DIR, " +
    "else ~/.config/metergraph (POSIX) or AppData\\Roaming\\Metergraph (Windows).",
};

const LOGIN_OPTIONS = [
  {
    name: "--runtime",
    value: "RUNTIME",
    summary:
      "Required. Where this terminal runs, not which Metergraph service. local: your own machine, " +
      "including for the hosted service. cloud, cloud-no-shell: a cloud sandbox; get the connection guide.",
  },
  { name: "--url", value: "ORIGIN", summary: `Origin to sign in to. Default ${DEFAULT_ORIGIN}.` },
  {
    name: "--workspace",
    value: "UUID",
    summary: "Expected workspace ID. Sign in fails unless the browser grants exactly this workspace.",
  },
  { name: "--project", value: "DIR", summary: "Existing project directory to bind. Default: the current directory." },
  CONFIG_DIR_OPTION,
  {
    name: "--timeout-ms",
    value: "N",
    summary: `Time to wait for the browser, ${LOGIN_MIN_TIMEOUT_MS} to ${LOGIN_MAX_TIMEOUT_MS}. Default ${LOGIN_DEFAULT_TIMEOUT_MS}.`,
  },
  { name: "--signup", value: null, summary: "Start at the hosted sign up page. Managed service only." },
  { name: "--no-browser", value: null, summary: "Print the sign in URL on stderr instead of opening a browser. With --json, exit 18 with it in data.next_action (open_url)." },
  { name: "--reconnect", value: null, summary: "Allow switching a bound project to another origin or workspace." },
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

const LOGOUT_OPTIONS = [
  { name: "--project", value: "DIR", summary: "Existing project directory. Default: the current directory." },
  CONFIG_DIR_OPTION,
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

const LOGIN_USAGE =
  "metergraph login --runtime local [--url ORIGIN] [--workspace UUID] [--project DIR] [--config-dir DIR] " +
  "[--timeout-ms N] [--signup] [--no-browser] [--reconnect] [--json]";
const LOGOUT_USAGE = "metergraph logout [--project DIR] [--config-dir DIR] [--json]";
const SETUP_USAGE = "metergraph setup --runtime local (--client codex|claude|cursor | --skip-skill) " +
  "[--url ORIGIN] [--workspace UUID] [--project DIR] [--config-dir DIR] [--env-file .env] " +
  "[--deployment managed|customer-local|byoc|oss] [--confirm-prerequisites] [--agent-token-file FILE] " +
  "[--repository OWNER/NAME | --no-repository] " +
  "[--timeout-ms N] [--signup] [--reconnect] [--no-browser] [--repair] [--json]";
const JSON_OPTION = { name: "--json", value: null, summary: "Print one JSON line on stdout." };
const VERIFY_USAGE =
  "metergraph verify (--trace-id ID | --request-id ID) --since TIME --until TIME " +
  "[--source application|synthetic|demo|import|unspecified] [--days N] [--timeout-ms N] " +
  "[--poll-ms N] [--max-attempts N] [--open] [--no-browser] [--project DIR] [--config-dir DIR] [--json]";
const VERIFY_OPTIONS = [
  { name: "--trace-id", value: "ID", summary: "Exact trace ID from the application invocation." },
  { name: "--request-id", value: "ID", summary: "Exact request ID, used only when a trace ID is unavailable." },
  { name: "--since", value: "TIME", summary: "Start of the invocation in ISO 8601 form." },
  { name: "--until", value: "TIME", summary: "End of the invocation in ISO 8601 form." },
  { name: "--source", value: "SOURCE", summary: "Explicit provenance label. Default unspecified; this is a caller claim." },
  { name: "--days", value: "N", summary: "Metadata lookback, 1 to 90 days. Derived from --since by default." },
  { name: "--timeout-ms", value: "N", summary: "Total verification deadline, 100 to 60000. Default 30000." },
  { name: "--poll-ms", value: "N", summary: "Poll interval, 100 to 10000. Default 1000." },
  { name: "--max-attempts", value: "N", summary: "Maximum Metadata queries, 1 to 60. Default 30." },
  { name: "--open", value: null, summary: "Open only a verified server link bound to the signed in workspace." },
  { name: "--no-browser", value: null, summary: "Never launch a browser." },
  { name: "--project", value: "DIR", summary: "Signed in project directory. Default current directory." },
  CONFIG_DIR_OPTION,
  JSON_OPTION,
];

const READ_BASE_OPTIONS = [
  { name: "--project", value: "DIR", summary: "Signed in project directory. Default: the current directory." },
  CONFIG_DIR_OPTION,
  {
    name: "--timeout-ms",
    value: "N",
    summary:
      `Total time for every request of the command, ${READ_MIN_TIMEOUT_MS} to ${READ_MAX_TIMEOUT_MS}. ` +
      `Default ${READ_DEFAULT_TIMEOUT_MS}.`,
  },
];
const DAYS_OPTION = {
  name: "--days",
  value: "N",
  summary: `Window of the last N days, 1 to ${READ_MAX_DAYS}. Default ${READ_DEFAULT_DAYS}.`,
};
const METADATA_OPTIONS = [
  {
    name: "--metadata",
    value: "KEY=VALUE",
    summary:
      "Only calls whose metadata (SDK tags) has exactly this string value: case-sensitive, no prefix or " +
      "trimming. Repeat for up to 5 keys, all must match. A call without the key never matches; KEY= " +
      "matches only an empty value. Splits at the first =, so a value may contain =.",
  },
  {
    name: "--metadata-json",
    value: "JSON",
    summary:
      'The same filters as one JSON object, for keys that contain = (for example {"a=b":"v"}). Not with --metadata.',
  },
];
const limitOption = (fallback, extra = "") => ({
  name: "--limit",
  value: "N",
  summary: `Rows to return, 1 to ${READ_MAX_LIMIT}. Default ${fallback}.${extra}`,
});
const READ_BASE_USAGE = "[--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]";
const REFUSED_NOTE =
  "--environment, --workload, --since, --until, --sql, --query, --content, --include-content, --debug and --replay " +
  "are recognized and refused with exit code 6 before any request, except --environment, --since and --until on usage.";

// The read commands. Each uses the project's saved Metadata grant, makes GET
// requests to fixed paths on the bound origin and never opens a browser.
export const READ_HELP = Object.freeze([
  {
    name: "status",
    usage: `metergraph status ${READ_BASE_USAGE}`,
    summary:
      "Show whether this project is configured, the service is reachable and reports the bound deployment " +
      "profile, and the grant is verified for the bound workspace, with its Metadata capabilities. " +
      "Never claims application traffic is verified.",
    options: [...READ_BASE_OPTIONS, JSON_OPTION],
  },
  {
    name: "context",
    usage: `metergraph context ${READ_BASE_USAGE}`,
    summary: "Show the verified workspace: ID, slug, name, Metadata retention and access scope.",
    options: [...READ_BASE_OPTIONS, JSON_OPTION],
  },
  {
    name: "capabilities",
    usage: `metergraph capabilities ${READ_BASE_USAGE}`,
    summary: "Show which agent reads the service offers this grant, their privacy class and the service's bounds.",
    options: [...READ_BASE_OPTIONS, JSON_OPTION],
  },
  {
    name: "usage",
    usage:
      `metergraph usage [--days N | --today | --since TIME [--until TIME]] [--group-by DIMS] ` +
      `[--route NAME]... [--provider NAME]... [--model NAME]... [--environment NAME]... ` +
      `[--sort ORDER] [--compare previous|previous-same-time] [--limit N] ` +
      `[--metadata KEY=VALUE]... [--metadata-json JSON] [--group-by-metadata KEY] ${READ_BASE_USAGE}`,
    summary:
      "Show calls, errors, cost, tokens and latency. With --group-by, a filter, a UTC window, --sort or --compare " +
      "it reads grouped usage: cost by provider, model, route or UTC day, computed per call by the service, with " +
      "totals over every matching call and coverage, pricing and attribution evidence. Without them it lists cost " +
      "per route and day for the last N days. A route is not a prompt: one route can carry several prompt IDs, " +
      'so "metergraph usage --group-by metadata.prompt_id" splits cost by prompt. "metergraph routes" lists ' +
      "route definitions, not their cost.",
    examples: [
      ["Most expensive route today", "metergraph usage --group-by route --today"],
      ["Spend with one provider this week", "metergraph usage --group-by provider --provider NAME --days 7"],
      ["Spend by model", "metergraph usage --group-by model --days 7"],
      ["One route's daily trend", "metergraph usage --route NAME --group-by day --days 14"],
      ["Cost by prompt ID", "metergraph usage --group-by metadata.prompt_id --days 7"],
      ["Today against yesterday", "metergraph usage --group-by route --today --compare previous"],
    ],
    options: [
      ...READ_BASE_OPTIONS,
      {
        name: "--days",
        value: "N",
        summary:
          `Window, 1 to ${READ_MAX_DAYS}. Default ${READ_DEFAULT_DAYS}. Grouped: the current UTC day so far and the ` +
          "N - 1 whole UTC days before it (window.kind utc_days). Otherwise the last N x 24 hours, rolling and not " +
          "aligned to UTC days (window.kind rolling).",
      },
      { name: "--today", value: null, summary: "Grouped: the current UTC day so far (--days 1)." },
      {
        name: "--since",
        value: "TIME",
        summary:
          "Grouped: window start, inclusive. A UTC date (YYYY-MM-DD, 00:00 UTC) or an ISO 8601 timestamp with Z " +
          `or an offset. At most ${READ_MAX_DAYS} days before --until.`,
      },
      { name: "--until", value: "TIME", summary: "Grouped: window end, exclusive, in the same form. Default now." },
      {
        name: "--group-by",
        value: "DIMS",
        summary: "Comma-separated, in order: provider, model, route, day (UTC calendar day). Default provider,model.",
      },
      { name: "--route", value: "NAME", summary: "Grouped: only this route, exactly. Repeat for up to 20; (unrouted) selects calls without one." },
      { name: "--provider", value: "NAME", summary: "Grouped: only this provider, exactly. Repeat for up to 20." },
      { name: "--model", value: "NAME", summary: "Grouped: only this model, exactly. Repeat for up to 20." },
      { name: "--environment", value: "NAME", summary: "Grouped: only this environment. Repeat for several. A restricted grant reads its own environments only." },
      {
        name: "--sort",
        value: "ORDER",
        summary:
          "cost (default), cost-per-call, calls, errors, avg-latency (mean over calls that reported latency), " +
          "p95-latency (estimated from a fixed histogram) or day (oldest first; the default for --group-by day). " +
          "The service returns the highest-cost groups, so another order over a cut list is marked partial.",
      },
      {
        name: "--compare",
        value: "MODE",
        summary:
          "Also read the period before and show the change per group. previous: the whole prior period, which is " +
          "longer than a window ending part way through today (a warning says so). previous-same-time: the prior " +
          "period to the same elapsed time. Not with --group-by day.",
      },
      limitOption(READ_DEFAULT_LIMIT, " Grouped: the most groups listed; totals still cover every call."),
      ...METADATA_OPTIONS,
      {
        name: "--group-by-metadata",
        value: "KEY",
        summary:
          "Group by one metadata key: the same as ending --group-by with metadata.KEY, and the way to give a key " +
          "that holds a comma. Calls without the key or with a non-string value are one group with no value, and " +
          "the spend not attributed to any value is totalled.",
      },
      JSON_OPTION,
    ],
  },
  {
    name: "routes",
    usage: `metergraph routes [--limit N] ${READ_BASE_USAGE}`,
    summary:
      "List routes with call counts and evaluation contract versions. Descriptions, constraints and contract " +
      "bodies are not printed.",
    options: [
      ...READ_BASE_OPTIONS,
      limitOption(
        READ_DEFAULT_LIMIT,
        " The service has no route limit, so extra rows are cut locally and reported as truncated.",
      ),
      JSON_OPTION,
    ],
  },
  {
    name: "traces",
    usage:
      `metergraph traces [--days N] [--limit N] [--route NAME] [--status success|error] ` +
      `[--metadata KEY=VALUE]... [--metadata-json JSON] [--cursor CURSOR] ${READ_BASE_USAGE}`,
    summary:
      "List one page of trace metadata: status, span count, tokens, cost, routes, providers and models. " +
      "No prompts, responses or tool calls.",
    options: [
      ...READ_BASE_OPTIONS,
      DAYS_OPTION,
      limitOption(TRACES_DEFAULT_LIMIT),
      { name: "--route", value: "NAME", summary: "Only traces that include this route." },
      { name: "--status", value: "STATUS", summary: "Only success or error traces." },
      ...METADATA_OPTIONS,
      {
        name: "--cursor",
        value: "CURSOR",
        summary: "next_cursor from an earlier result, to read the next page. Pages are never fetched automatically.",
      },
      JSON_OPTION,
    ],
  },
]);

// One "  FLAG  summary" line per option. The flag column keeps its usual
// width but grows to fit the longest flag, so a flag never runs into its
// summary.
function optionLines(options, minimum) {
  const flags = options.map((option) => (option.value ? `${option.name} ${option.value}` : option.name));
  const width = Math.max(minimum, ...flags.map((flag) => flag.length + 2));
  return options.map((option, index) => `  ${flags[index].padEnd(width)}${option.summary}`);
}

export function helpData(topic) {
  return {
    topic,
    usage: [
      "metergraph --help [--json]",
      "metergraph --version [--json]",
      "metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]",
      ...SKILL_USAGE,
      ...SKILLS_USAGE,
      LOGIN_USAGE,
      LOGOUT_USAGE,
      SETUP_USAGE,
      VERIFY_USAGE,
      ...READ_HELP.map((entry) => entry.usage),
    ],
    commands: [
      {
        name: "doctor",
        summary:
          "Check that a Metergraph service is reachable, healthy and supported. Read only, sends no credentials.",
        options: DOCTOR_OPTIONS,
      },
      {
        name: "skill install",
        summary:
          "Copy the Metergraph skill bundled with this CLI into one client's project skill directory. " +
          "Never replaces a skill it did not install. No network requests, no sign in.",
        options: SKILL_OPTIONS,
      },
      {
        name: "skill update",
        summary:
          "Replace a skill this CLI installed, and that is unchanged since, with the bundled revision.",
        options: SKILL_OPTIONS,
      },
      {
        name: "skills install",
        summary:
          "Copy the Metergraph workflow skills bundled with this CLI, such as the model-swap loop, into one " +
          "client's project skill directory. Never replaces a skill it did not install. No network requests, no sign in.",
        options: SKILL_OPTIONS,
      },
      {
        name: "skills update",
        summary:
          "Replace workflow skills this CLI installed, and that are unchanged since, with the bundled revisions, " +
          "and install skills added since.",
        options: SKILL_OPTIONS,
      },
      {
        name: "skills list",
        summary: "List the bundled workflow skills and whether each is installed for each client. Writes nothing.",
        options: SKILLS_LIST_OPTIONS,
      },
      {
        name: "login",
        summary:
          "Sign in through the browser and bind this project to one verified workspace with a Metadata-only grant. " +
          "Does not create an application ingest key; no manual API key is required.",
        options: LOGIN_OPTIONS,
      },
      {
        name: "logout",
        summary:
          "Ask the service to revoke this project's grant, then remove the saved grant and the project binding.",
        options: LOGOUT_OPTIONS,
      },
      {
        name: "setup",
        summary: "Guide browser sign in and workspace choice, approve an ingest-only key, and install the selected client skill. Does not verify application traffic.",
        options: [
          { name: "--runtime", value: "RUNTIME", summary: "Required. local only; other runtimes get a handoff." },
          { name: "--url", value: "ORIGIN", summary: "Deployment origin. Defaults to an existing project binding, else the hosted origin." },
          { name: "--workspace", value: "UUID", summary: "Expected workspace; the browser must approve this exact workspace." },
          { name: "--project", value: "DIR", summary: "Project directory. Default: current directory." },
          CONFIG_DIR_OPTION,
          { name: "--env-file", value: "FILE", summary: "Project-relative env file. Default: .env." },
          { name: "--client", value: "CLIENT", summary: "Install the bundled skill for codex, claude or cursor." },
          { name: "--skip-skill", value: null, summary: "Explicitly leave client skill installation pending." },
          { name: "--timeout-ms", value: "N", summary: "Time to wait for browser approval." },
          { name: "--signup", value: null, summary: "Start at hosted sign up when the project needs login." },
          { name: "--reconnect", value: null, summary: "Permit switching an existing project binding." },
          { name: "--no-browser", value: null, summary: "Print approval URL on stderr. With --json, exit 18 with it in data.next_action (open_url); rerun after approval." },
          { name: "--repair", value: null, summary: "Explicitly approve replacement of an acknowledged key that no longer verifies." },
          { name: "--deployment", value: "MODEL", summary: "managed, customer-local, byoc or oss. Default managed." },
          { name: "--confirm-prerequisites", value: null, summary: "Attest deployment prerequisites are met; it does not verify bundle publication." },
          { name: "--agent-token-file", value: "FILE", summary: "Optional separate Metadata token for local/BYOC; required for OSS handoff." },
          { name: "--repository", value: "OWNER/NAME", summary: "Repository identity to record in .metergraph/config.json when none exists. Default: inferred from the git remote." },
          { name: "--no-repository", value: null, summary: "Leave the repository identity unrecorded." },
          JSON_OPTION,
        ],
      },
      {
        name: "verify",
        summary: "Poll Metadata for one exact trace in an explicit invocation window. Never sends application traffic.",
        options: VERIFY_OPTIONS,
      },
      ...READ_HELP.map(({ name, summary, options, examples }) => ({
        name,
        summary,
        options,
        ...(examples ? { examples: examples.map(([question, command]) => ({ question, command })) } : {}),
      })),
    ],
    skill_clients: Object.keys(SKILL_CLIENTS),
    skill_runtimes: [...SKILL_RUNTIMES],
    login_runtimes: [...LOGIN_RUNTIMES],
    supported_profiles: [...SUPPORTED_PROFILES],
    exit_codes: Object.entries(EXIT_CODES).map(([outcome, code]) => ({
      code,
      outcome,
      meaning: EXIT_CODE_MEANINGS[outcome],
    })),
  };
}

export function helpText(topic, style = PLAIN) {
  const lines = [];
  if (topic === "doctor") {
    lines.push(
      "Usage: metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]",
      "",
      "Makes unauthenticated, read-only GET requests to /healthz, /v1/deployment and",
      "/v1/agent/capabilities on one origin. Sends no credentials and follows no redirects.",
      "",
      "Options:",
    );
    lines.push(...optionLines(DOCTOR_OPTIONS, 18));
    lines.push(
      "",
      "ORIGIN must be a bare https origin such as https://metergraph.example.com.",
      "Plain http is accepted only for localhost, 127.0.0.1 and [::1].",
      "",
      "A healthy, supported service that requires sign in exits with code 3.",
      "Doctor never sends credentials, so it never reports a connected workspace.",
    );
  } else if (topic === "setup") {
    lines.push(`Usage: ${SETUP_USAGE}`, "", "Opens the service's browser sign in and workspace choice when needed.",
      "The browser approves an ingest-only key for the exact workspace. The CLI stores it in",
      "a private env file, confirms delivery, and installs the chosen client skill unless",
      "--skip-skill is explicit. Non-hosted setup requires an explicit origin, workspace and",
      "operator prerequisite attestation; OSS remains an operator handoff. No application",
      "traffic is claimed until an exact instrumented invocation is separately verified.",
      "", "Options:");
    lines.push(...optionLines(helpData(null).commands.find((entry) => entry.name === "setup").options, 25));
    lines.push("", ...AGENT_APPROVAL_HELP);
  } else if (topic === "login" || topic === "logout") {
    const login = topic === "login";
    lines.push(`Usage: ${login ? LOGIN_USAGE : LOGOUT_USAGE}`, "");
    if (login) {
      lines.push(
        "Opens your browser on the service's own sign in and workspace consent pages, then",
        "binds this project to the workspace you approve. The CLI receives a delegated grant",
        `limited to the Metadata scope (${METADATA_SCOPE}) and verifies the workspace, profile`,
        "and scope with the service before saving anything. Your browser keeps its own sign in.",
        "The grant is saved in your private config directory; the project gets only",
        ".metergraph/project.json, which holds no credentials.",
        "",
        "Login does not create an application ingest key, and no manual API key is required.",
        "The service records the grant as a Metadata-only OAuth connection, separate from any",
        "API or ingest key you manage. Login reads no telemetry or content and never asks for",
        "Debug or Replay access. Rerunning it on a signed in project changes nothing.",
        "",
      );
    } else {
      lines.push(
        "Asks the service to revoke this project's grant, removes the saved grant from your",
        "config directory and removes .metergraph/project.json. Other files are kept.",
        "If the service does not confirm revocation, local removal still happens and the",
        "command exits with code 13.",
        "",
      );
    }
    lines.push("Options:");
    lines.push(...optionLines(login ? LOGIN_OPTIONS : LOGOUT_OPTIONS, 18));
    if (login) lines.push("", ...AGENT_APPROVAL_HELP);
  } else if (topic === "verify") {
    lines.push(`Usage: ${VERIFY_USAGE}`, "", "Uses the saved Metadata grant to poll for one exact, processed trace.",
      "The source label is supplied by the caller. A Metadata match alone does not prove application traffic.",
      "Opening requires a server link that selects the verified workspace; older links get a manual handoff.",
      "", "Options:");
    lines.push(...optionLines(VERIFY_OPTIONS, 22));
  } else if (READ_HELP.some((entry) => entry.name === topic)) {
    const entry = READ_HELP.find((candidate) => candidate.name === topic);
    lines.push(
      `Usage: ${entry.usage}`,
      "",
      entry.summary,
      "",
      "Uses this project's saved Metadata grant (see \"metergraph help login\"). Sends GET requests only, to",
      "fixed paths on the bound origin, follows no redirects and reads bounded responses. Never opens a",
      "browser, signs in, writes project files, reads retained content, replays or calls a model provider.",
      "It may refresh its own saved grant, and the service may record the access (for example last used",
      "times); it never changes workspace configuration or telemetry and never sends ingest data.",
      REFUSED_NOTE,
      "",
      "Options:",
    );
    lines.push(...optionLines(entry.options, 18));
    if (entry.examples) {
      lines.push("", "Examples (add --json for one JSON line):");
      for (const [question, command] of entry.examples) lines.push(`  ${question}:`, `    ${command}`);
    }
  } else if (topic === "skill") {
    lines.push(
      "Usage:",
      ...SKILL_USAGE.map((usage) => `  ${usage}`),
      "",
      "Copies the Metergraph skill bundled with this CLI into one client's project skill",
      "directory and records ownership in .metergraph/skill-installations.json. Writes",
      "nothing else. Makes no network requests, does not sign in and does not configure",
      "MCP, client settings, AGENTS.md or CLAUDE.md.",
      "",
      "Options:",
    );
    lines.push(...optionLines(SKILL_OPTIONS, 18));
    lines.push(
      "",
      "install never replaces an existing skill. update replaces only a skill this CLI",
      "installed and that is unchanged since. There is no force option.",
      "",
      "Claude Desktop (--client claude-desktop), ChatGPT (--client chatgpt) and cloud",
      "runtimes without a shell (--runtime cloud-no-shell) cannot load project skill files.",
      "They exit with code 6, point to the connection guide and write nothing.",
      "",
      "Discovery stays pending until the client itself loads the skill.",
    );
  } else if (topic === "skills") {
    lines.push(
      "Usage:",
      ...SKILLS_USAGE.map((usage) => `  ${usage}`),
      "",
      "Copies the Metergraph workflow skills bundled with this CLI into one client's project",
      "skill directory, one folder per skill, and records ownership of each in",
      ".metergraph/skills/NAME.json. The skills come from https://github.com/metergraph/skills",
      "at the commit this release pins. They cover investigation and the model-swap loop:",
      "choose a workload, choose traces and models, define the eval, run the analysis,",
      "summarize the report and rerun. The setup skill is installed by \"metergraph skill\".",
      "",
      "Writes nothing else. Makes no network requests, does not sign in and does not",
      "configure MCP, client settings, AGENTS.md or CLAUDE.md.",
      "",
      "Options:",
    );
    lines.push(...optionLines(SKILL_OPTIONS, 18));
    lines.push(
      "",
      "install never replaces an existing skill. update replaces only skills this CLI",
      "installed and that are unchanged since, and installs skills added since. A conflict",
      "on one skill leaves the others in place. There is no force option.",
      "list takes only --project and reports every client. It never writes.",
      "",
      "Claude Desktop (--client claude-desktop) cannot load project skill files. It exits",
      "with code 6, writes nothing and points to the metergraph/skills plugin marketplace.",
      "ChatGPT and cloud runtimes without a shell get the connection guide instead.",
      "",
      "Discovery stays pending until the client itself loads the skills.",
    );
  } else {
    lines.push(
      `metergraph ${VERSION} (preview)`,
      "",
      "Usage:",
      "  metergraph --help [--json]       Show this help",
      "  metergraph --version [--json]    Show the CLI version",
      "  metergraph doctor [options]      Check a Metergraph service, read only",
      "  metergraph skill install|update  Install or update the agent skill in a project",
      "  metergraph skills install|update|list  Workflow skills, such as the model-swap loop",
      "  metergraph login [options]       Sign in and bind a project to a workspace",
      "  metergraph logout [options]      Revoke and remove a project's sign in",
      "  metergraph setup [options]       Approve and write a private ingest key",
      "  metergraph verify [options]      Find one exact processed trace",
      "  metergraph status [options]      Show configured, reachable and verified state",
      "  metergraph context [options]     Show the verified workspace",
      "  metergraph capabilities [opts]   Show the agent reads offered to this grant",
      "  metergraph usage [options]       Daily usage per route, Metadata only",
      "  metergraph routes [options]      Routes and evaluation contract versions",
      "  metergraph traces [options]      One page of trace metadata",
      "",
      'Run "metergraph help doctor" for doctor options.',
      'Run "metergraph help skill" for skill options.',
      'Run "metergraph help skills" for workflow skill options.',
      'Run "metergraph help login" or "metergraph help logout" for sign in options.',
      'Run "metergraph help verify" for exact-trace verification options.',
      'Run "metergraph help COMMAND" for status, context, capabilities, usage, routes or traces.',
    );
  }
  lines.push("", "Exit codes:");
  for (const [outcome, code] of Object.entries(EXIT_CODES)) {
    lines.push(`  ${String(code).padEnd(3)}${outcome.padEnd(25)}${style.dim(EXIT_CODE_MEANINGS[outcome])}`);
  }
  // Section labels ("Usage:", "Options:", "Exit codes:") in bold.
  return `${lines.map((line) => line.replace(/^(Usage|Options|Exit codes):/, (label) => style.bold(label))).join("\n")}\n`;
}

export function skillText(result, message, style = PLAIN) {
  const report = result.data;
  const label = SKILL_CLIENTS[report.client]?.label ?? HANDOFF_SKILL_CLIENTS[report.client];
  const verb = result.command === "skill update" ? "updated" : "installed";
  const lines = [
    result.ok
      ? headline(style, "ok", `Metergraph skill ${report.status === "unchanged" ? "already up to date" : verb} for ${label}`)
      : headline(style, toneFor(result.outcome), `Metergraph skill not ${verb} for ${label}`, result.outcome),
    "",
  ];
  const rows = [["Runtime", report.runtime], ["Path", report.path]];
  if (result.ok) {
    rows.push(
      ["Status", report.status],
      ["Source", `${report.source.revision} ${style.dim(`(sha256 ${report.source.sha256})`)}`],
      ["Discovery", `pending until ${label} loads the skill`],
      ["Authenticated", "no"],
    );
  }
  lines.push(...fields(style, rows), "");
  if (message) lines.push(...paragraph(style, message), "");
  lines.push(...steps(style, [
    ["", result.ok ? report.next_action.message : null],
    ["Connection guide", !result.ok && report.next_action?.kind === "connection_guide" ? report.next_action.url : null],
  ]));
  return render(lines);
}

export function skillsText(result, message, style = PLAIN) {
  const report = result.data;
  const lines = [];
  const source = report.source
    ? ["Source", `${report.source.repository} ${style.dim(`at ${report.source.commit.slice(0, 12)}`)}`]
    : ["Source", null];
  if (result.command === "skills list") {
    lines.push(
      result.ok
        ? headline(style, "info", "Metergraph skills bundled with this CLI")
        : headline(style, toneFor(result.outcome), "Could not list Metergraph skills", result.outcome),
      "",
      ...fields(style, [source]),
    );
    if (!result.ok) return render([...lines, "", ...paragraph(style, message)]);
    for (const skill of report.skills) {
      lines.push("", `${section(style, skill.name)} ${style.dim(skill.revision)}`);
      lines.push(...fields(style, Object.entries(skill.installs).map(([client, state]) =>
        [SKILL_CLIENTS[client].label, state === "installed" ? style.green(SKILLS_STATE_LABELS[state]) : (SKILLS_STATE_LABELS[state] ?? state)])));
    }
    return render(lines);
  }
  const label = SKILL_CLIENTS[report.client]?.label ?? HANDOFF_SKILL_CLIENTS[report.client] ?? report.client;
  const verb = result.command === "skills update" ? "updated" : "installed";
  lines.push(
    result.ok
      ? headline(style, "ok", `Metergraph skills ${verb} for ${label}`)
      : headline(style, toneFor(result.outcome), `Metergraph skills not ${verb} for ${label}`, result.outcome),
    "",
    ...fields(style, [["Runtime", report.runtime], source]),
  );
  if (report.skills.length > 0) {
    lines.push("", ...fields(style, report.skills.map((skill) => {
      const status = skill.status === "failed" ? style.red(`failed (${skill.reason})`) : skill.status;
      return [skill.name, `${status}  ${style.dim(skill.path ?? "")}`];
    })));
  }
  if (result.ok) {
    lines.push("", ...fields(style, [["Discovery", `pending until ${label} loads the skills`], ["Authenticated", "no"]]),
      "", ...steps(style, [["", report.next_action.message]]));
  } else {
    lines.push("", ...paragraph(style, message), "", ...steps(style, [
      ["", report.next_action?.kind === "plugin_marketplace" ? report.next_action.message : null],
      ["Connection guide", report.next_action?.kind === "connection_guide" ? report.next_action.url : null],
    ]));
  }
  return render(lines);
}

export function versionData() {
  return { name: PACKAGE_NAME, version: VERSION };
}

const CHECK_LABELS = {
  health: "Health",
  deployment: "Deployment profile",
  capabilities: "Agent capabilities",
};

const REASON_TEXT = {
  timeout: "the probe did not finish within the time limit",
  dns_lookup_failed: "the host name could not be resolved",
  connection_refused: "the connection was refused",
  connection_reset: "the connection was closed unexpectedly",
  host_unreachable: "the host could not be reached",
  invalid_http_response: "the server did not send a valid HTTP response",
  tls_error: "the TLS connection could not be verified",
  network_error: "a network error occurred",
  redirect: "the server answered with a redirect, which is never followed",
  service_unavailable: "the service reported that it is unavailable",
  server_error: "the service answered with a server error",
  reported_unhealthy: "the service reported that it is not healthy",
  unexpected_status: "the service answered with an unexpected status",
  response_too_large: "the response was larger than the allowed limit",
  invalid_response: "the response was not the expected JSON",
  deployment_endpoint_missing:
    "the service does not report a deployment profile; this preview supports only services that do",
  unrecognized_profile: "the service reported a deployment profile this CLI does not support",
  unexpected_auth_challenge: "the service did not ask for a bearer token",
  unexpected_unauthenticated_access: "the service answered without asking for authentication",
  bearer_token_required: "authentication required",
  probe_incomplete: "the probe did not complete",
};

export function doctorMessage(outcome, reason) {
  if (outcome === "authentication_required") {
    return "The service is reachable and supported, and it requires authentication. No workspace is connected.";
  }
  const detail = REASON_TEXT[reason] ?? "the probe failed";
  return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
}

const CHECK_MARKS = { pass: ["✓", "green"], fail: ["✗", "red"], skipped: ["-", "dim"] };

export function doctorText(result, style = PLAIN) {
  const report = result.data;
  const title = result.outcome === "authentication_required"
    ? "Service is reachable and requires sign in"
    : result.ok ? "Service is healthy" : "Service check failed";
  const lines = [
    headline(style, toneFor(result.outcome), title, result.outcome),
    "",
    ...fields(style, [["Origin", report.origin]]),
    `  ${style.dim("Read only, no credentials sent")}`,
    "",
  ];
  const width = Math.max(...report.checks.map((check) => CHECK_LABELS[check.name].length));
  for (const check of report.checks) {
    const [mark, color] = CHECK_MARKS[check.result] ?? ["?", "dim"];
    let line = `  ${style[color](mark)} ${CHECK_LABELS[check.name].padEnd(width)}  ${style.dim(check.path)}`;
    if (check.name === "deployment" && report.deployment_profile !== null) {
      line += `  ${report.deployment_profile}`;
    } else if (check.reason !== null) {
      line += `  ${REASON_TEXT[check.reason] ?? check.reason}`;
    }
    lines.push(line);
  }
  if (result.error !== null) lines.push("", ...paragraph(style, result.error.message));
  if (result.outcome === "authentication_required") {
    lines.push("", ...steps(style, [
      ["Sign in from this machine", "metergraph login --runtime local"],
      ["Connect an application", CONNECTION_GUIDE_URL],
    ]));
  }
  return render(lines);
}

// Fixed text for every login, logout and session reason. Reasons shared
// with doctor fall back to its wording.
const AUTH_MESSAGES = {
  runtime_not_supported:
    "--runtime says where this terminal runs, not which Metergraph service you sign in to. " +
    "A cloud runtime is a remote sandbox, and sign in needs a browser on the same machine as the CLI, " +
    "so it cannot finish there. Nothing was written.",
  ssh_session:
    "This is a remote shell session. A browser on your own machine cannot reach this machine's loopback " +
    "address, so sign in cannot finish here. Run login where your browser runs. Nothing was written.",
  cloud_workspace:
    "This is a cloud development environment. Its loopback address is not reachable from your browser, " +
    "so sign in cannot finish here. Follow the connection guide instead. Nothing was written.",
  ci_environment:
    "This is a CI environment, where no person can approve sign in in a browser. Nothing was written.",
  browser_approval_required:
    "A person must approve in a browser. Open data.next_action.url on this machine; a background process " +
    "waits for the approval until the timeout. After approval, run the same command again to continue.",
  bound_to_other_origin:
    "This project is bound to a different origin. Nothing was changed. Use --reconnect to switch it.",
  bound_to_other_workspace:
    "This project is bound to a different workspace. Nothing was changed and no new grant was kept. " +
    "Use --reconnect to switch it.",
  signup_unsupported:
    "Sign up is available only on the hosted managed service. For other deployments, ask the person " +
    "who runs it for an invitation, then run login without --signup.",
  access_denied: "Authorization was declined in the browser. Nothing was saved.",
  authorization_error: "The service reported an authorization error. Nothing was saved.",
  callback_invalid: "The browser returned an invalid authorization response. Nothing was saved.",
  callback_issuer_mismatch: "The browser returned a response from a different issuer. Nothing was saved.",
  timeout: "The operation did not finish within the time limit. Nothing was saved.",
  cancelled: "Sign in was cancelled. Nothing was saved.",
  browser_unavailable:
    "The browser could not be opened. Run login again with --no-browser and open the URL it prints.",
  oauth_metadata_missing: "This service does not support CLI sign in yet. Nothing was written.",
  metadata_scope_unsupported:
    "This service does not offer Metadata-only access for the CLI yet. The CLI does not fall back to broader access.",
  endpoint_not_allowed: "The service advertised an authorization endpoint outside its own origin or known paths.",
  resource_mismatch: "The service's protected resource does not match this origin.",
  issuer_mismatch: "The service's authorization issuer does not match this origin.",
  pkce_unsupported: "The service does not support PKCE with S256.",
  public_client_unsupported: "The service does not support public clients.",
  revocation_unsupported: "The service does not advertise grant revocation for public clients.",
  oauth_metadata_invalid: "The service's authorization metadata is not usable.",
  registration_rejected: "The service refused to register the CLI as a client.",
  registration_invalid: "The service's client registration did not match what the CLI requested.",
  code_rejected: "The service refused the authorization code. Nothing was saved.",
  token_response_invalid: "The service's token response is not usable. Nothing was saved.",
  token_type_invalid: "The service did not issue a bearer grant. Nothing was saved.",
  token_claims_invalid: "The issued grant does not name a valid workspace and expiry. Nothing was saved.",
  client_mismatch: "The issued grant is for a different client. Nothing was saved.",
  scope_mismatch: "The issued grant is not limited to exactly the Metadata scope. It was not kept.",
  workspace_mismatch: "The browser granted a different workspace than --workspace. It was not kept.",
  workspace_context_mismatch: "The service reported a different workspace than the grant names. It was not kept.",
  profile_mismatch: "The service reported a different deployment profile than before sign in. It was not kept.",
  deployment_profile_mismatch:
    "The service or saved binding has a different deployment profile from the selected setup route. Nothing was changed.",
  workspace_response_invalid: "The service's workspace response is not usable. Nothing was saved.",
  capabilities_response_invalid: "The service's capabilities response is not usable. Nothing was saved.",
  content_access_granted:
    "The grant would allow content, replay or provider access, which login never accepts. It was not kept.",
  access_rejected: "The service refused the new grant. Nothing was saved.",
  invalid_project: "--project must name an existing directory.",
  invalid_config_dir: "METERGRAPH_CONFIG_DIR must be an absolute path.",
  unsafe_path: "A path in .metergraph is a symbolic link or is not a regular file or directory. Nothing was changed.",
  binding_invalid: "The project binding .metergraph/project.json is not valid. Nothing was changed.",
  binding_locked:
    "Another login or logout may be running. If none is, delete .metergraph/project.lock and retry.",
  binding_changed: "The project binding changed while login was running. Nothing was changed.",
  binding_write_failed:
    "The project binding could not be written. The new grant was removed and the service was asked to revoke it.",
  binding_partial_write:
    "The project binding could not be written and the new grant could not be removed from the config directory. " +
    "The service was asked to revoke it. Run logout or login again.",
  binding_remove_failed:
    "The saved grant was handled as reported, but .metergraph/project.json could not be removed. " +
    "Run logout again to remove it.",
  read_failed: "The project files could not be read. Nothing was changed.",
  credential_store_unavailable: "The private config directory could not be used. Nothing was saved.",
  credential_path_unsafe:
    "A path in the private config directory is a symbolic link or is not a regular file or directory. Nothing was changed.",
  credential_path_not_owned: "The private config directory is owned by another user. Nothing was changed.",
  credential_permissions_unsafe:
    "The private config directory or its parent can be read or changed by other users. " +
    "Restrict it to your user (for example chmod 700), then retry. Nothing was changed.",
  credential_write_failed: "The grant could not be saved. Nothing was bound.",
  credential_protection_failed: "The grant could not be protected for the current Windows user. Nothing was bound.",
  credential_locked:
    "Another command is using this project's saved grant. If none is running, delete its .lock file in the config directory.",
  credential_unreadable: "The saved grant cannot be read. Run login again.",
  not_signed_in: "This project is not signed in. Run login.",
  credential_missing: "The saved grant for this project is missing. Run login again.",
  credential_context_mismatch: "The saved grant does not match this project's binding. Run login again.",
  reconnect_required:
    "An earlier refresh did not finish, so the saved grant may no longer be valid. Run login again.",
  refresh_interrupted:
    "Refreshing the grant did not finish cleanly. It is not retried with a possibly used token. Run login again.",
  refresh_not_saved: "The refreshed grant could not be saved. Run login again.",
  grant_rejected: "The service no longer accepts this grant. Run login again.",
  access_revoked: "The service refused the saved grant: it was revoked or access to the workspace was lost. Run login again.",
  revocation_unconfirmed:
    "Local sign in was removed, but the service did not confirm that the grant was revoked.",
};

export function authMessage(outcome, reason) {
  return AUTH_MESSAGES[reason] ?? doctorMessage(outcome, reason);
}

// Short headlines for the reasons people meet most. Others use a generic one.
const AUTH_TITLES = {
  runtime_not_supported: "Sign in cannot run from a cloud runtime",
  ssh_session: "Sign in cannot run over SSH",
  cloud_workspace: "Sign in cannot run in a cloud development environment",
  ci_environment: "Sign in cannot run in CI",
  browser_approval_required: "Waiting for approval in the browser",
  access_denied: "Sign in was declined in the browser",
  timeout: "Sign in timed out",
  cancelled: "Sign in was cancelled",
  bound_to_other_origin: "This project is bound to a different origin",
  bound_to_other_workspace: "This project is bound to a different workspace",
  not_signed_in: "This project is not signed in",
  revocation_unconfirmed: "Signed out locally; revocation not confirmed",
};

export function authText(result, message, style = PLAIN) {
  const report = result.data;
  const login = result.command === "login";
  const reason = result.error?.reason ?? null;
  let title;
  if (result.ok && login) {
    title = { signed_in: "Signed in", reused: "Already signed in", reconnected: "Reconnected" }[report.status];
  } else if (result.ok) {
    title = report.binding === "none" ? "This project was not signed in" : "Signed out";
  } else {
    title = AUTH_TITLES[reason] ?? (login ? "Sign in did not complete" : "Sign out did not complete");
  }
  const lines = [headline(style, toneFor(result.outcome), title, result.outcome), ""];
  const rows = [
    ["Origin", report.origin],
    ["Workspace", report.workspace?.id ?? null],
    ["Profile", report.deployment_profile || null],
  ];
  if (login && result.ok) {
    rows.push(
      ["Scopes", report.scopes.join(" ")],
      ["Binding", report.binding],
      ["Grant storage", report.credential_protection === "dpapi" ? "Windows DPAPI, current user" : "owner-only file"],
    );
  } else if (!login) {
    rows.push(
      ["Saved grant", report.local_credentials],
      ["Binding", report.binding],
      ["Server revocation", report.revocation.replace("_", " ")],
    );
  }
  lines.push(...fields(style, rows), "");
  if (login && result.ok && report.previous_grant_revocation === "unconfirmed") {
    lines.push(...paragraph(style, "The previous grant was removed locally; the service did not confirm its revocation."), "");
  }
  if (!result.ok) lines.push(...paragraph(style, message), "");
  const next = report.next_action;
  const guide = next?.url ?? null;
  if (reason === "runtime_not_supported") {
    lines.push(...steps(style, [
      ["Signing in from this machine?", style.bold("metergraph login --runtime local")],
      ["Connecting a cloud agent?", guide],
    ]));
  } else {
    lines.push(...steps(style, [["", next?.message ?? null], ["Connection guide", guide]]));
  }
  return render(lines);
}
