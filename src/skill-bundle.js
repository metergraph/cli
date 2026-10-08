import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The skill file shipped in assets/skill/ is a byte-for-byte copy of the
// public skill at the manifest's source_url. The source has no version of its
// own, so the revision is derived from the content hash. The hash is pinned
// here as well as in the manifest, so editing either file alone is detected.
const PINNED_SHA256 = "92f7955f6f8761a20a1886ad81f22dfcee239afddf8e9f1e761c35eb8e70f218";

const ASSET_DIR = new URL("../assets/skill/", import.meta.url);
const MANIFEST_KEYS = ["file", "manifest_version", "name", "revision", "sha256", "size", "source_url"];

export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function revisionFor(sha256) {
  return `sha256-${sha256.slice(0, 12)}`;
}

// Returns { name, revision, sha256, content } for the bundled skill, or null
// when the manifest or the skill file is missing, malformed or does not match
// the pinned hash. Never downloads anything.
export function loadBundledSkill() {
  let manifest;
  let content;
  try {
    manifest = JSON.parse(readFileSync(new URL("manifest.json", ASSET_DIR), "utf8"));
    content = readFileSync(new URL("SKILL.md", ASSET_DIR));
  } catch {
    return null;
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join() !== MANIFEST_KEYS.join() ||
    manifest.manifest_version !== 1 ||
    manifest.file !== "SKILL.md" ||
    manifest.source_url !== "https://www.metergraph.dev/SKILL.md" ||
    typeof manifest.name !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(manifest.name) ||
    manifest.sha256 !== PINNED_SHA256 ||
    manifest.revision !== revisionFor(PINNED_SHA256) ||
    manifest.size !== content.length
  ) {
    return null;
  }
  const sha256 = sha256Hex(content);
  if (sha256 !== PINNED_SHA256) return null;
  if (!content.toString("utf8").startsWith(`---\nname: ${manifest.name}\ndescription: `)) return null;
  return { name: manifest.name, revision: manifest.revision, sha256, content };
}

// The workflow skills that "skills install" writes, vendored from the public
// skills repository at one commit. The manifest's own hash is pinned here, and
// the manifest pins each skill's hash, so changing any file alone is detected.
const PINNED_PACK_SHA256 = "df9cd1cb7cbd648de601a199ce627312c0477fa159b0ab8c0e3d1776079ad887";

const PACK_DIR = new URL("../assets/skills/", import.meta.url);
const PACK_KEYS = ["commit", "manifest_version", "repository", "skills"];
const PACK_ENTRY_KEYS = ["name", "revision", "sha256", "size"];

// Returns { repository, commit, skills: [{ name, revision, sha256, content }] }
// sorted by name, or null when the manifest or any skill file is missing,
// malformed or does not match its pinned hash. Never downloads anything.
export function loadBundledPack() {
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = readFileSync(new URL("manifest.json", PACK_DIR));
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    sha256Hex(manifestBytes) !== PINNED_PACK_SHA256 ||
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join() !== PACK_KEYS.join() ||
    manifest.manifest_version !== 1 ||
    manifest.repository !== "metergraph/skills" ||
    typeof manifest.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.length === 0
  ) {
    return null;
  }
  const skills = [];
  const seen = new Set();
  for (const entry of manifest.skills) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join() !== PACK_ENTRY_KEYS.join() ||
      typeof entry.name !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(entry.name) ||
      entry.name === "metergraph" ||
      seen.has(entry.name) ||
      typeof entry.sha256 !== "string" ||
      entry.revision !== revisionFor(entry.sha256)
    ) {
      return null;
    }
    seen.add(entry.name);
    let content;
    try {
      content = readFileSync(new URL(`${entry.name}/SKILL.md`, PACK_DIR));
    } catch {
      return null;
    }
    if (content.length !== entry.size || sha256Hex(content) !== entry.sha256) return null;
    if (!content.toString("utf8").startsWith(`---\nname: ${entry.name}\ndescription: `)) return null;
    skills.push({ name: entry.name, revision: entry.revision, sha256: entry.sha256, content });
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { repository: manifest.repository, commit: manifest.commit, skills };
}
