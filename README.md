---
description: "Live network traffic accounting for DeepSeek Harness: counts every outbound HTTP request the Host makes and shows the bytes sent and received."
kind: "package-reference"
---

# dsh-plugin-network-meter

English | [Русский](README.ru.md)

Counts every outbound HTTP request the DSH Host makes and reports the bytes it
sent and received. The panel leads with the **current transfer rate**, so you
see what is moving right now; the session totals stay underneath as context.

![Network meter](icon.svg)

## Why

A DeepSeek Harness session talks to a model provider, a web-search API, an MCP
server and the plugin market. None of that traffic is visible from the
interface. This plugin makes it visible: how fast the bytes are moving now,
how many went out, how many came back, to which hosts.

## The rate, not the total

A session total answers "how much so far", which grows forever and says
nothing about the present. The headline is therefore a **rate over a sliding
window** (five seconds by default): bytes per second, measured from the
requests that finished inside that window.

The window's own span is what the rate divides by, so a request that finished
half a second ago counts as half a second of traffic, not five. When the
traffic stops, the rate falls back to zero while the totals stay put.

## Install

Through the Plugin Manager in the Web sidebar, or from the command line:

```bash
dsh plugin install dsh-plugin-network-meter
```

To install by hand, add the package to your profile's `package.json` and add
the bundle to `dsh.profile.bundles`:

```json
{
  "dependencies": {
    "dsh-plugin-network-meter": "github:Onarous/DSH-Network-Meter"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-plugin-network-meter"
      ]
    }
  }
}
```

Restart DSH after changing the bundle list.

## Plugin market

This plugin is published to the DeepSeek Harness plugin market. The index pins
every version to an exact commit, so an installation is reproducible:

```
https://onarous.github.io/DSH-Network-Meter/market/index.json
```

The install spec it publishes is:

```
git+https://github.com/Onarous/DSH-Network-Meter.git#<commit>
```

To add the market to a profile, put the index URL in `cordis.patch.yml`:

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://onarous.github.io/DSH-Network-Meter/market/index.json
```

The index is rebuilt and republished by
[`.github/workflows/publish-market-index.yml`](.github/workflows/publish-market-index.yml)
on every push to `main`. The workflow fails if the committed index differs from
a fresh rebuild, so the published document always matches the sources.

## How it works

DSH exposes no injectable HTTP transport service — the Cordis service registry
holds no `http`, `fetch`, `transport`, or `network` entry. Its outbound code
calls the bare global `fetch`, so the plugin wraps `globalThis.fetch` and
counts around it. This is the same seam `dsh-experimental-inspector` uses for
its own fetch capture.

The wrapper is transparent by construction:

- `input` and `init` are forwarded to the previous `fetch` **by identity**, so
  `init.dispatcher`, `init.signal`, `init.redirect` and every other option
  reach Node's own undici untouched. The proxy policy installed by
  `dsh-http-proxy` keeps working exactly as before.
- The request body is measured without consuming it: a `Request` input is
  measured through a clone.
- The response body is measured through a clone that is drained in the
  background, so the caller's stream is never disturbed and streaming
  responses (SSE) still stream.
- A measurement that fails never fails the request it measures. A body whose
  size cannot be determined is counted as `0` and increments `unmeasured`, so an
  undercount is visible instead of silent.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `observe` | `true` | Whether the observer wraps `globalThis.fetch`. With it off the plugin stays mounted and its endpoint still answers, so the UI can report that observation is disabled. |
| `maxHosts` | `25` | How many hosts the snapshot reports. |
| `maxRecent` | `60` | How many recent requests the ledger keeps. |
| `refreshMs` | `1000` | How often the browser polls the Host, in milliseconds. |
| `rateWindowMs` | `5000` | The sliding window the live rate is measured over, in milliseconds. A short window tracks the moment; a long one smooths the jitter of one answer. |

## Endpoints

The plugin registers two routes on the Host's web server.

### `GET /api/network-meter/stats`

Answers the current snapshot:

```json
{
  "ok": true,
  "sentBytesPerSecond": 245760,
  "receivedBytesPerSecond": 15360,
  "activeRequests": 3,
  "windowMs": 5000,
  "sentBytes": 184320,
  "receivedBytes": 912233,
  "totalBytes": 1096553,
  "requests": 42,
  "errors": 0,
  "unmeasured": 0,
  "observing": true,
  "observationError": null,
  "uptimeMs": 61000,
  "scopes": [{ "scope": "llm", "sentBytes": 0, "receivedBytes": 0, "requests": 0 }],
  "hosts": [{ "host": "api.deepseek.com", "scope": "llm", "sentBytes": 0, "receivedBytes": 0, "requests": 0 }],
  "recent": [{ "url": "https://...", "method": "POST", "host": "api.deepseek.com", "scope": "llm", "status": 200, "sentBytes": 0, "receivedBytes": 0, "durationMs": 812 }]
}
```

### `POST /api/network-meter/reset`

Clears every counter and answers the fresh snapshot.

## What is counted, and what is not

**Counted** — every request the Host makes through the global `fetch`: LLM
inference, model discovery, web search, the DeepSeek web API, MCP over
streamable HTTP, and the plugin market.

**Not counted** — and why:

- `dsh-web-fetch-http`'s direct path owns its own undici `Agent` to pin an
  address, so it does not reach the global dispatcher. Its proxy-exempt path
  does use the global and is counted.
- OTLP telemetry posts through `node:http`, which no global dispatcher reaches.
- Worker threads (`dsh-ptc-runtime`, the workflow worker) have their own
  `globalThis` and their own dispatcher.
- Requests the **browser** makes directly to a provider never touch the Host
  process and cannot be seen by any Host plugin.

The scope buckets (`llm`, `web`, `mcp`, `plugin`, `other`) are a reporting aid
derived from the URL, not a transport fact; an unrecognised host lands in
`other` rather than being guessed into a bucket.

## Tests

```bash
pnpm install
node test/traffic.test.mjs         # byte counts, streams, errors, transport options
node test/rate-live.mjs           # the live rate: a burst, a fall-off, a return to zero
node test/end-to-end.mjs          # the Host half end to end
node test/client.test.mjs         # the client bundle's slots and rendering
```

`test/loader-integration.mjs` mounts the plugin through the real
`@deepseek-ai/cordis` registry against the real `dsh-host-webserver`, which is
the closest thing to the shipped composition that can run outside the app.

## License

MIT
