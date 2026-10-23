import { actionHelpData, displayOptions } from "./action-help.js";
import { PRICING_OPTIONS } from "./pricing-args.js";
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
import { PLAIN, fields, headline, paragraph, render, section, steps, toneFor, workspaceShown } from "./style.js";

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
  return `${jsonText(result)}\n`;
}

// JSON.stringify escapes C0 controls but leaves C1 controls (a terminal may
// read U+009B as an escape sequence) and bidirectional overrides as they are.
// Inside a JSON string \uXXXX means the same character, so escaping them
// changes nothing a parser sees and keeps them away from the terminal.
const TERMINAL_UNSAFE = /[\u061c\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function jsonText(value, indent = undefined) {
  return JSON.stringify(value, null, indent).replace(
    TERMINAL_UNSAFE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
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

// One recommended sequence per place an agent runs. login and setup detect
// SSH, cloud workspaces and CI and answer with a structured next_action.
const AGENT_PATH_HELP = [
  "Where the agent runs:",
  "  Local shell or local container   setup --runtime local --client C --json --no-browser,",
  "                                   rerun after each approval, then status --json",
  "  SSH, cloud workspace or CI       A person creates a coding-agent key with Metadata access",
  "                                   on the Keys page and saves it as the secret",
  "                                   METERGRAPH_AGENT_TOKEN; then status --json, usage --json",
  "  A key, no saved sign in          The same: reads use METERGRAPH_AGENT_TOKEN, or",
  "                                   --agent-token-file PATH, after verifying the workspace",
  "  Evaluations and analyses         A workspace owner creates a key with the Debug role and",
  "                                   Allow evaluation writes, Allow evaluation previews and",
  "                                   Allow analysis starts; the same METERGRAPH_AGENT_TOKEN",
  "                                   serves the reads. status --json reports the role and each",
  "                                   permission in data.access",
  "Never pass a key as an argument. Replay keys are refused.",
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
      "Required for scripts; inferred as local in an interactive local terminal. Where this terminal runs, not which Metergraph service. local: your own machine, " +
      "including for the hosted service. cloud, cloud-no-shell: a cloud sandbox; get the connection guide.",
  },
  { name: "--url", value: "ORIGIN", summary: `Origin to sign in to. Default ${DEFAULT_ORIGIN}.` },
  {
    name: "--workspace",
    value: "SLUG",
    summary:
      "The workspace to sign in to, by its slug (on its Settings page) or its name. A service that can, offers " +
      "approval for that workspace alone; sign in fails unless the browser grants it.",
  },
  {
    name: "--role",
    value: "ROLE",
    summary:
      "metadata (default): usage, cost and trace questions, no captured content. debug: also reads captured " +
      "prompts and responses through Agent Access; the --allow-* options add workflow permissions to it.",
  },
  {
    name: "--allow-evaluation-writes",
    value: null,
    summary: "With --role debug: Allow evaluation writes. Only a workspace owner approves the workflow permissions.",
  },
  { name: "--allow-evaluation-previews", value: null, summary: "With --role debug: Allow evaluation previews." },
  {
    name: "--allow-analysis-starts",
    value: null,
    summary: "With --role debug: Allow analysis starts, which replays captured prompts on model providers and spends money.",
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
  "metergraph login --runtime local [--url ORIGIN] [--workspace SLUG] [--role metadata|debug] " +
  "[--allow-evaluation-writes] [--allow-evaluation-previews] [--allow-analysis-starts] [--project DIR] " +
  "[--config-dir DIR] [--timeout-ms N] [--signup] [--no-browser] [--reconnect] [--json]";
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
  {
    name: "--url",
    value: "ORIGIN",
    summary:
      "Where a coding-agent key is sent when the project is not bound. Default METERGRAPH_URL, else the hosted service. " +
      "A bound project's origin cannot be changed here.",
  },
  {
    name: "--workspace",
    value: "SLUG",
    summary:
      "The workspace the credential must be for, by its slug or name (or ID). Without it, an unbound key's own " +
      "workspace is used.",
  },
  {
    name: "--agent-token-file",
    value: "PATH",
    summary:
      "Private (0600) file holding a coding-agent key with the Metadata or Debug role. Used instead of a saved sign in. " +
      "Without it, METERGRAPH_AGENT_TOKEN is used when this project has no saved sign in on this machine.",
  },
];
const EXPERIMENTS_USAGE = [
  "metergraph experiments list [--workload ID] [--limit N] [read options] [--json]",
  "metergraph experiments estimate --workload ID --treatment SPEC [--treatment SPEC]... [--last-n N] " +
    "[--sample-model MODEL] [--track PATH]... [read options] [--json]",
  "metergraph experiments start (same as estimate) [--agent-token-file PATH] [--json]",
  "metergraph experiments get --id UUID [read options] [--json]",
];
const EXPERIMENTS_OPTIONS = [
  { name: "--workload", value: "ID", summary: "The workload (route) whose recent production calls are replayed. Required for estimate and start; a filter for list." },
  {
    name: "--treatment",
    value: "SPEC",
    summary:
      "1 to 3 times. PROVIDER/MODEL, optionally followed by ,label=NAME ,temperature=0..2 ,max_tokens=1..32000 " +
      "or ,reasoning_effort=none|minimal|low|medium|high|xhigh|max. Unset settings follow production.",
  },
  { name: "--last-n", value: "N", summary: "Replay the last N replayable calls, 10 to 40. Default 20." },
  { name: "--sample-model", value: "MODEL", summary: "Only production calls made with this exact model, for a single-model control." },
  { name: "--track", value: "PATH", summary: "Up to 10 times. A JSON path such as $.priority whose values the dashboard compares." },
  { name: "--id", value: "UUID", summary: "The experiment to read (get)." },
  { name: "--limit", value: "N", summary: "Experiments to list, 1 to 50. Default 20." },
  ...READ_BASE_OPTIONS.filter((option) => option.name !== "--agent-token-file"),
  {
    name: "--agent-token-file",
    value: "PATH",
    summary:
      "Private (0600) file holding a coding-agent key. For list, estimate and get: a key with the Metadata or Debug role. " +
      "For start: a key with Debug access and Allow analysis starts, used for that one request.",
  },
  JSON_OPTION,
];
const TOOLS_USAGE = [
  "metergraph tools list [--name TOOL] [read options] [--json]",
  "metergraph tools call TOOL [--args JSON | --args-file PATH] [--yes] [read options] [--json]",
];
const TOOLS_OPTIONS = [
  { name: "--name", value: "TOOL", summary: "list only: show one tool, with its input schema under --json." },
  { name: "--args", value: "JSON", summary: "call only: the tool's arguments as one JSON object. Default {}." },
  { name: "--args-file", value: "PATH", summary: "call only: a file holding the arguments as one JSON object, up to 1 MiB." },
  {
    name: "--yes",
    value: null,
    summary:
      "call only: run a tool that writes, starts work or calls a model provider. Pass it only after the person " +
      "has approved this exact call.",
  },
  ...READ_BASE_OPTIONS,
  JSON_OPTION,
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
const READ_BASE_USAGE =
  "[--url ORIGIN] [--workspace SLUG] [--agent-token-file PATH] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]";
const REFUSED_NOTE =
  "--environment, --workload, --since, --until, --sql, --query, --content, --include-content, --debug and --replay " +
  "are recognized and refused with exit code 6 before any request, except --environment, --since and --until on usage.";

// The read commands. Each uses the project's saved Metadata grant or a
// coding-agent key with the Metadata or Debug role, makes GET requests to fixed
// paths on the verified origin and never opens a browser.
export const READ_HELP = Object.freeze([
  {
    name: "status",
    usage: `metergraph status ${READ_BASE_USAGE}`,
    summary:
      "Show whether this project is configured, the service is reachable and reports the bound deployment " +
      "profile, and the grant is verified for the bound workspace, with its Metadata capabilities. Reports " +
      "the credential's role (Metadata or Debug) and its workflow permissions (Allow evaluation writes, Allow " +
      "evaluation previews, Allow analysis starts) in data.access, and how to grant them. " +
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

export function helpData(topic, action = null) {
  const data = {
    topic,
    usage: [
      "metergraph --help [--json]",
      "metergraph --version [--json]",
      "metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]",
      "metergraph pricing models|lookup|calculate|cost|history|market [options] [--json]",
      ...SKILL_USAGE,
      ...SKILLS_USAGE,
      LOGIN_USAGE,
      LOGOUT_USAGE,
      SETUP_USAGE,
      VERIFY_USAGE,
      ...READ_HELP.map((entry) => entry.usage),
      ...EXPERIMENTS_USAGE,
      ...TOOLS_USAGE,
    ],
    commands: [
      { name: "pricing", summary: "Public model discovery, lookup and calculation. Current market board; historical charts in local reference mode.",
        options: [...PRICING_OPTIONS.map(name => ({ name, value: "VALUE", summary: "See metergraph help pricing and docs/pricing.md." })),
          { name: "--batch", value: null, summary: "Use batch pricing for cost." }, JSON_OPTION] },
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
          "Copy the Metergraph workflow skills bundled with this CLI, such as model swap, into one " +
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
          { name: "--runtime", value: "RUNTIME", summary: "Local terminal: inferred automatically. Scripts: required. Other runtimes get a handoff." },
          { name: "--url", value: "ORIGIN", summary: "Deployment origin. Defaults to an existing project binding, else the hosted origin." },
          { name: "--workspace", value: "UUID", summary: "Expected workspace; the browser must approve this exact workspace." },
          { name: "--project", value: "DIR", summary: "Project directory. Default: current directory." },
          CONFIG_DIR_OPTION,
          { name: "--env-file", value: "FILE", summary: "Project-relative env file. Default: .env." },
          { name: "--client", value: "CLIENT", summary: "codex, claude or cursor. A local interactive setup asks when omitted." },
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
      {
        name: "experiments",
        summary:
          "Estimate, start, list and read experiments: a workload's recent production calls replayed on 1 to 3 " +
          "treatments, with built-in statistics per arm next to production. list, estimate and get are Metadata " +
          "reads; start needs a key with Debug access and Allow analysis starts and spends within the server's budget.",
        options: EXPERIMENTS_OPTIONS,
      },
      {
        name: "tools",
        summary:
          "List the Agent Access tools this credential can use and call one, as an MCP client would. A tool that " +
          "writes, starts work or calls a model provider runs only with --yes.",
        options: TOOLS_OPTIONS,
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
  if (action) data.action = { name: action, ...actionHelpData(topic, action, data.commands) };
  return data;
}

export function helpText(topic, style = PLAIN, action = null, advanced = false) {
  const lines = [];
  if (action) {
    const entry = actionHelpData(topic, action, helpData(topic).commands);
    if (entry) return formatHelp([
      `Usage: ${entry.usage}`, "", entry.summary, "", "Examples:",
      ...entry.examples.map(example => `  ${example}`), "", "Options:",
      ...optionLines(displayOptions(entry.options, topic, action, advanced), 20), "", entry.note, "",
      ...(advanced ? [] : [`Connection settings: metergraph ${topic} ${action} --help --advanced`]),
    ], style);
  }
  if (topic === "exit-codes") {
    lines.push("Exit codes:", "", "For scripts. Human output describes the result and what to do next.", "");
    for (const [outcome, code] of Object.entries(EXIT_CODES)) {
      lines.push(`  ${String(code).padEnd(4)}${outcome}`, ...paragraph(style, EXIT_CODE_MEANINGS[outcome], "      "), "");
    }
    return formatHelp(lines, style);
  }
  if (topic === "agents") return formatHelp([
    "Connect a coding agent", "", ...AGENT_PATH_HELP, "", ...AGENT_APPROVAL_HELP,
    "", 'Use --json for structured results. Run "metergraph help exit-codes" for scripting outcomes.',
  ], style);
  if (topic === "pricing") {
    return formatHelp(`Usage: metergraph pricing models|lookup|calculate|cost|history|market [options] [--json]

Public catalog prices. No account, project or token is required.
models  [--model ID] [--provider ID | --channel ID] [--region ID] [--limit 1..100]
lookup  --model ID [--provider ID | --channel ID] [--region ID] [--at YYYY-MM-DD]
calculate (or cost) Same selectors; --input-tokens N --output-tokens N [--batch]
        --cache-read-tokens N; --trace-format anthropic.messages|openai.responses|
        openai.chat_completions|otel.gen_ai. Native format inferred for direct
        Anthropic/OpenAI; otherwise otel.gen_ai. Only supplied counts are sent.
        Anthropic also accepts --cache-write-tokens N or
        --cache-write-5m-tokens N / --cache-write-1h-tokens N.
market  --channel ID [--region ID] [--limit 1..100] (current rates, no history)
history --model ID --channel ID [--region ID] [--format table|chart|html]
        Requires --api reference --url LOOPBACK_ORIGIN; no public history API.

All actions: --url ORIGIN --timeout-ms 100..30000 --json --api public|reference
Default API: public; default origin: https://app.metergraph.dev.
--at selects UTC midnight; without it public lookup/calculation use server time.
Models and public market discovery are current-only. Filters on models run locally.
History/market region defaults to global. Omitted input/output counts stay unknown;
partial costs are known subtotals, not complete costs. OpenAI cache counts must
not exceed total input. --json cannot be combined with --format.

Examples:
  metergraph pricing models --limit 10
  metergraph pricing lookup --model gpt-5 --provider openai --region global --json
  metergraph pricing calculate --model claude-sonnet-5 --provider anthropic --input-tokens 1000 --cache-read-tokens 800 --output-tokens 200
  metergraph pricing market --channel openai-api --limit 5
  metergraph pricing history --model openai/gpt-5.6-terra --channel openai-api --api reference --url http://127.0.0.1:8765 --format html > history.html

Public API: GET /v1/pricing/models; POST /v1/pricing/lookup and /calculate.
No credentials, traces, prompts or responses are loaded from project files.
The CLI constructs metadata-only provider-format traces from the supplied counts.
See docs/pricing.md for the supported contract, limitations and reference previews.
`.split("\n"), style);
  }
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
      "", "At a terminal without --json, setup asks for any of these it needs that are",
      "missing, prints the full command, then runs it. Scripts and agents get no questions.",
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
        `limited to the Metadata role (${METADATA_SCOPE}), or with --role debug to the Debug role and`,
        "the workflow permissions the --allow-* options name, which only a workspace owner approves.",
        "It verifies the workspace, profile and scope with the service before saving anything. Your",
        "browser keeps its own sign in. Signing in again with another role or other permissions",
        "replaces the grant.",
        "The grant is saved in your private config directory; the project gets only",
        ".metergraph/project.json, which holds no credentials.",
        "",
        "Login does not create an application ingest key, and no manual API key is required.",
        "The service records the grant as an OAuth connection, separate from any API or ingest",
        "key you manage. Login reads no telemetry or content and never asks for Replay access.",
        "Rerunning it on a signed in project with the same role and permissions changes nothing.",
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
  } else if (topic === "tools") {
    lines.push(
      "Usage:",
      ...TOOLS_USAGE.map((usage) => `  ${usage}`),
      "",
      "Every Agent Access tool the service offers this credential, through its MCP endpoint, with the same",
      "saved sign in or coding-agent key as the read commands and the same checks first. The service decides",
      "which tools a credential sees: a Metadata credential gets the Metadata tools; the Debug role adds trace",
      "content and evaluation reads, and Allow evaluation writes, Allow evaluation previews and Allow analysis",
      "starts add the tools they name. Replay keys are refused.",
      "",
      "list prints the tools with whether each only reads. Under --json each carries its title, description",
      "and input schema. call sends one tools/call with --args or --args-file and prints the tool's structured",
      "result in data.result. A tool the service does not mark read-only, or marks as calling a model provider,",
      "needs --yes: without it the command exits 18 (action_required, confirmation_required) and sends",
      "nothing. Pass --yes only after the person has approved that exact call. A refusal by the tool exits 19",
      "(refused) with the service's error in data.tool_error; a write whose answer was lost exits 20",
      "(unconfirmed).",
      "",
      "Options:",
    );
    lines.push(...optionLines(TOOLS_OPTIONS, 22));
  } else if (topic === "experiments") {
    lines.push(
      "Usage:",
      ...EXPERIMENTS_USAGE.map((usage) => `  ${usage}`),
      "",
      "An experiment replays a workload's last 10 to 40 replayable production calls on 1 to 3 treatments",
      "(a provider, model and settings) and compares each with what production returned on the same calls:",
      "cost per call, p50 latency and output tokens, output length, JSON parse rate, same top-level keys,",
      "empty or refused and cut-off rates. The statistics show differences; they do not judge them.",
      "",
      "estimate prices it against the server's budget and daily cap and writes nothing. start takes the",
      "same arguments, so it starts exactly what was priced; poll it with get until it is terminal.",
      "Each start creates a new experiment, so a start that succeeded is never retried.",
      "",
      "list, estimate and get use this project's saved sign in or a coding-agent key, as the read",
      "commands do, and never read inputs, outputs or tracked field values; those are in the dashboard.",
      "start needs a coding-agent key with the Debug role and Allow analysis starts, which only a",
      "workspace owner can grant, in --agent-token-file or METERGRAPH_AGENT_TOKEN.",
      "The CLI checks the key before it sends the one start request. The service then replays the",
      "sampled calls' captured prompts on each treatment's provider within its budget.",
      "",
      "Options:",
    );
    lines.push(...optionLines(EXPERIMENTS_OPTIONS, 22));
  } else if (READ_HELP.some((entry) => entry.name === topic)) {
    const entry = READ_HELP.find((candidate) => candidate.name === topic);
    lines.push(
      `Usage: ${entry.usage}`,
      "",
      entry.summary,
      "",
      "Uses this project's saved Metadata grant (see \"metergraph help login\"), or, where there is none on",
      "this machine, a coding-agent key from METERGRAPH_AGENT_TOKEN or --agent-token-file, with the",
      "Metadata role or the Debug role. A key is sent only after the origin answers as a supported",
      "Metergraph service, and nothing is read until the service shows one of those roles (never",
      "Replay) and the expected workspace. Sends GET requests only, to fixed paths on that origin, follows no redirects and",
      "reads bounded responses. Never opens a browser, signs in, writes project files or the key, reads",
      "retained content, replays or calls a model provider. It may refresh its own saved grant, and the",
      "service may record the access (for example last used times); it never changes workspace",
      "configuration or telemetry and never sends ingest data.",
      REFUSED_NOTE,
      "",
      "Options:",
    );
    lines.push(...optionLines(entry.options, 25));
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
      "at the commit this release pins. They cover investigation and model swap:",
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
    return rootHelp(style);
  }
  // Reference material is opt-in; everyday help stays focused on this command.
  return commandHelp(topic, lines, style, advanced);
}

function commandHelp(topic, lines, style, advanced) {
  const optionsAt = lines.indexOf("Options:");
  if (optionsAt < 0) return formatHelp(lines, style);
  const optionsEnd = lines.indexOf("", optionsAt + 1);
  const usageEnd = lines.indexOf("");
  const examples = {
    setup: ["metergraph setup", "metergraph setup --runtime local --client codex --json --no-browser"],
    login: ["metergraph login", "metergraph login --runtime local --no-browser"],
    logout: ["metergraph logout"], doctor: ["metergraph doctor"],
    verify: ["metergraph verify --trace-id TRACE_ID --since START_ISO_TIME --until END_ISO_TIME"],
    status: ["metergraph status"], context: ["metergraph context"], capabilities: ["metergraph capabilities"],
    usage: ["metergraph usage --days 7"], routes: ["metergraph routes"], traces: ["metergraph traces --limit 10"],
    skill: ["metergraph skill install --client codex"], skills: ["metergraph skills list"],
    experiments: ["metergraph experiments list", "metergraph experiments estimate --help"],
  }[topic] ?? [];
  const notes = lines.slice(usageEnd + 1, optionsAt);
  const command = helpData(topic).commands.find(entry => entry.name === topic);
  const options = command ? ["Options:", ...optionLines(displayOptions(command.options, topic, null, advanced), 22)]
    : lines.slice(optionsAt, optionsEnd < 0 ? lines.length : optionsEnd);
  const synopsis = {
    setup: "metergraph setup [--client CLIENT | --skip-skill] [options]",
    login: "metergraph login [--runtime local] [options]",
    logout: "metergraph logout [options]",
    verify: "metergraph verify (--trace-id ID | --request-id ID) --since TIME --until TIME [options]",
    ...Object.fromEntries(READ_HELP.map(entry => [entry.name, `metergraph ${entry.name} [options]`])),
  }[topic];
  return formatHelp([
    ...(synopsis ? [`Usage: ${synopsis}`] : lines.slice(0, usageEnd)), "", "Examples:", ...examples.map(example => `  ${example}`),
    ...(topic === "setup" || topic === "login" ? ["", "Local terminals guide missing choices. Scripts require explicit flags.",
      "With --json --no-browser, a step that needs browser approval exits 18 (action_required) with the URL in " +
      "data.next_action.url; approve it, then run the same command again."] : []),
    "", ...options,
    ...(advanced ? ["", "Details", ...notes, ...lines.slice(optionsEnd < 0 ? lines.length : optionsEnd)]
      : ["", `Connection settings and details: metergraph ${topic} --help --advanced`]),
  ], style);
}

function rootHelp(style) {
  const groups = [
    ["Get started", [
      ["setup", "Connect your app and install an agent skill"],
      ["login", "Sign in to a workspace"],
      ["status", "Check this project's connection"],
    ]],
    ["Explore", [
      ["usage", "View costs and token usage"],
      ["traces", "Browse trace metadata"],
      ["routes", "List routes and evaluation contracts"],
      ["experiments", "Estimate and run model comparisons"],
      ["tools", "List and call the tools your coding agent can use"],
      ["pricing", "Look up public model prices; no account needed"],
    ]],
    ["Manage", [
      ["verify", "Verify one processed trace"],
      ["doctor", "Check service health"],
      ["context", "Show the connected workspace"],
      ["capabilities", "Show available workspace reads"],
      ["skill", "Install or update the setup skill"],
      ["skills", "Install, update or list workflow skills"],
      ["logout", "Sign out of this project"],
    ]],
  ];
  const lines = [style.bold("Metergraph") + " " + style.dim(`${VERSION} · preview`),
    "Understand your AI usage and compare models.", "", "Usage: metergraph <command> [options]", ""];
  for (const [title, commands] of groups) {
    lines.push(section(style, title), ...fields(style, commands), "");
  }
  lines.push(section(style, "Try it"),
    "  metergraph setup --runtime local --client codex",
    "  metergraph pricing models --limit 10", "",
    'Run "metergraph <command> --help" for options and examples.',
    'Use --json for scripts; --version to show the version.',
    'Scripting reference: metergraph help exit-codes.',
    'Connecting a cloud agent? Run "metergraph help agents".');
  return formatHelp(lines, style);
}

function formatHelp(lines, style) {
  return render(lines.flatMap((line) => {
    if (!line) return [""];
    if (line.length <= style.width && !/^(Usage|Options|Examples|Exit codes):/.test(line)) return [line];
    if (/^(Usage|Options|Examples|Exit codes):/.test(line)) {
      const [first, ...rest] = paragraph(style, line, "");
      return [style.bold(first), ...rest];
    }
    // Preserve option and command columns, with a hanging indent on small terminals.
    const row = /^(  \S.*?) {2,}(\S.*)$/.exec(line);
    if (row && Number.isFinite(style.width)) {
      const prefix = row[1] + "  ";
      if (prefix.length > style.width / 2) {
        return [row[1], ...paragraph(style, row[2], "    ")];
      }
      const wrapped = paragraph(style, row[2], " ".repeat(prefix.length));
      return [prefix + wrapped[0].trimStart(), ...wrapped.slice(1)];
    }
    return paragraph(style, line.trimStart(), line.match(/^ */)[0]);
  }));

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
  local_docker_transport_required:
    "Local credentials and consent require a verified Docker transport. This CLI has no configured Docker transport; nothing was sent. Update the local bundle and use its Docker-mediated bin/agent-key command, or connect this CLI to an authenticated HTTPS deployment.",
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
  debug_scope_unsupported: "This service does not offer Debug access for CLI sign in. Nothing was saved.",
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
  workspace_hint_ambiguous:
    "More than one of your workspaces has the name --workspace gave, so the consent page offered no approval. " +
    "Nothing was granted.",
  workspace_hint_unknown:
    "None of your workspaces has the slug or name --workspace gave, so the consent page offered no approval. " +
    "Nothing was granted.",
  workspace_name_unsupported:
    "This service cannot match a workspace by name. Use its slug, which its Settings page shows. Nothing was sent.",
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
  secure_writes_unavailable:
    "Secure automatic file writes are unavailable on this platform or the bundled filesystem helper failed verification. Nothing was written.",
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
    ["Workspace", workspaceShown(report.workspace)],
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
  // A remote handoff names the Keys page where a person creates the
  // Metadata key the agent then reads from METERGRAPH_AGENT_TOKEN.
  const keys = next?.kind === "use_agent_key"
    ? next.person_steps.find((step) => step.action === "create_metadata_key")?.url ?? null
    : null;
  if (reason === "runtime_not_supported") {
    lines.push(...steps(style, [
      ["Signing in from this machine?", style.bold("metergraph login --runtime local")],
      ["Connecting a cloud agent?", guide],
      ["Metadata key for the agent", keys],
    ]));
  } else {
    lines.push(...steps(style, [["", next?.message ?? null], ["Keys page", keys], ["Connection guide", guide]]));
  }
  return render(lines);
}
