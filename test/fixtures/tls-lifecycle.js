import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Development-only identity: never stored in the checkout or installed package.
export function withTlsFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph-test-tls-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  let asynchronous = false;
  try {
    fs.chmodSync(directory, 0o700);
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");
    const config = path.join(directory, "openssl.cnf");
    fs.writeFileSync(config, `[req]
prompt = no
distinguished_name = dn
x509_extensions = server
[dn]
CN = localhost
[server]
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
`, { mode: 0o600 });
    const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-sha256", "-days", "1", "-config", config, "-keyout", key, "-out", cert],
    { stdio: "ignore", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error("Test TLS generation requires development OpenSSL on PATH.");
    fs.chmodSync(key, 0o600);
    const resultValue = run({ directory, key, cert });
    if (resultValue && typeof resultValue.then === "function") {
      asynchronous = true;
      return Promise.resolve(resultValue).finally(cleanup);
    }
    return resultValue;
  } finally {
    if (!asynchronous) cleanup();
  }
}
