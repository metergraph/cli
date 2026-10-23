import assert from 'node:assert/strict';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { withTlsFixture } from './fixtures/tls-lifecycle.js';

test('TLS files are private, short-lived and cleaned after success', () => {
  let owned;
  withTlsFixture(({ directory, key, cert }) => {
    owned = directory;
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    }
    const certificate = new X509Certificate(fs.readFileSync(cert));
    assert.equal(certificate.checkHost('localhost'), 'localhost');
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.ok(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom) <= 86400000);
  });
  assert.equal(fs.existsSync(owned), false);
});
test('TLS files are cleaned when the test callback fails', () => {
  let owned;
  assert.throws(() => withTlsFixture(({ directory }) => {
    owned = directory;
    throw new Error('synthetic test failure');
  }), /synthetic test failure/);
  assert.equal(fs.existsSync(owned), false);
});
