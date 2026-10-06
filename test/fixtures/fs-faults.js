// Preloaded with --import to inject one filesystem fault into skill install.
// METERGRAPH_TEST_FAULT selects it:
//   receipt-rename      moving the new receipt into place fails with EACCES
//   kill-after-skill    the process is killed as soon as SKILL.md is in place
//   signal-after-skill  SIGINT arrives as soon as SKILL.md is in place
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const fault = process.env.METERGRAPH_TEST_FAULT;
const renameSync = fs.renameSync;

fs.renameSync = (from, to) => {
  const dest = String(to);
  if (fault === "receipt-rename" && dest.endsWith("skill-installations.json")) {
    const error = new Error("SYNTHETIC_FAULT_MARKER");
    error.code = "EACCES";
    throw error;
  }
  renameSync(from, to);
  if (dest.endsWith("SKILL.md")) {
    if (fault === "kill-after-skill") process.kill(process.pid, "SIGKILL");
    if (fault === "signal-after-skill") process.kill(process.pid, "SIGINT");
  }
};
syncBuiltinESMExports();
