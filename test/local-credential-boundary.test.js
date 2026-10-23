import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { send } from '../src/transport.js';
import { runLogin } from '../src/auth-login.js';
import { runSetup } from '../src/setup.js';

test('unverified local transport sends no bearer, OAuth form, or bootstrap traffic', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const options of [
      { bearer: 'synthetic-token' },
      { method: 'POST', form: { refresh_token: 'synthetic-refresh' } },
      { method: 'POST', json: { code: 'synthetic-code' } },
      { useGlobalAgent: true, bearer: 'synthetic-token' },
      {},
    ]) {
      assert.deepEqual(await send(origin, '/v1/oauth/token', { maxBytes: 1024, ...options }), {
        kind: 'error', reason: 'local_docker_transport_required', status: null, sent: false,
      });
    }
    assert.equal(requests, 0);
    const publicResponse = await send(origin, '/v1/pricing/models', { maxBytes: 1024, useGlobalAgent: true });
    assert.equal(publicResponse.status, 200);
    assert.equal(requests, 1);
    const calculation = await send(origin, '/v1/pricing/calculate', {
      maxBytes: 1024, useGlobalAgent: true, method: 'POST', json: { model: 'synthetic' },
    });
    assert.equal(calculation.status, 200);
    assert.equal(requests, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('login and setup refuse local consent before files, listeners, and URL announcements', async () => {
  for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    for (const noBrowser of [false, true]) {
      const options = {
        origin, noBrowser, runtime: 'local', project: '/does-not-exist', configDir: '/does-not-exist',
        environment: { kind: 'local', remote: false },
        announce() { assert.fail('local consent URL was announced'); },
      };
      const progress = () => assert.fail('local consent URL was printed');
      for (const run of [runLogin, runSetup]) {
        const result = await run(options, progress);
        assert.equal(result.outcome, 'unsupported');
        assert.equal(result.reason, 'local_docker_transport_required');
      }
    }
  }
});
