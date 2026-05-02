/**
 * @module
 * Cache Middleware for Hono.
 */

import type { Context } from '../../context'
import type { MiddlewareHandler } from '../../types'
import type { StatusCode } from '../../utils/http-status'
import { cacheApi as buildCacheApiStore } from './adapters/cache-api'
import type { CacheOptions, Envelope, KVLike, SetOptions, StoreErrorHook } from './types'
import {
  parseDirectiveList,
  parseHeaderList,
  shouldNotStore,
  buildVaryKeySuffix,
  parseMaxAge,
} from './utils'

const defaultCacheableStatusCodes: ReadonlyArray<StatusCode> = [200]

/**
 * HTTP response cache middleware with pluggable storage.
 *
 * **Storage (`store`)** — Provide a {@link KVLike} implementation. Built-in helpers exported from this module:
 * {@link cacheApi} (Workers Cache API / `globalThis.caches`) and {@link memoryStore} (in-memory envelope store).
 * You must pass either `store` or the legacy {@link CacheOptions.cacheName} option.
 *
 * **`cacheName` (deprecated)** — Prefer `store: cacheApi({ cacheName: '…' })` (or a factory) instead of passing
 * `cacheName` alone; the latter only constructs the Cache API adapter for backward compatibility.
 *
 * **`writeStrategy`** — Controls when `store.set` completes relative to the response:
 * `'await'` waits before returning; `'background'` uses `executionCtx.waitUntil` when available; `'auto'` picks
 * background when `waitUntil` exists, otherwise await.
 *
 * **`wait` (deprecated)** — Boolean precursor to `writeStrategy`; `true` → `'await'`, `false` → `'background'`.
 * Prefer `writeStrategy` instead.
 *
 * **`onStoreError`** — Called when `get`, `set`, or `delete` throws (signature includes operation and key).
 * Defaults to logging a warning. Pass `false` to swallow errors silently.
 *
 * **`vary`** — Header names (`string` or `string[]`) that are merged into the response `Vary` header and used to
 * derive a request-specific key suffix from those header values on the incoming request (normalized, order-independent).
 * The option must not include `*` (middleware-level `*` disables effective caching). Stored responses that advertise
 * `Vary: *` are skipped. When a hit’s stored `Vary` implies extra dimensions beyond the configured hint, the
 * middleware may re-key once so later lookups use the full vary-aware key.
 *
 * This entry also re-exports {@link cacheApi}, {@link memoryStore}, and related types for adapters.
 *
 * @param options - See {@link CacheOptions}.
 * @see {@link https://hono.dev/docs/middleware/builtin/cache}
 */

