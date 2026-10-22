// Human action help; command execution and JSON envelopes remain independent.
const option = (name, value, summary) => ({ name, value, summary });
const selectors = [
  option("--model", "ID", "Model ID."),
  option("--provider", "ID", "Provider; use instead of --channel."),
  option("--channel", "ID", "Billing channel; use instead of --provider."),
  option("--region", "ID", "Billing region."),
];
const pricingCommon = [
  option("--url", "ORIGIN", "Service origin. Default: https://app.metergraph.dev."),
  option("--timeout-ms", "N", "Request deadline, 100–30000 ms. Default: 10000."),
  option("--api", "API", "public (default) or reference. Reference requires a loopback origin."),
  option("--json", null, "Print JSON."),
];
const tokens = ["input", "output", "cache-read", "cache-write", "cache-write-5m", "cache-write-1h"].map(
  name => option(`--${name}-tokens`, "N", name.startsWith("cache-write")
    ? "Anthropic cache-write tokens."
    : "Token count. Omitted counts stay unknown."));
const pricing = {
  models: ["Discover available models", "[--provider ID | --channel ID] [--limit N]", "metergraph pricing models --limit 10",
    [...selectors, option("--limit", "N", "Models to show. Default: 20; max: 100.")],
    "Current catalog. No account required."],
  lookup: ["Look up a model's prices", "--model ID [--provider ID | --channel ID]", "metergraph pricing lookup --model gpt-5 --provider openai",
    [...selectors, option("--at", "YYYY-MM-DD", "Price date (UTC). Default: now.")],
    "Public catalog prices. No account required."],
  calculate: ["Estimate cost from token counts", "--model ID [--input-tokens N] [--output-tokens N]", "metergraph pricing calculate --model gpt-5 --provider openai --input-tokens 1000 --output-tokens 200",
    [...selectors, ...tokens, option("--batch", null, "Use batch rates."),
      option("--at", "YYYY-MM-DD", "Price date (UTC). Default: now."),
      option("--trace-format", "FORMAT", "Token format: anthropic.messages, openai.responses, openai.chat_completions or otel.gen_ai.")],
    "Only supplied counts are sent. Partial costs are known subtotals. OpenAI cache reads cannot exceed total input. No model calls are made."],
  market: ["Compare current rates on one billing channel", "--channel ID [--region ID] [--limit N]", "metergraph pricing market --channel openai-api --limit 10",
    selectors.filter(o => ["--channel", "--region"].includes(o.name)).concat(option("--limit", "N", "Models to show. Default: 20; max: 100.")),
    "Current prices, without historical or quality rankings. No account required."],
  history: ["Inspect historical catalog prices", "--model ID --channel ID --api reference --url ORIGIN", "metergraph pricing history --model openai/gpt-5.6-terra --channel openai-api --api reference --url http://127.0.0.1:8765 --format chart",
    selectors.filter(o => o.name !== "--provider").concat([
      option("--api", "reference", "Required. History currently uses the local reference adapter."),
      option("--at", "YYYY-MM-DD", "Reference lookup date at UTC midnight."),
      option("--format", "FORMAT", "chart (default), table or html. Cannot combine with --json."),
    ]), "Requires a loopback reference service. Historical data is not available from the public API."],
};

