<div align="center">
  <a href="https://hono.dev">
    <img src="https://raw.githubusercontent.com/honojs/hono/main/docs/images/hono-title.png" width="500" height="auto" alt="Hono"/>
  </a>
</div>

<hr />

# RFC (informal): Runtime-agnostic cache middleware for Hono

**Upstream context:** The equivalent proposal was not merged into [honojs/hono](https://github.com/honojs/hono); this repository preserves a complete, tested implementation for portfolio and reference. Recruiters opening this fork should treat the sections below as the design record and the tree under `src/middleware/cache/` as the finished artifact.

---

## Abstract

Refactor Hono’s built-in HTTP cache middleware so storage is **pluggable** behind a small `KVLike` contract. The middleware stops assuming `globalThis.caches` as the only backend: **Node**, **Bun**, **Deno**, and **Cloudflare Workers** can each use an appropriate adapter. Where the Web Cache API exists and is selected, the implementation keeps a **zero-allocation fast path** by round-tripping `Response` objects unchanged.

---

## Motivation

Today, cache middleware that hard-codes `caches.open(name).match(key)` **disables itself** on runtimes without the Cache API (for example Node and Bun) and offers **no extension point** for Workers users who want Workers KV, Redis, or another store. A minimal storage abstraction unlocks the same middleware everywhere while preserving performance on the dominant deployment target (Workers / Cache API).

---

## Proposal

### Storage contract (`KVLike`)

- **`get(key)`** returns `Promise<Response | Envelope | null>`.
  - **`Response`** — used by the Cache API adapter: pass-through, no envelope serialization.
  - **`Envelope`** (`{ status, headers, body }`) — used by KV-shaped stores (memory, future Redis, Workers KV, etc.).
- **`set(key, envelope, { ttlSeconds? })`** — writes an envelope; TTL is derived once from `Cache-Control` (`s-maxage` > `max-age`); adapters may ignore TTL.
- **`delete(key)`** — eviction hook.

### Built-in adapters

| Adapter             | Role |
| ------------------- | ---- |
| **`cacheApi()`**    | Binds to `globalThis.caches`; **Response** on read; dominant-runtime fast path. |
| **`memoryStore()`** | Bounded LRU (insertion-order `Map`, touch via delete-then-set), **lazy TTL on read**, default cap (e.g. 1000 entries); suitable for Node/Bun/local. |

### Semantics preserved or extended

- **Backwards compatibility:** `cacheName` and `wait` remain supported; they map to `store: cacheApi({ cacheName })` and `writeStrategy` respectively.
- **Write behavior:** `writeStrategy: 'await' | 'background' | 'auto'` (default `'auto'`: `waitUntil` when available, else await).
- **Vary-aware keys:** Request dimensions from configured `vary` fold into the cache key for envelope stores; two-phase warm-up avoids extra writes when a full `Vary` is known up front.
- **RFC 7234:** Field-list forms such as `no-cache="..."` / `private="..."` are classified per spec (fixes prior over-broad “do not store” behavior).
- **Resilience:** Store errors do not fail the request; optional `onStoreError(err, op, key, c)` (default: warn). Set `false` to silence.

### Public API surface

Consumers import from `hono/cache`:

```ts
import { cache, cacheApi, memoryStore } from 'hono/cache'
import type { CacheOptions, KVLike, Envelope } from 'hono/cache'
```

Package exports for `./cache` point at `dist/middleware/cache/index` (see `package.json`).

---

## Implementation phases (completed)

| Phase | Deliverable |
| ----- | ----------- |
| 1     | `types.ts`, `utils.ts`, `utils.test.ts` — pure parsers and types |
| 2     | `index.ts` uses utils; RFC 7234 field-list fix folded in where tests require it |
| 3     | Adapters: `adapters/cache-api.ts`, `adapters/memory.ts`, `adapters/contract.ts` |
| 4     | Vary-aware keying + tests (`vary.test.ts`) |
| 5     | `onStoreError` + fault-injection / error tests |
| 6     | Deprecation shims: `cacheName`, `wait` |
| 7     | RFC 7234 tests (integrated with phase 2 per plan) |
| 8     | Runtime tests (workerd / Deno / Bun / Node) + `benchmarks/cache.ts` |
| 9     | JSDoc on `cache()`, exports verification; see [Verification status](#verification-status) |

**Deferred by design (plan):** Redis adapter (separate package), stale-while-revalidate, `maxBytes` on memory store.

### Verification status

Full matrix from the plan has been run on this branch with the following notes:

| Step                       | Result |
| -------------------------- | ------ |
| `bun run test`             | Pass |
| `bun run test:deno`        | Pass |
| `bun run test:bun`         | Pass |
| `bun run test:workerd`     | Pass |
| `bun run lint`             | Pass with **warnings** (non-blocking) |
| `bun benchmarks/cache.ts`  | Run — see [Benchmark results](#benchmark-results) |
| `bun run format`           | **Not applied repo-wide** — would touch a large portion of unrelated files; only feature-local files were formatted |

### Benchmark results

Run locally with **`bun benchmarks/cache.ts`** ([`benchmarks/cache.ts`](benchmarks/cache.ts)). Below is one representative capture (not CI); absolute numbers vary by CPU, OS, and load.

**Environment:** Bun 1.3.13 (x64-win32), AMD Ryzen 5 5625U with Radeon Graphics, ~2.11 GHz.

| Benchmark                   | Avg               | Range (min … max)    | p75      |
| --------------------------- | ----------------- | -------------------- | -------- |
| Cache hit (Cache API mock)  | **43.02 µs**/iter | 28.70 µs … 2.45 ms   | 41.10 µs |
| Cache miss + write (memory) | **25.88 µs**/iter | n/a in this run      | 24.60 µs |
| Cache hit (memory)          | **34.25 µs**/iter | 24.90 µs … 2.20 ms   | 32.40 µs |

The harness also prints a **`noop`** row; mitata may flag it as susceptible to dead-code elimination—use it only as a sanity check, not as a latency baseline.

---

## Hono framework (upstream)

Hono is a small, fast web framework on Web Standards; see **[hono.dev](https://hono.dev)** for the full framework docs, **[Quick Start](https://hono.dev/docs/getting-started/basic)** (`npm create hono@latest`), migration notes in [`docs/MIGRATION.md`](docs/MIGRATION.md), and contributing in [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

---

## Badges (upstream project)

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/honojs/hono/ci.yml?branch=main)](https://github.com/honojs/hono/actions)
[![GitHub](https://img.shields.io/github/license/honojs/hono)](https://github.com/honojs/hono/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/hono)](https://www.npmjs.com/package/hono)
[![npm](https://img.shields.io/npm/dm/hono)](https://www.npmjs.com/package/hono)
[![JSR](https://jsr.io/badges/@hono/hono)](https://jsr.io/@hono/hono)
[![Bundle Size](https://img.shields.io/bundlephobia/min/hono)](https://bundlephobia.com/result?p=hono)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/hono)](https://bundlephobia.com/result?p=hono)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/honojs/hono)](https://github.com/honojs/hono/pulse)
[![GitHub last commit](https://img.shields.io/github/last-commit/honojs/hono)](https://github.com/honojs/hono/commits/main)
[![codecov](https://codecov.io/github/honojs/hono/graph/badge.svg)](https://codecov.io/github/honojs/hono)
[![Discord badge](https://img.shields.io/discord/1011308539819597844?label=Discord&logo=Discord)](https://discord.gg/KMh2eNSdxV)

---

## References

- Implementation plan: [`.cursor/UNIVERSAL_CACHE_MIDDLEWARE_PLAN.txt`](.cursor/UNIVERSAL_CACHE_MIDDLEWARE_PLAN.txt)
- Related discussion: [honojs/hono#3857](https://github.com/honojs/hono/issues/3857)
- Middleware docs (conceptual): [Cache middleware](https://hono.dev/docs/middleware/builtin/cache) on hono.dev

---

## License

Distributed under the MIT License. See [LICENSE](LICENSE).
