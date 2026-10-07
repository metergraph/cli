import { spawnSync } from "node:child_process";
import path from "node:path";

import { systemRoot } from "./auth-browser.js";
import { Stop } from "./auth-store.js";

// Windows access control for a plaintext env file. File modes do not protect
// anything on Windows, so a private file gets a protected DACL (no inherited
// entries) that allows only the current user, SYSTEM and the local
// Administrators group. A fixed Windows PowerShell script does the work; the
// file path travels base64 encoded on stdin, never on the command line, and
// nothing from the file's content is ever passed. Any failure is reported as
// protection_failed, so a file is never called private without proof.

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$mode = [Console]::In.ReadLine()",
  "$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
  "$arg = [Console]::In.ReadLine()",
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
  "$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
  "$allowed = @($me.Value, $system.Value, $admins.Value)",
  "$full = [Security.AccessControl.FileSystemRights]::FullControl",
  "function Test-Private {",
  "  $acl = [IO.File]::GetAccessControl($path)",
  "  if (-not $acl.AreAccessRulesProtected) { return $false }",
  "  if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }",
  "  $mine = $false",
  "  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {",
  "    if ($rule.AccessControlType -ne 'Allow') { continue }",
  "    if ($allowed -notcontains $rule.IdentityReference.Value) { return $false }",
  "    if ($rule.IdentityReference.Value -eq $me.Value -and ($rule.FileSystemRights -band $full) -eq $full) { $mine = $true }",
  "  }",
  "  return $mine",
  "}",
  "if ($mode -eq 'protect') {",
  "  $acl = New-Object Security.AccessControl.FileSecurity",
  "  $acl.SetAccessRuleProtection($true, $false)",
  "  foreach ($sid in @($me, $system, $admins)) {",
  "    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $full, 'Allow')))",
  "  }",
  "  [IO.File]::SetAccessControl($path, $acl)",
  "  if (Test-Private) { [Console]::Out.Write('private') } else { exit 3 }",
  "} elseif ($mode -eq 'status') {",
  "  if (Test-Private) { [Console]::Out.Write('private') } else { [Console]::Out.Write('open') }",
  "} elseif ($mode -eq 'get') {",
  "  $sddl = [IO.File]::GetAccessControl($path).GetSecurityDescriptorSddlForm('Access')",
  "  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl)))",
  "} elseif ($mode -eq 'set') {",
  "  $acl = New-Object Security.AccessControl.FileSecurity",
  "  $acl.SetSecurityDescriptorSddlForm([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg)), 'Access')",
  "  [IO.File]::SetAccessControl($path, $acl)",
  "  [Console]::Out.Write('ok')",
  "} else { exit 2 }",
].join("\n");
const COMMAND = Buffer.from(SCRIPT, "utf16le").toString("base64");
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function run(mode, file, arg = "") {
  const powershell = path.win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", COMMAND], {
    input: `${mode}\n${Buffer.from(file, "utf8").toString("base64")}\n${arg}\n`,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.error || result.status !== 0) throw new Stop("filesystem_error", "protection_failed");
  return out;
}

// Replaces the file's DACL with the private one and verifies it.
export function protectFile(file) {
  if (run("protect", file) !== "private") throw new Stop("filesystem_error", "protection_failed");
}

// Returns "private" or "open".
export function aclStatus(file) {
  const out = run("status", file);
  if (out !== "private" && out !== "open") throw new Stop("filesystem_error", "protection_failed");
  return out;
}

// The file's DACL as opaque base64 SDDL, for an exact restore on rollback.
export function saveAcl(file) {
  const out = run("get", file);
  if (!BASE64.test(out)) throw new Stop("filesystem_error", "protection_failed");
  return out;
}

export function restoreAcl(file, saved) {
  if (!BASE64.test(saved) || run("set", file, saved) !== "ok") {
    throw new Stop("filesystem_error", "protection_failed");
  }
}
