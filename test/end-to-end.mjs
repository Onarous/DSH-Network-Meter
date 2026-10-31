/**
 * End-to-end check of the Host half.
 *
 * Mounts the plugin against a stand-in for DSH's `webServer` service and a
 * real HTTP server, then drives real traffic through it and reads the numbers
 * back over the endpoint the browser would use.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:http';

import { apply, name } from '../lib/index.js';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// A stand-in for the DSH web server service: it records routes and answers
// them, exactly as `dsh-host-webserver` does for a named exact route.
const routes = new Map();
const webServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  }
};

// A stand-in for the Cordis context: only what the plugin touches.
// `ctx.effect` mirrors the real one: it runs the callback and keeps the
// returned disposer for the plugin's teardown.
const effectDisposers = [];
const ctx = {
  logger: () => logger,
  inject(names, callback) {
    callback({ webServer });
  },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') effectDisposers.push(dispose);
    return () => {};
  },
  get(name) {
    return name === 'webServer' ? webServer : undefined;
  }
};

// The upstream the plugin's traffic goes to.
const upstream = createServer((req, res) => {
  const body = JSON.stringify({ ok: true, echo: req.headers['x-echo'] ?? null });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

// Mount the plugin.
const dispose = apply(ctx, { observe: true, maxHosts: 10, maxRecent: 20 });

// A stand-in for the Host's HTTP server, answering the registered routes.
const host = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.get(path);
  if (!route) {
    res.writeHead(404).end('not found');
    return;
  }
  route.handler(req, res);
});
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const hostBase = `http://127.0.0.1:${host.address().port}`;

/**
 * Wait until the predicate holds.
 *
 * @param {() => boolean} predicate - the condition to await.
 * @returns {Promise<void>} resolves when the predicate held.
 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition did not hold in time');
}

// Drive real traffic through the observed fetch.
const payload = 'e2e-traffic-payload';
const response = await fetch(`${upstreamBase}/echo`, {
  method: 'POST',
  headers: { 'x-echo': 'hello' },
  body: payload
});
const text = await response.text();
assert.equal(response.status, 200);
assert.equal(text, JSON.stringify({ ok: true, echo: 'hello' }));

await until(async () => {
  const stats = await (await fetch(`${hostBase}/api/network-meter/stats`)).json();
  return stats.requests >= 1;
});

// Read the snapshot the way the browser does.
const stats = await (await fetch(`${hostBase}/api/network-meter/stats`)).json();

console.log('plugin name:', name);
console.log('observing:', stats.observing);
console.log('requests:', stats.requests);
console.log('sentBytes:', stats.sentBytes, '(expect', Buffer.byteLength(payload), ')');
console.log('receivedBytes:', stats.receivedBytes, '(expect', Buffer.byteLength(text), ')');
console.log('scopes:', JSON.stringify(stats.scopes));
console.log('hosts:', JSON.stringify(stats.hosts.map((h) => h.host)));
console.log('recent[0]:', JSON.stringify({
  method: stats.recent[0]?.method,
  host: stats.recent[0]?.host,
  status: stats.recent[0]?.status,
  sentBytes: stats.recent[0]?.sentBytes,
  receivedBytes: stats.recent[0]?.receivedBytes
}));

assert.equal(stats.ok, true);
assert.equal(stats.observing, true);
assert.equal(stats.requests, 1);
assert.equal(stats.sentBytes, Buffer.byteLength(payload), 'the sent bytes are exact');
assert.equal(stats.receivedBytes, Buffer.byteLength(text), 'the received bytes are exact');
assert.equal(stats.unmeasured, 0);
assert.equal(stats.errors, 0);
assert.equal(stats.hosts.length, 1);
assert.equal(stats.hosts[0].host, '127.0.0.1');
assert.equal(stats.recent.length, 1);
assert.equal(stats.recent[0].method, 'POST');
assert.equal(stats.recent[0].status, 200);

// The reset route clears the counters.
const reset = await (await fetch(`${hostBase}/api/network-meter/reset`, { method: 'POST' })).json();
assert.equal(reset.ok, true);
assert.equal(reset.requests, 0);
assert.equal(reset.sentBytes, 0);
assert.equal(reset.receivedBytes, 0);
console.log('reset: counters cleared');

// A wrong method is refused.
const refused = await fetch(`${hostBase}/api/network-meter/stats`, { method: 'POST' });
assert.equal(refused.status, 405);
console.log('stats route refuses POST: 405');

// Unmounting restores the original fetch.
const observed = globalThis.fetch;
dispose();
for (const release of effectDisposers) release();
assert.equal(routes.size, 0, 'the routes were released on dispose');
assert.notEqual(globalThis.fetch, observed, 'the observer wrapper is gone');
assert.equal(typeof globalThis.fetch, 'function', 'a working fetch remains');
console.log('dispose: the observer wrapper was removed and the routes released');

host.close();
upstream.close();
console.log('\nEND-TO-END OK');