export const cache = (options: CacheOptions): MiddlewareHandler => {
  // backward compatibility: for cacheName-only usage
  if (!options.store && !options.cacheName) {
    throw new Error('cache(): either `store` or `cacheName` must be provided')
  }

  // CacheApi runtime check, only when relying on the legacy shim
  if (!options.store && !globalThis.caches) {
    if (options.onCacheNotAvailable === false) {
      // suppress
    } else if (options.onCacheNotAvailable) {
      options.onCacheNotAvailable()
    } else {
      console.log('Cache Middleware is not enabled because caches is not defined')
    }
    return async (_c, next) => await next()
  }

  // precompute setup time only state
  const cacheControlDirectives = options.cacheControl
    ? Array.from(parseDirectiveList(options.cacheControl).entries())
    : null

  const varyDirectives = parseHeaderList(options.vary)
  if (varyDirectives.includes('*')) {
    throw new Error(
      'Middleware vary configuration cannot include "*", as it disallows effective caching'
    )
  }

  const cacheableStatusCodes = new Set<number>(
    options.cacheableStatusCodes ?? defaultCacheableStatusCodes
  )

  const resolveWriteStrategy = (c: Context): 'await' | 'background' => {
    const explicit = options.writeStrategy
    if (explicit === 'await' || explicit === 'background') {
      return explicit
    }
    if (options.wait === true) {
      return 'await'
    }
    if (options.wait === false) {
      return 'background'
    }
    // 'auto' or undefined
    return c.executionCtx ? 'background' : 'await'
  }

  const defaultStoreErrorHook: StoreErrorHook = (err, op, key) =>
    console.warn(`[hono cache] store ${op} failed for key ${key}:`, err)

  const errorHook: StoreErrorHook | null =
    options.onStoreError === false ? null : (options.onStoreError ?? defaultStoreErrorHook)

  const getStore: (c: Context) => Promise<KVLike> = options.store
    ? async () => options.store as KVLike
    : buildCacheApiStore({ cacheName: options.cacheName! })

  // Response header writing (preserves existing behavior exactly)
  const addHeader = (c: Context) => {
    if (cacheControlDirectives) {
      const existing = parseDirectiveList(c.res.headers.get('Cache-Control'))
      for (const [name, value] of cacheControlDirectives) {
        if (!existing.has(name)) {
          c.header('Cache-Control', `${name}${value !== undefined ? `=${value}` : ''}`, {
            append: true,
          })
        }
      }
    }
    if (varyDirectives.length) {
      const existing = parseHeaderList(c.res.headers.get('Vary'))
      const merged = Array.from(new Set([...existing, ...varyDirectives])).sort()
      if (merged.includes('*')) {
        c.header('Vary', '*')
      } else {
        c.header('Vary', merged.join(', '))
      }
    }
  }

  // Skip rules: reuse shouldNotStore + Vary:* + Set-Cookie
  const shouldSkip = (res: Response): boolean => {
    const vary = res.headers.get('Vary')
    if (vary && vary.split(',').some((v) => v.trim() === '*')) {
      return true
    }
    if (shouldNotStore(res.headers.get('Cache-Control'))) {
      return true
    }
    if (res.headers.has('Set-Cookie')) {
      return true
    }
    return false
  }

  // Envelope serialization for KV-shaped stores
  const toEnvelope = async (res: Response) => {
    const body = new Uint8Array<ArrayBuffer>(await res.clone().arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return { status: res.status, headers, body }
  }

  // Main handler
  return async function cache(c, next) {
    const userKey = options.keyGenerator ? await options.keyGenerator(c) : c.req.url
    const store = await getStore(c)

    const safeGet = async (k: string) => {
      try {
        return await store.get(k)
      } catch (err) {
        if (errorHook) {
          await errorHook(err, 'get', k, c)
        }
        return null
      }
    }
    const safeSet = async (k: string, env: Envelope, opts: SetOptions) => {
      try {
        await store.set(k, env, opts)
      } catch (err) {
        if (errorHook) {
          await errorHook(err, 'set', k, c)
        }
      }
    }
    const safeDelete = async (k: string) => {
      try {
        await store.delete(k)
      } catch (err) {
        if (errorHook) {
          await errorHook(err, 'delete', k, c)
        }
      }
    }

    // Compute candidate vary headers from the user-supplied hint
    const hintedVary = varyDirectives // array of lowercased names

    // Try the vary-suffixed key first, then the bare key (warm-up path)
    const hintedKey = userKey + buildVaryKeySuffix(hintedVary, c.req.raw.headers)
    let cached = await safeGet(hintedKey)
    let resolvedKey = hintedKey

    if (cached) {
      // If the cached response declares a Vary we didn't account for, we must
      // re-key. Read the response Vary header.
      const cachedVary =
        cached instanceof Response
          ? cached.headers.get('Vary')
          : (cached.headers['vary'] ?? cached.headers['Vary'] ?? null)
      const responseVary = parseHeaderList(cachedVary).filter((v) => v !== '*')
      const allVary = Array.from(new Set([...hintedVary, ...responseVary])).sort()

      if (allVary.length > hintedVary.length && resolvedKey === userKey) {
        // Warm-up rewrite: move from bare key to vary-suffixed key
        const newKey = userKey + buildVaryKeySuffix(allVary, c.req.raw.headers)
        if (newKey !== resolvedKey) {
          const env = cached instanceof Response ? await toEnvelope(cached) : cached
          await safeSet(newKey, env, {})
          await safeDelete(resolvedKey)
        }
      }

      if (cached instanceof Response) {
        return new Response(cached.body, cached)
      }
      return new Response(cached.body, { status: cached.status, headers: cached.headers })
    }

    await next()

    if (!cacheableStatusCodes.has(c.res.status)) {
      return
    }
    addHeader(c)
    if (shouldSkip(c.res)) {
      return
    }

    const writeKey = userKey + buildVaryKeySuffix(hintedVary, c.req.raw.headers)

    const env = await toEnvelope(c.res)
    const ttlSeconds = parseMaxAge(c.res.headers.get('Cache-Control'))
    const strategy = resolveWriteStrategy(c)
    const writePromise = safeSet(writeKey, env, { ttlSeconds })
    if (strategy === 'await') {
      await writePromise
    } else {
      c.executionCtx.waitUntil(writePromise.catch(() => {}))
    }
  }
}

export { cacheApi } from './adapters/cache-api'
export { memoryStore } from './adapters/memory'
export type { CacheApiOptions } from './adapters/cache-api'
export type { MemoryStoreOptions } from './adapters/memory'
export type {
  CacheOptions,
  Envelope,
  KVLike,
  SetOptions,
  StoreErrorHook,
  StoreOp,
  WriteStrategy,
} from './types'
