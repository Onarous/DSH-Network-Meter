/**
 * Verifies the client bundle in a browser-like environment.
 *
 * The bundle is a factory-form CommonJS module that registers itself with
 * `window.__ModuleLoader__`. This harness supplies that loader, a minimal
 * React stand-in, and a stub `ctx.slots` / `ctx.sidebarRightTabs`, then
 * renders the registered components to prove they produce elements instead of
 * throwing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// ── A minimal React stand-in ──────────────────────────────────────────
const hooks = { state: [], index: 0, cleanups: [] };
function useState(initial) {
  const slot = hooks.index++;
  if (hooks.state.length <= slot) hooks.state[slot] = typeof initial === 'function' ? initial() : initial;
  return [hooks.state[slot], (next) => {
    hooks.state[slot] = typeof next === 'function' ? next(hooks.state[slot]) : next;
  }];
}
// The effect runs as soon as it is scheduled, and its cleanup is recorded so
// the harness can tear the timers down at the end.
function useEffect(effect) {
  const cleanup = effect();
  if (typeof cleanup === 'function') hooks.cleanups.push(cleanup);
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState,
  useEffect,
  useCallback: (fn) => fn,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial })
};

// ── The module loader facade ─────────────────────────────────────────
let registered = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { registered = spec; }
  }
};

// ── A `require` that answers the bundle's requests ───────────────────
const requireFn = (specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`the bundle requires an unexpected module: ${specifier}`);
};

// ── Run the bundle ───────────────────────────────────────────────────
new Function('window', 'globalThis', source)(globalThis.window, globalThis);
assert.ok(registered, 'the bundle registered itself with the module loader');
assert.equal(registered.id, 'dsh-plugin-network-meter', 'the bundle id is the package name');

const moduleExports = registered.factory(requireFn);
assert.equal(typeof moduleExports.apply, 'function', 'the bundle exports apply');
assert.ok(Array.isArray(moduleExports.inject), 'the bundle exports inject');
assert.ok(moduleExports.inject.includes('slots'), 'the bundle depends on the slots service');

// ── A stub client context ────────────────────────────────────────────
const registeredSlots = [];
const registeredTabs = [];
const ctx = {
  slots: {
    inject: (name, callback) => { callback(); },
    register: (options, Component) => {
      registeredSlots.push({ options, Component });
      return () => {};
    }
  },
  sidebarRightTabs: {
    register: (definition) => { registeredTabs.push(definition); return () => {}; }
  }
};

moduleExports.apply(ctx);

// The tab type registered.
assert.equal(registeredTabs.length, 1, 'a tab type registered');
assert.equal(registeredTabs[0].id, 'dsh-plugin-network-meter');
assert.equal(typeof registeredTabs[0].title, 'function');
assert.equal(registeredTabs[0].guide.length, 1);
assert.equal(registeredTabs[0].guide[0].id, 'dsh-plugin-network-meter');

// The three seats registered.
const seatNames = registeredSlots.map((entry) => entry.options.name);
assert.ok(seatNames.includes('sidebar.right.pane.tab'), 'the sidebar tab body registered');
assert.ok(seatNames.includes('sidebar.right.pane.tab.title'), 'the sidebar tab title registered');
assert.ok(seatNames.includes('conversation.session.header.utilities'), 'the header indicator registered');

const body = registeredSlots.find((entry) => entry.options.name === 'sidebar.right.pane.tab');
assert.equal(body.options.key, 'dsh-plugin-network-meter', 'the body is keyed by the tab id');
assert.equal(typeof body.Component, 'function', 'the body is a component');

const titleComponent = registeredSlots.find((e) => e.options.name === 'sidebar.right.pane.tab.title').Component;
const indicatorComponent = registeredSlots.find((e) => e.options.name === 'conversation.session.header.utilities').Component;

// ── The snapshot the Host endpoint would deliver ─────────────────────
const SNAPSHOT = {
  ok: true,
  sentBytes: 184320,
  receivedBytes: 912233,
  totalBytes: 1096553,
  requests: 42,
  errors: 2,
  unmeasured: 0,
  observing: true,
  observationError: null,
  uptimeMs: 61000,
  scopes: [
    { scope: 'llm', sentBytes: 1000, receivedBytes: 5000, requests: 10 },
    { scope: 'web', sentBytes: 200, receivedBytes: 900, requests: 4 }
  ],
  hosts: [{ host: 'api.deepseek.com', scope: 'llm', sentBytes: 1000, receivedBytes: 5000, requests: 10 }],
  recent: [{
    url: 'https://api.deepseek.com/v1/messages', method: 'POST', host: 'api.deepseek.com',
    scope: 'llm', status: 200, sentBytes: 1000, receivedBytes: 5000, durationMs: 812, error: null, at: 1
  }],
  sentBytesPerSecond: 245760,
  receivedBytesPerSecond: 15360,
  activeRequests: 3,
  windowMs: 5000
};

// The bundle's store is module-private, so the snapshot reaches it the way the
// Host's endpoint delivers it: through the bundle's own fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => SNAPSHOT });

/**
 * Render a component to a plain tree, rendering nested function components.
 *
 * @param {Function} Component - the component to render.
 * @returns {object} the rendered tree.
 */
