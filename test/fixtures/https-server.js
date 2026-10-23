// Test-only identity supplied by the lifecycle runner, never production trust.
import fs from 'node:fs';
import https from 'node:https';
export function createServer(handler) {
  const { METERGRAPH_TEST_TLS_KEY: keyPath, METERGRAPH_TEST_TLS_CERT: certPath } = process.env;
  if (!keyPath || !certPath) throw new Error('Run TLS fixtures with node test/run-tests.js [test/file.test.js].');
  return https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler);
}
