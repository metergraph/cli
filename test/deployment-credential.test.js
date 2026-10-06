import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { CREDENTIAL_MAX_BYTES, credentialStatProblem, readCredentialFile } from "../src/deployment-credential.js";

// Every token is generated per test and written only to a private temporary
// file. No fixture holds a credential.
const isWindows = process.platform === "win32";
const newToken = () => `mgtest_${randomBytes(24).toString("hex")}`;

let root;
let counter = 0;

// A fresh private directory, under the canonical temporary directory so no
// parent is a symbolic link (on macOS /var is one).
function privateDir() {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function writePrivate(dir, content, mode = 0o600) {
  const file = path.join(dir, "agent-token");
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

// A failure carries fixed tokens only.
function assertFails(result, reason, { file = null, token = null } = {}) {
  assert.deepEqual(Object.keys(result).sort(), ["ok", "outcome", "reason"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  const text = JSON.stringify(result);
  if (file !== null) assert.ok(!text.includes(file) && !text.includes(path.basename(path.dirname(file))));
  if (token !== null) assert.ok(!text.includes(token));
}

describe("deployment credential file", { skip: isWindows }, () => {
  before(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mg-deploy-cred-"));
    fs.chmodSync(root, 0o700);
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("reads one token from a private file without changing it", () => {
    const token = newToken();
    const file = writePrivate(privateDir(), `${token}\n`);
    const stat = fs.statSync(file);
    assert.deepEqual(readCredentialFile(file), { ok: true, token });
    assert.equal(fs.readFileSync(file, "utf8"), `${token}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(file)).length, 1, "nothing was copied next to the file");
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);

    const crlf = writePrivate(privateDir(), `${token}\r\n`);
    assert.deepEqual(readCredentialFile(crlf), { ok: true, token });
  });

  test("refuses paths that are not explicit, absolute and normalized", () => {
    const dir = privateDir();
    for (const bad of [undefined, null, "", "agent-token", "./agent-token", `${dir}/../x/agent-token`, `${dir}//agent-token`, `${dir}/`, `${dir}/a\0b`, 42]) {
      assertFails(readCredentialFile(bad), "credential_path_invalid");
    }
    assertFails(readCredentialFile(path.join(dir, "absent")), "credential_missing");
  });

  test("Windows fails closed with a platform credential handoff", () => {
    const token = newToken();
    const file = writePrivate(privateDir(), token);
    const result = readCredentialFile(file, { platform: "win32" });
    assert.deepEqual(result, { ok: false, outcome: "unsupported", reason: "platform_credential_handoff" });
  });

  test("refuses a symbolic link as the file or as any parent component", () => {
    const token = newToken();
    const dir = privateDir();
    const real = writePrivate(dir, token);

    const fileLink = path.join(dir, "link-token");
    fs.symlinkSync(real, fileLink);
    assertFails(readCredentialFile(fileLink), "credential_symlink", { file: fileLink, token });

    const parentLink = path.join(privateDir(), "linked-dir");
    fs.symlinkSync(dir, parentLink);
    assertFails(readCredentialFile(path.join(parentLink, "agent-token")), "credential_path_symlink", { token });

    // A link higher up the path is refused too.
    const upper = privateDir();
    fs.symlinkSync(path.dirname(dir), path.join(upper, "up"));
    const deep = path.join(upper, "up", path.basename(dir), "agent-token");
    assertFails(readCredentialFile(deep), "credential_path_symlink", { token });

    const tmp = os.tmpdir();
    if (fs.realpathSync(tmp) !== tmp) {
      const viaLink = fs.mkdtempSync(path.join(tmp, "mg-deploy-link-"));
      try {
        fs.chmodSync(viaLink, 0o700);
        const file = writePrivate(viaLink, token);
        assertFails(readCredentialFile(file), "credential_path_symlink", { token });
      } finally {
        fs.rmSync(viaLink, { recursive: true, force: true });
      }
    }
  });

  test("refuses files readable or writable by anyone but the owner", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o700, 0o400, 0o4600]) {
      const token = newToken();
      const file = writePrivate(privateDir(), token, mode);
      if ((fs.statSync(file).mode & 0o7777) !== mode) continue;
      assertFails(readCredentialFile(file), "credential_permissions_unsafe", { file, token });
    }
  });

  test("refuses a directory, FIFO or hard link instead of a private regular file", async () => {
    const dir = privateDir();
    const sub = path.join(dir, "agent-token");
    fs.mkdirSync(sub, { mode: 0o700 });
    assertFails(readCredentialFile(sub), "credential_not_regular");

    const fifoDir = privateDir();
    const fifo = path.join(fifoDir, "agent-token");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    // A blocking open would hang the test here; the deadline proves it did not.
    const started = Date.now();
    assertFails(readCredentialFile(fifo), "credential_not_regular");
    assert.ok(Date.now() - started < 1000);

    const token = newToken();
    const linkDir = privateDir();
    const file = writePrivate(linkDir, token);
    fs.linkSync(file, path.join(linkDir, "second-name"));
    assertFails(readCredentialFile(file), "credential_hardlinked", { file, token });
  });

  test("refuses a parent directory others can write, with a sticky allowance only higher up", () => {
    for (const mode of [0o777, 0o770, 0o1777, 0o755 | 0o002]) {
      const token = newToken();
      const dir = privateDir();
      const file = writePrivate(dir, token);
      fs.chmodSync(dir, mode);
      assertFails(readCredentialFile(file), "credential_parent_unsafe", { file, token });
      fs.chmodSync(dir, 0o700);
    }

    // A shared directory above the file's own directory is accepted only
    // with the sticky bit, as on /tmp.
    const shared = privateDir();
    const inner = path.join(shared, "private");
    fs.mkdirSync(inner, { mode: 0o700 });
    const token = newToken();
    const file = writePrivate(inner, token);
    fs.chmodSync(shared, 0o1777);
    assert.deepEqual(readCredentialFile(file), { ok: true, token });
    fs.chmodSync(shared, 0o777);
    assertFails(readCredentialFile(file), "credential_parent_unsafe", { file, token });
    fs.chmodSync(shared, 0o700);
  });

  test("refuses empty, oversized, multi-token and malformed content", () => {
    const token = newToken();
    const cases = [
      ["", "credential_empty"],
      ["\n", "credential_empty"],
      ["x".repeat(CREDENTIAL_MAX_BYTES + 1), "credential_too_large"],
      [`${token} ${newToken()}`, "credential_malformed"],
      [`${token}\n${newToken()}\n`, "credential_malformed"],
      [`Bearer ${token}`, "credential_malformed"],
      [`${token}\n\n`, "credential_malformed"],
      [` ${token}`, "credential_malformed"],
      ["short", "credential_malformed"],
      [`${token}é`, "credential_malformed"],
      [Buffer.from([0xff, 0xfe, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41]), "credential_malformed"],
    ];
    for (const [content, reason] of cases) {
      const file = writePrivate(privateDir(), content);
      assertFails(readCredentialFile(file), reason, { file, token });
    }
  });

  test("refuses a file replaced between the checks and the read", () => {
    const token = newToken();
    const dir = privateDir();
    const file = writePrivate(dir, token);
    const other = path.join(dir, "other");
    fs.writeFileSync(other, newToken(), { mode: 0o600 });
    const result = readCredentialFile(file, { afterOpen: () => fs.renameSync(other, file) });
    assertFails(result, "credential_changed", { file, token });
  });

  test("refuses a file that changes while it is read", () => {
    const token = newToken();
    const dir = privateDir();
    const file = writePrivate(dir, token);
    // Another link appears after the lstat and before the fstat.
    const result = readCredentialFile(file, { afterOpen: () => fs.linkSync(file, path.join(dir, "late-link")) });
    assertFails(result, "credential_hardlinked", { file, token });

    const moved = privateDir();
    const second = writePrivate(moved, token);
    const away = path.join(root, `moved-${counter}`);
    const swapped = readCredentialFile(second, {
      afterOpen: () => {
        fs.renameSync(moved, away);
        fs.mkdirSync(moved, { mode: 0o700 });
        writePrivate(moved, token);
      },
    });
    assertFails(swapped, "credential_changed", { file: second, token });
  });

  test("rechecks the file after the read and refuses any change made while it was read", () => {
    // Each case runs after the content was read and before it is checked
    // again. Replacement content has the same length as the original.
    const cases = [
      ["mode widened", (file) => fs.chmodSync(file, 0o644), "credential_permissions_unsafe"],
      // Mode, owner and size are back to what was checked; only ctime moved.
      [
        "mode widened and restored",
        (file) => {
          fs.chmodSync(file, 0o644);
          fs.chmodSync(file, 0o600);
        },
        "credential_changed",
      ],
      ["rewritten in place", (file, token) => fs.writeFileSync(file, newToken().slice(0, token.length)), "credential_changed"],
      [
        "one byte overwritten without truncation",
        (file) => {
          const fd = fs.openSync(file, "r+");
          try {
            fs.writeSync(fd, Buffer.from("x"), 0, 1, 0);
          } finally {
            fs.closeSync(fd);
          }
        },
        "credential_changed",
      ],
      ["second link added", (file) => fs.linkSync(file, `${file}-late`), "credential_hardlinked"],
      ["replaced by rename", (file, token) => {
        const other = `${file}-other`;
        fs.writeFileSync(other, newToken().slice(0, token.length), { mode: 0o600 });
        fs.renameSync(other, file);
      }, "credential_changed"],
    ];
    for (const [name, change, reason] of cases) {
      const token = newToken();
      const file = writePrivate(privateDir(), token);
      const result = readCredentialFile(file, { afterRead: () => change(file, token) });
      assert.equal(result.reason, reason, name);
      assertFails(result, reason, { file, token });
    }

    // The seam itself does not disturb an unchanged file.
    const token = newToken();
    const file = writePrivate(privateDir(), token);
    assert.deepEqual(readCredentialFile(file, { afterRead: () => fs.readFileSync(file) }), { ok: true, token });
  });

  test("refuses a file owned by another user", () => {
    const stat = (overrides) => ({
      isFile: () => true,
      uid: 1000,
      mode: 0o100600,
      nlink: 1,
      size: 40,
      ...overrides,
    });
    assert.equal(credentialStatProblem(stat({}), 1000), null);
    assert.equal(credentialStatProblem(stat({ uid: 1001 }), 1000), "credential_not_owner");
    assert.equal(credentialStatProblem(stat({ uid: 0 }), 1000), "credential_not_owner");
    assert.equal(credentialStatProblem(stat({ isFile: () => false }), 1000), "credential_not_regular");
    // The same checks apply to bigint stats, as used for the post-read check.
    const big = (overrides) => stat({ uid: 1000n, mode: 0o100600n, nlink: 1n, size: 40n, ...overrides });
    assert.equal(credentialStatProblem(big({}), 1000), null);
    assert.equal(credentialStatProblem(big({ uid: 1001n }), 1000), "credential_not_owner");
    assert.equal(credentialStatProblem(big({ mode: 0o100644n }), 1000), "credential_permissions_unsafe");
    assert.equal(credentialStatProblem(big({ nlink: 2n }), 1000), "credential_hardlinked");
    assert.equal(credentialStatProblem(big({ size: 0n }), 1000), "credential_empty");
  });
});
