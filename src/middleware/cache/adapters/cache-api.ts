/**
 * @module
 * Web Cache API adapter. Round-trips Response objects unchanged so the
 * Workers / Deno fast path stays zero-extra-allocation.
 */

import type { Context } from '../../../context'
import type { Envelope, KVLike, SetOptions } from '../types'

export interface CacheApiOptions {
  cacheName: string | ((c: Context) => Promise<string> | string)
}

/**
 * Returns a factory because cacheName may depend on Context. The middleware
 * calls the factory once per request
 */

// Scheme used to wrap arbitrary KVLike string keys into a valid URL for
// the underlying Web Cache API, which requires URL-formatted keys.
const KEY_URL_PREFIX = 'https://hono.cache/'

const toCacheUrl = (key: string): string => {
  // Fast path: already a valid absolute URL (e.g. c.req.url) — use as-is so
  // that real-world middleware keys remain debuggable in Cache Storage.
  try {
    new URL(key)
    return key
  } catch {
    return KEY_URL_PREFIX + encodeURIComponent(key)
  }
}

export const cacheApi = (options: CacheApiOptions): ((c: Context) => Promise<KVLike>) => {
  return async (c: Context): Promise<KVLike> => {
    if (!globalThis.caches) {
      throw new Error('cacheApi: globalThis.caches is not available in this runtime')
    }
    const name =
      typeof options.cacheName === 'function' ? await options.cacheName(c) : options.cacheName
    const cache = await caches.open(name)

    return {
      async get(key: string) {
        const r = await cache.match(toCacheUrl(key))
        return r ?? null
      },
      async set(key: string, env: Envelope, opts: SetOptions) {
        const headers = { ...env.headers }
        if (!headers['cache-control'] && !headers['Cache-Control']) {
          const ttl = opts.ttlSeconds ?? 31536000
          headers['Cache-Control'] = `max-age=${ttl}`
        }
        const res = new Response(env.body, { status: env.status, headers })
        await cache.put(toCacheUrl(key), res)
      },
      async delete(key) {
        await cache.delete(toCacheUrl(key))
      },
    }
  }
}