function render(Component) {
  hooks.index = 0;
  return renderNode(Component({}));
}

/**
 * Render one node, expanding a function component into its own tree.
 *
 * @param {object} node - the node to render.
 * @returns {object} the rendered tree.
 */
function renderNode(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node.type === 'function') return renderNode(node.type(node.props ?? {}));
  return { ...node, children: (node.children ?? []).map(renderNode) };
}

/**
 * Collect every string in a rendered tree.
 *
 * @param {object} node - the tree node.
 * @param {string[]} [out] - the accumulator.
 * @returns {string[]} the collected strings.
 */
function textOf(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (node.children) textOf(node.children, out);
  return out;
}

// ── The loading state, before the first snapshot arrives ──────────────
// The bundle's store starts empty, so the first render shows the loading
// state. The effects that fetch the snapshot are scheduled by React; the
// harness drives them directly.
const loadingText = textOf(render(body.Component)).join(' ');
assert.match(loadingText, /Сеть/, 'the body names the panel');
assert.match(loadingText, /Считаю трафик/, 'the body shows the loading state before the first snapshot');

// ── The populated state, after the snapshot arrives ───────────────────
// The bundle's store is populated by its own `load()`, which the component's
// effect calls. That effect lives inside the bundle, so the harness lets the
// bundle's own timer-driven load run and then re-renders.
await new Promise((r) => setTimeout(r, 60));

const populatedText = textOf(render(body.Component)).join(' ');
// The live rate leads the panel.
assert.match(populatedText, /Сейчас/, 'the body leads with the live rate');
assert.match(populatedText, /240 KB\/s/, 'the sent rate is formatted and shown');
assert.match(populatedText, /15 KB\/s/, 'the received rate is formatted and shown');
assert.match(populatedText, /3 запр\. активны/, 'the body reports the active requests');
assert.match(populatedText, /окне 5 с/, 'the body reports the rate window');
// The session totals stay as context.
assert.match(populatedText, /Всего отправлено/, 'the body keeps the sent total');
assert.match(populatedText, /Всего получено/, 'the body keeps the received total');
assert.match(populatedText, /180 KB/, 'the sent total is formatted');
assert.match(populatedText, /891 KB/, 'the received total is formatted');
assert.match(populatedText, /По направлениям/, 'the body shows the per-scope breakdown');
assert.match(populatedText, /LLM/, 'the scope breakdown names the LLM scope');
assert.match(populatedText, /По хостам/, 'the body shows the per-host breakdown');
assert.match(populatedText, /api\.deepseek\.com/, 'the host breakdown names the host');
assert.match(populatedText, /Последние запросы/, 'the body shows the recent requests');
assert.match(populatedText, /42 запросов/, 'the request count is shown');
assert.match(populatedText, /2 ошибок/, 'the error count is shown');

// The tab chip title shows the live rate.
const titleText = textOf(render(titleComponent)).join(' ');
assert.match(titleText, /240 KB\/s/, `the title shows the sent rate, got: ${titleText}`);
assert.match(titleText, /15 KB\/s/, `the title shows the received rate, got: ${titleText}`);

// The conversation-header indicator shows the same live rate.
const indicatorText = textOf(render(indicatorComponent)).join(' ');
assert.match(indicatorText, /240 KB\/s/, `the indicator shows the sent rate, got: ${indicatorText}`);
assert.match(indicatorText, /15 KB\/s/, `the indicator shows the received rate, got: ${indicatorText}`);

globalThis.fetch = realFetch;

// The bundle polls on an interval; its cleanup must stop it, or the process
// never exits.
for (const cleanup of hooks.cleanups) {
  try { cleanup(); } catch { /* the cleanup may already have run */ }
}

console.log('loading body renders:', loadingText.replace(/\s+/g, ' ').slice(0, 200), '…');
console.log('populated body renders:', populatedText.replace(/\s+/g, ' ').slice(0, 300), '…');
console.log('title renders:', titleText);
console.log('\nCLIENT OK');
