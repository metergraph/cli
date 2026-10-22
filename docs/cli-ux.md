# CLI presentation

The command menu should answer “what can I do next?” before explaining the protocol.
Commands are grouped into getting started, exploring and managing. The first screen
includes real starting commands. Running the CLI without arguments remains read only.

## Reference points

- [Vercel global options](https://vercel.com/docs/cli/global-options): command-specific
  help and explicit control over terminal styling. Use restrained emphasis and
  terminal-aware output rather than large decorative banners.
- [AWS help](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-help.html):
  hierarchical discovery, parameter reference and examples at the command level.
- [AWS output formats](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-output-format.html):
  distinguish human presentation from machine output. Keep the existing JSON contract.
- [AWS return codes](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-returncodes.html):
  return codes are a scripting interface with a separate reference. They do not
  need to be appended to every help page or status headline.

These are design references, not claims that the tools share identical behavior.

## Implemented conventions

- Root help groups every current command by task, with concise descriptions.
- Two examples provide a starting point for app setup and account-free pricing.
- Agent connection guidance lives in `metergraph help agents`.
- Numeric codes and internal outcome names stay in JSON and `help exit-codes`.
- Shared result headlines use a status symbol and a readable title.
- Help wraps prose and option descriptions to the terminal width, with hanging
  indentation. Redirected output keeps its columns without ANSI styling by default.
- Existing command options, safety requirements and JSON schemas remain available.

## Action help and setup

Pricing, experiments, skill and skills have action-specific help in both forms:
`metergraph GROUP ACTION --help` and `metergraph help GROUP ACTION`. JSON help
adds an action descriptor while retaining the existing command catalog. Examples
and relevant options come before operational details in command help. Short
synopses avoid repeating every optional flag in the first line.

In a local terminal, `metergraph setup` supplies the local runtime and asks for
Codex, Claude Code, Cursor or an explicit skip. `metergraph login` supplies the
local runtime. All three streams must be terminals. JSON, CI, SSH and cloud
workspaces retain explicit non-interactive flags. The full command is validated
before a prompt appears, including any explicit deployment prerequisites. EOF
and Ctrl+C cancel without starting setup. Browser consent and credential checks
continue through the existing setup implementation.

## Further surface work

Connection settings and operational details are available offline with
`--help --advanced`. Action descriptions cover only the selected action. JSON help
retains the full option catalog. Required history connection selectors stay visible. Command groups should eventually
share a single action/option registry with execution, reducing documentation drift.
No changes in this pass rename commands, change credential scopes, auto-approve
browser consent, or alter experiment execution.
