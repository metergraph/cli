// Injects one filesystem fault into the setup env writer, for tests only.
// Import it and call setFault(name), or preload it with --import and set
// METERGRAPH_TEST_FAULT. Faults only touch the writer's own temporary files
// (.metergraph-<hex>.tmp) and the project .gitignore:
//   env-rename-denied    moving the new env file into place fails with EACCES
//   env-rename-readonly  as env-rename-denied, with EROFS
//   ignore-rename        moving the new .gitignore into place fails with EACCES
//   rollback-blocked     as env-rename-denied, and restoring .gitignore fails too
//   edit-during-commit   another writer appends to options.file as soon as the
//                        first temporary file is created
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

let fault = process.env.METERGRAPH_TEST_FAULT ?? null;
let options = {};
let ignoreRenames = 0;
let edited = false;

export function setFault(name, settings = {}) {
  fault = name;
  options = settings;
  ignoreRenames = 0;
  edited = false;
}

export function clearFault() {
  setFault(null);
}

const renameSync = fs.renameSync;
const unlinkSync = fs.unlinkSync;
const openSync = fs.openSync;
const TEMP = /[\\/]\.metergraph-[0-9a-f]{12}\.tmp$/;

function failure(code) {
  const error = new Error("SYNTHETIC_FAULT_MARKER");
  error.code = code;
  return error;
}

const isIgnoreFile = (file) => path.basename(String(file)) === ".gitignore";

fs.renameSync = (from, to) => {
  if (TEMP.test(String(from))) {
    if (isIgnoreFile(to)) {
      ignoreRenames += 1;
      if (fault === "ignore-rename") throw failure("EACCES");
      if (fault === "rollback-blocked" && ignoreRenames > 1) throw failure("EIO");
    } else {
      if (fault === "env-rename-denied" || fault === "rollback-blocked") throw failure("EACCES");
      if (fault === "env-rename-readonly") throw failure("EROFS");
    }
  }
  return renameSync(from, to);
};

fs.unlinkSync = (file) => {
  if (fault === "rollback-blocked" && isIgnoreFile(file)) throw failure("EIO");
  return unlinkSync(file);
};

fs.openSync = (file, flags, mode) => {
  if (fault === "edit-during-commit" && !edited && flags === "wx" && TEMP.test(String(file))) {
    edited = true;
    fs.appendFileSync(options.file, "SYNTHETIC_CONCURRENT_EDIT=1\n");
  }
  return openSync(file, flags, mode);
};

syncBuiltinESMExports();