export function actionHelpData(topic, action, commands) {
  if (topic === "pricing") {
    const canonical = action === "cost" ? "calculate" : action;
    const entry = pricing[canonical];
    if (!entry) return null;
    const [summary, usage, example, options, note] = entry;
    const focused = options.map(o => {
      if (o.name === "--model") return { ...o, summary: canonical === "models" ? "Filter by model ID." : "Required. Model ID." };
      if (o.name === "--channel" && ["market", "history"].includes(canonical)) return { ...o, summary: "Required. Billing channel." };
      if (o.name === "--region" && ["market", "history"].includes(canonical)) return { ...o, summary: "Billing region. Default: global." };
      return o;
    });
    return { summary, usage: `metergraph pricing ${action} ${usage} [options]`,
      options: [...focused, ...pricingCommon.filter(o => !options.some(specific => specific.name === o.name)
        && !(o.name === "--api" && ["models", "calculate"].includes(action)))], examples: [example.replace("pricing calculate", `pricing ${action}`)], note };
  }
  if (topic === "experiments") {
    const entry = commands.find(c => c.name === topic);
    const names = { list: ["--workload", "--limit"], get: ["--id"],
      estimate: ["--workload", "--treatment", "--last-n", "--sample-model", "--track"],
      start: ["--workload", "--treatment", "--last-n", "--sample-model", "--track"] }[action];
    if (!names) return null;
    const specific = ["--workload", "--limit", "--id", "--treatment", "--last-n", "--sample-model", "--track"];
    const options = entry.options.filter(o => !specific.includes(o.name) || names.includes(o.name)).map(o => {
      if (o.name === "--agent-token-file") return { ...o, summary: action === "start"
        ? "Private (0600) Debug key file with Allow analysis starts. Or set METERGRAPH_AGENT_TOKEN."
        : "Private (0600) Metadata key file. Or use saved sign in or METERGRAPH_AGENT_TOKEN." };
      const summaries = {
        "--workload": action === "list" ? "Filter by workload ID." : "Required. Workload ID.",
        "--id": "Required. Experiment ID.", "--limit": "Experiments to show. Default: 20; max: 50.",
        "--treatment": "Required. PROVIDER/MODEL; repeat for up to 3 treatments.",
        "--last-n": "Calls to replay. Default: 20; range: 10–40.",
        "--sample-model": "Filter production calls by model.", "--track": "JSON path to compare; repeat up to 10 times.",
      };
      return { ...o, summary: summaries[o.name] ?? o.summary };
    });
    const invocation = { list: "[--workload ID] [--limit N]", get: "--id UUID",
      estimate: "--workload ID --treatment PROVIDER/MODEL", start: "--workload ID --treatment PROVIDER/MODEL" }[action];
    return { summary: { list: "List recent experiments", get: "Read an experiment's results",
      estimate: "Estimate a model comparison before starting it", start: "Start a budgeted model comparison" }[action],
      usage: `metergraph experiments ${action} ${invocation} [options]`, options,
      examples: [`metergraph experiments ${action} ${{ list: "--limit 10", get: "--id UUID", estimate: "--workload ROUTE --treatment PROVIDER/MODEL", start: "--workload ROUTE --treatment PROVIDER/MODEL --agent-token-file /path/to/private-key" }[action]}`],
      note: action === "start"
        ? "Replays captured production prompts on the selected providers and incurs provider costs. Requires a Debug key with Allow analysis starts. Estimate first. Each start creates a new experiment; never retry a successful start."
        : { list: "Uses Metadata access. Returns experiment summaries.",
          get: "Uses Metadata access. Returns results without prompts or responses.",
          estimate: "Uses Metadata access. Estimates provider cost without starting a replay." }[action] };
  }
  const entry = commands.find(c => c.name === `${topic} ${action}`);
  if (!entry) return null;
  const label = topic === "skill" ? "setup skill" : "workflow skills";
  return { summary: action === "list" ? "List installed workflow skills"
      : `${action === "install" ? "Install" : "Update"} the Metergraph ${label}`,
    usage: `metergraph ${topic} ${action}${action === "list" ? "" : " --client codex|claude|cursor"} [options]`,
    options: entry.options, examples: [`metergraph ${topic} ${action}${action === "list" ? "" : " --client codex"}`],
    note: action === "list" ? "Lists installed workflow skills for all clients. Makes no changes."
      : (action === "install" ? "Existing skills are left alone. No network requests." : "Replaces only unchanged skills owned by this CLI. No network requests.") };
}

// Connection details remain available offline without dominating everyday help.
const ADVANCED_CONNECTION = new Set(["--url", "--config-dir", "--workspace", "--agent-token-file", "--timeout-ms", "--api"]);
const SHORT_OPTIONS = {
  "--project": "Project directory. Default: current directory.",
  "--config-dir": "Credential directory. Default: per-user config directory.",
  "--url": "Service origin. Default: project binding or hosted service.",
  "--workspace": "Require this workspace ID.",
  "--json": "Print JSON.",
  "--client": "Agent: codex, claude or cursor.",
  "--runtime": "local, cloud or cloud-no-shell. Inferred in a local terminal.",
  "--skip-skill": "Skip agent skill installation.",
  "--env-file": "Private env file. Default: .env.",
  "--no-browser": "Print the approval link instead of opening it.",
  "--signup": "Open sign up during browser approval.",
  "--reconnect": "Allow switching the connected workspace.",
  "--repair": "Approve replacement of a key that no longer verifies.",
  "--deployment": "managed (default), customer-local, byoc or oss.",
  "--confirm-prerequisites": "Confirm operator prerequisites are met.",
  "--repository": "Repository identity as OWNER/NAME.",
  "--no-repository": "Leave repository identity unset.",
};
export function displayOptions(options, topic, action, advanced = false) {
  return options.filter(o => advanced || !ADVANCED_CONNECTION.has(o.name)
    // History cannot run without these explicit connection selectors.
    || (topic === "pricing" && action === "history" && ["--api", "--url"].includes(o.name)))
    .map(o => ({ ...o, summary: advanced ? o.summary
      : o.name === "--runtime" && ["skill", "skills"].includes(topic) ? "local (default) or cloud."
      : o.name === "--url" && topic === "pricing" ? o.summary
      : SHORT_OPTIONS[o.name] ?? o.summary }));
}
