import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { assertEvalBrowserOrigin, assertEvalOrigin, fetchEval } from './origin.mjs';

test('eval origin accepts loopback or the separately configured exact origin', () => {
  assert.equal(assertEvalOrigin('http://127.0.0.1:5173/api', undefined), 'http://127.0.0.1:5173');
  assert.equal(assertEvalOrigin('https://eliot.example.test/path', 'https://eliot.example.test'), 'https://eliot.example.test');
  assert.throws(() => assertEvalOrigin('https://other.example.test', 'https://eliot.example.test'), /outside loopback/);
  assert.throws(() => assertEvalOrigin('https://eliot.example.test', undefined), /outside loopback/);
});

test('eval origin rejects userinfo and non-HTTP schemes before dispatch', () => {
  assert.throws(() => assertEvalOrigin('https://user:secret@127.0.0.1:5173', undefined), /userinfo/);
  assert.throws(() => assertEvalOrigin('ftp://127.0.0.1/file', undefined), /HTTP\(S\)/);
  assert.throws(() => assertEvalOrigin('https://127.0.0.1', 'https://user@eliot.example.test'), /userinfo/);
});

test('authenticated fetch is origin-pinned and cannot auto-follow redirects', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('ok', { status: 200 });
  };
  try {
    const response = await fetchEval('http://127.0.0.1:5173/api/me', {
      headers: { 'CF-Access-Client-Secret': 'fixture-only' },
    }, 'http://127.0.0.1:5173', undefined);
    assert.equal(await response.text(), 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.headers['CF-Access-Client-Secret'], 'fixture-only');
    assert.throws(() => fetchEval('https://foreign.example.test/api/me', {
      headers: { 'CF-Access-Client-Secret': 'fixture-only' },
    }, 'http://127.0.0.1:5173', undefined), /outside loopback/);
    assert.throws(() => fetchEval('http://127.0.0.1:5173/api/me', { redirect: 'follow' },
      'http://127.0.0.1:5173', undefined), /reject redirects/);
    assert.equal(calls.length, 1, 'Rejected target and redirect policy must not dispatch another request.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote authenticated Playwright/WebSocket origins fail closed', () => {
  assert.throws(() => assertEvalBrowserOrigin('https://eliot.example.test', 'https://eliot.example.test'), /local-only/);
  assert.equal(assertEvalBrowserOrigin('http://localhost:5173', undefined), 'http://localhost:5173');
});

test('a local cross-origin 302 never forwards the Access sentinel', async () => {
  const sentinel = 'fixture-only-not-a-credential';
  const receivedAtForeign = [];
  const foreign = createServer((request, response) => {
    receivedAtForeign.push(request.headers['cf-access-client-secret']);
    response.writeHead(200, { connection: 'close' });
    response.end('foreign');
  });
  const listen = async (server) => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  const close = async (server) => new Promise((resolve) => server.close(() => resolve()));
  let receivedAtOrigin;
  const origin = await listen(foreign);
  const redirector = createServer((request, response) => {
    receivedAtOrigin = request.headers['cf-access-client-secret'];
    response.writeHead(302, { location: origin + '/collect', connection: 'close' });
    response.end();
  });
  try {
    const target = await listen(redirector);
    await assert.rejects(fetchEval(target + '/redirect', {
      headers: { 'CF-Access-Client-Secret': sentinel },
    }, target, undefined));
    assert.equal(receivedAtOrigin, sentinel, 'Only the selected origin receives the test header.');
    assert.deepEqual(receivedAtForeign, [], 'The redirect target must receive no request or credential.');
  } finally {
    await Promise.all([close(redirector), close(foreign)]);
  }
});
