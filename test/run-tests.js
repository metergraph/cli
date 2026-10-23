import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { withTlsFixture } from './fixtures/tls-lifecycle.js';
const args = process.argv.slice(2);
const directory = args[0] === 'package' ? 'test/package' : 'test';
if (args[0] === 'package') args.shift();
const files = args.length ? args : fs.readdirSync(directory).filter(name => name.endsWith('.test.js')).map(name => `${directory}/${name}`);
await withTlsFixture(({ key, cert }) => new Promise(resolve => {
  const child = spawn(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert,
      METERGRAPH_TEST_TLS_KEY: key, METERGRAPH_TEST_TLS_CERT: cert },
  });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const finish = code => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.exitCode = code ?? 1;
    resolve();
  };
  child.once('error', () => finish(1));
  child.once('exit', finish);
}));
