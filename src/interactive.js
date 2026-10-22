import { createInterface } from "node:readline";
import { parseArgs } from "./args.js";
import { classifyEnvironment } from "./environment.js";

// Only fill missing choices in a person's local terminal. Validate the entire
// resulting command before prompting; a typo must never start browser approval.
export async function interactiveArgs(argv, { stdin, stdout, stderr, env = process.env, choose = chooseClient }) {
  if (!stdin?.isTTY || !stdout?.isTTY || !stderr?.isTTY || argv.includes("--json") || classifyEnvironment(env).remote) return argv;
  const initial = parseArgs(argv);
  if (initial.ok || !["setup", "login"].includes(initial.command)) return argv;
  const missingRuntime = initial.code === "missing_runtime";
  const candidate = missingRuntime ? [...argv, "--runtime", "local"] : [...argv];
  let parsed = parseArgs(candidate);
  const missingClient = parsed.command === "setup" && parsed.code === "client_required";
  if (missingClient) parsed = parseArgs([...candidate, "--client", "codex"]);
  if (!parsed.ok || parsed.runtime !== "local") return argv;
  if (missingRuntime) stderr.write("Using this machine for browser sign in.\n");
  if (!missingClient) return candidate;
  stderr.write("\nConnect this project to Metergraph\nBrowser approval will connect your workspace and create an ingest key in a private env file.\n\n");
  const client = await choose({ stdin, stderr });
  if (client === null) return null;
  return [...candidate, ...(client === "skip" ? ["--skip-skill"] : ["--client", client])];
}

export async function chooseClient({ stdin, stderr }) {
  const rl = createInterface({ input: stdin, output: stderr, terminal: true });
  const answers = rl[Symbol.asyncIterator]();
  rl.on("SIGINT", () => rl.close());
  try {
    stderr.write("Install the setup skill for:\n  1  Codex\n  2  Claude Code\n  3  Cursor\n  4  Skip skill installation\n\n");
    while (true) {
      rl.setPrompt("Choose 1–4 (Ctrl+C to cancel): ");
      rl.prompt();
      const answer = await answers.next();
      if (answer.done) return null;
      const choice = answer.value.trim().toLowerCase();
      const clients = { "1": "codex", "2": "claude", "3": "cursor", "4": "skip", codex: "codex", claude: "claude", cursor: "cursor", skip: "skip" };
      if (Object.hasOwn(clients, choice)) return clients[choice];
      stderr.write("Choose Codex, Claude Code, Cursor, or skip (1–4).\n");
    }
  } finally {
    rl.close();
    await answers.return?.();
  }
}
