// Build and release allowlist. Presence here is not evidence of verification;
// CI must execute the compiled helper on each declared host before assembly.
export const TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
export const BINARY_PREFIX = "anchored-fs-";
export const REVISION = /^[0-9a-f]{40}$/;
export const DIGEST = /^[0-9a-f]{64}$/;
export function binaryFor(target) {
  if (!TARGETS.includes(target)) throw new Error("unsupported native target");
  return `${BINARY_PREFIX}${target}`;
}
export function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
}
export function argumentsFor(argv, required, optional = []) {
  const allowed = new Set([...required, ...optional]); const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]; const value = argv[i + 1];
    if (!allowed.has(name) || Object.hasOwn(result, name) || typeof value !== "string" || value === "" || value.startsWith("--")) throw new Error("invalid build arguments");
    result[name] = value;
  }
  if (required.some(name => !Object.hasOwn(result, name))) throw new Error("missing build arguments");
  return result;
}
