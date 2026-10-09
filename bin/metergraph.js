#!/usr/bin/env node
import { handOff, handsOff } from "../src/approval-handoff.js";
import { main } from "../src/cli.js";

// A closed pipe on stdout (for example "metergraph --help | head -1") is not
// a CLI failure.
process.stdout.on("error", () => {});

const argv = process.argv.slice(2);
const io = { stdout: process.stdout, stderr: process.stderr };
process.exitCode = handsOff(argv) ? await handOff(argv, io) : await main(argv, io);
