#!/usr/bin/env node
import { main } from "../src/cli.js";

// A closed pipe on stdout (for example "metergraph --help | head -1") is not
// a CLI failure.
process.stdout.on("error", () => {});

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
