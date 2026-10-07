import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The skill file shipped in assets/skill/ is a byte-for-byte copy of the
// public skill at the manifest's source_url. The source has no version of its
// own, so the revision is derived from the content hash. The hash is pinned
// here as well as in the manifest, so editing either file alone is detected.
const PINNED_SHA256 = "57b920677adf62759c7221629327192a2d16b7e6034f7948ffd96cee402d4891";

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
