import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { send } from '../src/transport.js';
import { runLogin } from '../src/auth-login.js';
import { runSetup } from '../src/setup.js';
import { runDoctor } from '../src/doctor.js';
import { healthyRoutes, startServer } from './helpers.js';

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
    for (const pathname of ['/v1/pricing/lookup', '/v1/pricing/cost', '/v1/pricing/history', '/v1/pricing/market']) {
      for (const options of [{ bearer: 'synthetic-token' }, { form: { token: 'synthetic-token' } },
        { json: { token: 'synthetic-token' } }, { method: 'POST' }]) {
        const response = await send(origin, pathname, { maxBytes: 1024, ...options });
        assert.equal(response.reason, 'local_docker_transport_required');
        assert.equal(response.sent, false);
      }
    }
    assert.equal(requests, 0);
    for (const pathname of ['/v1/pricing/lookup', '/v1/pricing/cost', '/v1/pricing/history', '/v1/pricing/market']) {
      const response = await send(origin, pathname, { maxBytes: 1024 });
      assert.equal(response.status, 200, pathname);
    }
    assert.equal(requests, 4);
    const publicResponse = await send(origin, '/v1/pricing/models', { maxBytes: 1024, useGlobalAgent: true });
    assert.equal(publicResponse.status, 200);
    assert.equal(requests, 5);
    const calculation = await send(origin, '/v1/pricing/calculate', {
      maxBytes: 1024, useGlobalAgent: true, method: 'POST', json: { model: 'synthetic' },
    });
    assert.equal(calculation.status, 200);
    assert.equal(requests, 6);
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


test('loopback HTTP probes remain credential-free and cannot authorize credential traffic', async () => {
  const server = await startServer(healthyRoutes('local'), { tls: false });
  try {
    for (const pathname of ['/healthz', '/v1/deployment']) {
      const response = await send(server.origin, pathname, { maxBytes: 1024 });
      assert.equal(response.status, 200);
    }
    const probeRequests = server.requests.length;
    for (const pathname of ['/healthz', '/v1/deployment', '/v1/oauth/token', '/v1/cli/setup/metadata', '/v1/agent/workspace']) {
      for (const options of [{ bearer: 'synthetic-token' }, { form: { refresh_token: 'synthetic-token' } },
        { json: { code: 'synthetic-code' } }, { method: 'POST' }]) {
        const response = await send(server.origin, pathname, { maxBytes: 1024, ...options });
        assert.equal(response.reason, 'local_docker_transport_required');
        assert.equal(response.sent, false);
      }
    }
    assert.equal(server.requests.length, probeRequests);
    const nonLoopback = await send('http://example.test', '/healthz', { maxBytes: 1024 });
    assert.equal(nonLoopback.sent, false);
    assert.equal(nonLoopback.reason, 'local_docker_transport_required');
    const doctor = await runDoctor({ origin: server.origin, timeoutMs: 5000 });
    assert.equal(doctor.outcome, 'authentication_required');
    assert.equal(doctor.report.authenticated, false);
    assert.deepEqual(server.requests.slice(probeRequests).map(r => r.path), ['/healthz', '/v1/deployment', '/v1/agent/capabilities']);
    assert.ok(server.requests.every(r => r.headers.authorization === undefined && r.headers.cookie === undefined));
  } finally {
    await server.close();
  }
});
