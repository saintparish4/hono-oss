import { run, group, bench } from 'mitata'
import { Hono } from '../src/hono'
import { memoryStore } from '../src/middleware/cache/adapters/memory'
import { cache } from '../src/middleware/cache/index'
import type { Envelope, KVLike, SetOptions } from '../src/middleware/cache/types'

bench('noop', () => {})

// Fake CacheApi-like store backed by a Map<string, Response>
const fakeCacheApi = (): KVLike => {
  const map = new Map<string, Response>()
  return {
    async get(key) {
      const r = map.get(key)
      return r ? r.clone() : null
    },
    async set(key, env: Envelope, _opts: SetOptions) {
      map.set(key, new Response(env.body, { status: env.status, headers: env.headers }))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

const WARM_URL = 'http://localhost/cached'
const BODY = 'hello from cache benchmark'

group('cache middleware', () => {
  bench('cache hit (CacheApi mock)', async () => {
    const store = fakeCacheApi()
    const app = new Hono()
    app.use('/*', cache({ store, wait: true }))
    app.get('/cached', (c) => c.text(BODY))

    // warm
    await app.request(WARM_URL)
    // hit
    await app.request(WARM_URL)
  })

  bench('cache miss + write (memory)', async () => {
    const app = new Hono()
    app.use('/*', cache({ store: memoryStore(), wait: true }))
    app.get('/cached', (c) => c.text(BODY))

    await app.request(WARM_URL)
  })

  bench('cache hit (memory)', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/*', cache({ store, wait: true }))
    app.get('/cached', (c) => c.text(BODY))

    // warm
    await app.request(WARM_URL)
    // hit
    await app.request(WARM_URL)
  })
})

run()
