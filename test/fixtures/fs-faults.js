// Preloaded with --import to inject one filesystem fault into skill install
// or sign in. METERGRAPH_TEST_FAULT selects it:
//   receipt-rename      moving the new receipt into place fails with EACCES
//   kill-after-skill    the process is killed as soon as SKILL.md is in place
//   signal-after-skill  SIGINT arrives as soon as SKILL.md is in place
//   credential-rename   moving a saved grant into place fails with EACCES
//   binding-rename      moving .metergraph/project.json into place fails
//   binding-partial     as binding-rename, and removing the saved grant fails too
//   binding-unlink      removing .metergraph/project.json fails
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const fault = process.env.METERGRAPH_TEST_FAULT;
const renameSync = fs.renameSync;
const unlinkSync = fs.unlinkSync;
const CREDENTIAL = /credentials[\\/][0-9a-f]{32}\.json$/;

function failure() {
  const error = new Error("SYNTHETIC_FAULT_MARKER");
  error.code = "EACCES";
  return error;
}

fs.renameSync = (from, to) => {
  const dest = String(to);
  if (fault === "receipt-rename" && dest.endsWith("skill-installations.json")) throw failure();
  if (fault === "credential-rename" && CREDENTIAL.test(dest)) throw failure();
  if ((fault === "binding-rename" || fault === "binding-partial") && dest.endsWith("project.json")) throw failure();
  renameSync(from, to);
  if (dest.endsWith("SKILL.md")) {
    if (fault === "kill-after-skill") process.kill(process.pid, "SIGKILL");
    if (fault === "signal-after-skill") process.kill(process.pid, "SIGINT");
  }
};

fs.unlinkSync = (file) => {
  if (fault === "binding-partial" && CREDENTIAL.test(String(file))) throw failure();
  if (fault === "binding-unlink" && String(file).endsWith("project.json")) throw failure();
  unlinkSync(file);
};
syncBuiltinESMExports();
