import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = process.argv[2] === 'package' ? 'test/package' : 'test';
const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.js')).map(name => `${directory}/${name}`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./fixtures/https-cert.pem', import.meta.url)) },
});
process.exitCode = result.status ?? 1;
