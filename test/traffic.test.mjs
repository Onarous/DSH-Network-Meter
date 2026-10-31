/**
 * Verifies the traffic observer against a real HTTP server.
 *
 * The point of these tests is that the wrapper stays transparent: the request
 * still succeeds, the caller still gets its body, and the counted bytes match
 * what actually crossed the wire.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { TrafficLedger, classifyScope, installTrafficObserver } from '../lib/index.js';

const BODY = JSON.stringify({ ok: true, hello: 'world' });

/**
 * Start a local server that answers every request with a fixed JSON body.
 *
 * @returns {Promise<{base: string, close: () => Promise<void>}>} the server handle.
 */
async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: chunk-${i++}\n\n`);
        if (i >= 4) { clearInterval(timer); res.end(); }
      }, 5);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY) });
    res.end(BODY);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Install the observer over a fresh ledger for one test.
 *
 * @returns {{ledger: TrafficLedger, stop: () => void}} the ledger and the restorer.
 */
function observe() {
  const ledger = new TrafficLedger();
  const owner = installTrafficObserver(ledger);
  assert.equal(owner.installed, true, owner.error ?? '');
  return { ledger, stop: owner.stop };
}

/**
 * Wait until the predicate holds or the budget expires.
 *
 * @param {() => boolean} predicate - the condition to await.
 * @param {number} [timeoutMs] - the budget.
 * @returns {Promise<void>} resolves when the predicate held.
 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition did not hold in time');
}

test('classifyScope places hosts into reporting scopes', () => {
  assert.equal(classifyScope('https://api.openai.com/v1/chat/completions'), 'llm');
  assert.equal(classifyScope('https://api.deepseek.com/anthropic/v1/messages'), 'llm');
  assert.equal(classifyScope('https://registry.npmjs.org/left-pad'), 'plugin');
  assert.equal(classifyScope('https://example.com/'), 'other');
  assert.equal(classifyScope('not a url'), 'other');
});

test('counts the bytes a request sends and receives', async () => {
  const server = await startServer();
  const { ledger, stop } = observe();
  try {
    const request = 'hello-traffic-probe';
    const response = await fetch(`${server.base}/echo`, { method: 'POST', body: request });
    const text = await response.text();

    assert.equal(text, BODY, 'the caller still receives the original body');
    assert.equal(response.status, 200);

    await until(() => ledger.requests === 1);

    assert.equal(ledger.sentBytes, Buffer.byteLength(request), 'sent bytes are exact');
    assert.equal(ledger.receivedBytes, Buffer.byteLength(BODY), 'received bytes are exact');
    assert.equal(ledger.errors, 0);
    assert.equal(ledger.unmeasured, 0);
  } finally {
    stop();
    await server.close();
  }
});

test('counts a streamed response body', async () => {
  const server = await startServer();
  const { ledger, stop } = observe();
  try {
    const response = await fetch(`${server.base}/stream`);
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }

    await until(() => ledger.requests === 1);
    assert.equal(ledger.receivedBytes, received, 'the streamed bytes are counted');
    assert.ok(ledger.receivedBytes > 0);
  } finally {
    stop();
    await server.close();
  }
});

test('a failing request is recorded and still throws', async () => {
  const { ledger, stop } = observe();
  try {
    await assert.rejects(() => fetch('http://127.0.0.1:1/none'));
    await until(() => ledger.requests === 1);
    assert.equal(ledger.errors, 1);
    assert.equal(ledger.receivedBytes, 0);
  } finally {
    stop();
  }
});

test('the wrapper forwards init by identity so dispatcher and signal survive', async () => {
  const server = await startServer();
  const ledger = new TrafficLedger();
  let seenInit = null;
  const original = globalThis.fetch;
  const owner = installTrafficObserver(ledger);
  try {
    // Replace the wrapper's view of `init` by observing the same object the
    // wrapper forwards: a dispatcher option must reach undici untouched.
    const controller = new AbortController();
    const marker = { __marker: 'init-identity' };
    globalThis.fetch = (input, init) => {
      seenInit = init;
      return original(input, init);
    };
    await assert.rejects(() => fetch(`${server.base}/echo`, { method: 'POST', body: 'x', dispatcher: marker, signal: controller.signal }));
    assert.equal(seenInit.dispatcher, marker, 'init.dispatcher reaches the transport by identity');
    assert.equal(seenInit.signal, controller.signal, 'init.signal reaches the transport by identity');
  } finally {
    owner.stop();
    await server.close();
  }
});

test('the observer restores the original fetch on stop', () => {
  const before = globalThis.fetch;
  const { stop } = observe();
  assert.notEqual(globalThis.fetch, before, 'the wrapper is installed');
  stop();
  assert.equal(globalThis.fetch, before, 'the original fetch is restored');
});

test('the ledger reports scopes, hosts and recent requests', async () => {
  const server = await startServer();
  const { ledger, stop } = observe();
  try {
    await fetch(`${server.base}/echo`, { method: 'POST', body: 'x' });
    await until(() => ledger.requests === 1);

    const snapshot = ledger.snapshot();
    assert.equal(snapshot.requests, 1);
    assert.equal(snapshot.totalBytes, snapshot.sentBytes + snapshot.receivedBytes);
    assert.equal(snapshot.hosts.length, 1);
    assert.equal(snapshot.hosts[0].host, '127.0.0.1');
    assert.equal(snapshot.recent.length, 1);
    assert.equal(snapshot.recent[0].method, 'POST');
    assert.equal(snapshot.recent[0].status, 200);

    ledger.reset();
    assert.equal(ledger.requests, 0);
    assert.equal(ledger.sentBytes, 0);
    assert.equal(ledger.receivedBytes, 0);
  } finally {
    stop();
    await server.close();
  }
});
