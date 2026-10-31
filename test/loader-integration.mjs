/**
 * Loads the plugin through DSH's real Cordis runtime.
 *
 * This is the closest thing to the shipped composition that can run outside
 * the app: the real `@deepseek-ai/cordis` context, the real
 * `dsh-host-webserver` service, and the plugin's own bundle patch.
 *
 * The runtime packages live inside the installed app's `app.asar`, so they are
 * extracted to a temporary directory first and imported from there.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { findRuntimePackages } from '../tools/asar-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

/**
 * Extract the runtime packages this test needs into a temporary directory.
 *
 * The extracted tree mirrors the runtime's `node_modules`, so the packages
 * resolve each other by bare specifier exactly as they do in the app.
 *
 * @returns {{root: string, cleanup: () => void}} the extracted tree.
 */
function extractRuntime() {
  const location = findRuntimePackages();
  // The packages resolve each other as bare specifiers, so they must sit in a
  // directory named `node_modules`.
  const temp = mkdtempSync(join(tmpdir(), 'dsh-runtime-'));
  const root = join(temp, 'node_modules');
  mkdirSync(root, { recursive: true });

  /**
   * Write one extracted file into the temporary tree.
   *
   * @param {string} relativePath - the path under the tree root.
   * @param {Buffer} bytes - the file's content.
   * @returns {void}
   */
  const write = (relativePath, bytes) => {
    const dest = join(root, relativePath.replace(/\//g, '\\'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  };

  /**
   * Copy one whole package into the temporary tree.
   *
   * @param {string} packageName - the package's directory name.
   * @returns {void}
   */
  const copyPackage = (packageName) => {
    const manifest = location.read(`${packageName}/package.json`);
    if (manifest === null) {
      throw new Error(`the DSH runtime does not carry ${packageName}`);
    }
    write(`${packageName}/package.json`, manifest);

    const base = `${packageName}/lib`;
    for (const relativePath of location.list(base)) {
      const bytes = location.read(`${base}/${relativePath}`);
      if (bytes !== null) write(`${base}/${relativePath}`, bytes);
    }
  };

  // The scope directory: `@deepseek-ai/<name>`.
  for (const name of ['cordis', 'cosmokit', 'schemastery']) {
    copyPackage(`@deepseek-ai/${name}`);
  }

  // `yaml` is not scoped; it is a plain package the Loader reads patches with.
  const yamlManifest = location.read('yaml/package.json');
  if (yamlManifest === null) {
    throw new Error('the DSH runtime does not carry yaml');
  }
  write('yaml/package.json', yamlManifest);
  for (const relativePath of location.list('yaml/dist')) {
    const bytes = location.read(`yaml/dist/${relativePath}`);
    if (bytes !== null) write(`yaml/dist/${relativePath}`, bytes);
  }

  return { root, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

const runtime = extractRuntime();
const NM = runtime.root;

process.on('exit', runtime.cleanup);

const { Context, Service } = await import(pathToFileURL(join(NM, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
const { parse } = await import(pathToFileURL(join(NM, 'yaml', 'dist', 'index.js')).href);

// ── A minimal stand-in for the web server service ────────────────────
const routes = new Map();

class WebServer extends Service {
  constructor(ctx, config) {
    super(ctx, 'webServer');
    this.config = config;
  }
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  }
}

const app = new Context();
const webServer = new WebServer(app, { host: '127.0.0.1', port: 0 });
assert.ok(webServer, 'the web server service mounted');

// ── The plugin's own bundle patch ────────────────────────────────────
const patchText = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8');
const patch = parse(patchText);
const insert = patch.find((row) => row.insert)?.insert?.find((row) => row.id === 'network-meter');
assert.ok(insert, 'the bundle patch inserts the network-meter row');
assert.equal(insert.name, 'dsh-plugin-network-meter', 'the row names the package');
console.log('bundle patch row:', JSON.stringify(insert));

// The plugin's Config schema must accept the patch's configuration.
const { apply, Config: PluginConfig, name } = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href);
console.log('plugin exports:', { name, hasApply: typeof apply === 'function', hasConfig: typeof PluginConfig === 'object' });

const resolved = PluginConfig(insert.config ?? {});
console.log('config resolved by the plugin schema:', JSON.stringify(resolved));
assert.equal(resolved.observe, true);
assert.equal(resolved.maxHosts, 25);
assert.equal(resolved.maxRecent, 60);
assert.equal(resolved.refreshMs, 1000);

// Mount the plugin through the real Cordis registry.
const fiber = app.registry.plugin(apply, resolved);
await fiber;
console.log('the plugin mounted through the real Cordis registry');

// The plugin registered its routes.
assert.ok(routes.has('/api/network-meter/stats'), 'the stats route registered');
assert.ok(routes.has('/api/network-meter/reset'), 'the reset route registered');
console.log('registered routes:', [...routes.keys()].join(', '));

// The observer is installed.
assert.notEqual(globalThis.fetch.name, 'fetch', 'globalThis.fetch is wrapped');

// ── Serve the routes and read them back ──────────────────────────────
const { createServer } = await import('node:http');
const server = createServer(async (req, res) => {
  const route = routes.get((req.url ?? '').split('?')[0]);
  if (!route) { res.writeHead(404).end('not found'); return; }
  route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Real traffic through the observed fetch.
const upstream = createServer((req, res) => {
  const body = 'upstream-answer';
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

const payload = 'loader-integration-payload';
const response = await fetch(`http://127.0.0.1:${upstream.address().port}/x`, { method: 'POST', body: payload });
const text = await response.text();
assert.equal(text, 'upstream-answer');

const deadline = Date.now() + 3000;
let stats = null;
while (Date.now() < deadline) {
  stats = await (await fetch(`${base}/api/network-meter/stats`)).json();
  if (stats.requests >= 1) break;
  await new Promise((r) => setTimeout(r, 20));
}

console.log('stats.requests:', stats.requests);
console.log('stats.sentBytes:', stats.sentBytes, '(expect', Buffer.byteLength(payload), ')');
console.log('stats.receivedBytes:', stats.receivedBytes, '(expect', Buffer.byteLength(text), ')');
assert.equal(stats.requests, 1);
assert.equal(stats.sentBytes, Buffer.byteLength(payload));
assert.equal(stats.receivedBytes, Buffer.byteLength(text));
assert.equal(stats.observing, true);

// Unmount: the observer is removed and the routes disappear.
await fiber.dispose();
assert.ok(!routes.has('/api/network-meter/stats'), 'the route was removed on dispose');

server.close();
upstream.close();
console.log('\nLOADER INTEGRATION OK');
process.exit(0);
