// Synthetic TLS identity for test servers only. Trust is set exclusively in
// the child test runner, never in the CLI or the operating system CA store.
import fs from 'node:fs';
import https from 'node:https';
const key = fs.readFileSync(new URL('./https-key.pem', import.meta.url));
const cert = fs.readFileSync(new URL('./https-cert.pem', import.meta.url));
export const createServer = handler => https.createServer({ key, cert }, handler);
