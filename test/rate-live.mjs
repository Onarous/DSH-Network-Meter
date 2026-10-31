/**
 * Checks the live rate against a controlled traffic pattern.
 *
 * The rate must track what is happening right now, not the session total: a
 * burst of traffic shows up, and the rate falls back to zero when the traffic
 * stops.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { TrafficLedger, installTrafficObserver } from '../lib/index.js';

const server = createServer((req, res) => {
  const body = 'x'.repeat(50_000);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const ledger = new TrafficLedger({ rateWindowMs: 3000 });
const owner = installTrafficObserver(ledger);

/**
 * Wait until the predicate holds.
 *
 * @param {() => boolean} predicate - the condition to await.
 * @param {number} [timeoutMs] - the budget.
 * @returns {Promise<void>} resolves when the predicate held.
 */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition did not hold in time');
}

console.log('--- before any traffic ---');
let rate = ledger.rate();
console.log('rate:', rate.sentBytesPerSecond, '/', rate.receivedBytesPerSecond);
assert.equal(rate.sentBytesPerSecond, 0);
assert.equal(rate.receivedBytesPerSecond, 0);

console.log('\n--- a burst of 5 requests ---');
for (let i = 0; i < 5; i++) {
  await fetch(`${base}/x`, { method: 'POST', body: 'y'.repeat(1000) });
}
await until(() => ledger.requests === 5);

rate = ledger.rate();
console.log('rate:', Math.round(rate.sentBytesPerSecond), '/', Math.round(rate.receivedBytesPerSecond), 'B/s');
console.log('active:', rate.activeRequests, ' session totals:', ledger.sentBytes, '/', ledger.receivedBytes);
assert.ok(rate.sentBytesPerSecond > 0, 'the sent rate is positive during the burst');
assert.ok(rate.receivedBytesPerSecond > 0, 'the received rate is positive during the burst');
assert.equal(rate.activeRequests, 5, 'all five requests are inside the window');
assert.equal(ledger.sentBytes, 5000, 'the session total is the five request bodies');
assert.equal(ledger.receivedBytes, 250_000, 'the session total is the five response bodies');

console.log('\n--- traffic stops, the rate must fall back to zero ---');
await new Promise((r) => setTimeout(r, 3400));
rate = ledger.rate();
console.log('rate:', rate.sentBytesPerSecond, '/', rate.receivedBytesPerSecond);
console.log('session totals stay:', ledger.sentBytes, '/', ledger.receivedBytes);
assert.equal(rate.sentBytesPerSecond, 0, 'the rate returns to zero when the traffic stops');
assert.equal(rate.receivedBytesPerSecond, 0, 'the received rate returns to zero too');
assert.equal(rate.activeRequests, 0);
assert.equal(ledger.sentBytes, 5000, 'the session total is kept');
assert.equal(ledger.receivedBytes, 250_000, 'the session total is kept');

console.log('\n--- a second burst is visible immediately, without waiting for the old one to age out ---');
await fetch(`${base}/x`, { method: 'POST', body: 'z'.repeat(2000) });
await until(() => ledger.requests === 6);
rate = ledger.rate();
console.log('rate:', Math.round(rate.sentBytesPerSecond), 'B/s   active:', rate.activeRequests);
assert.ok(rate.sentBytesPerSecond > 0, 'the new burst shows up right away');
assert.equal(rate.activeRequests, 1, 'only the new request is inside the window');

owner.stop();
server.close();
console.log('\nRATE OK');
