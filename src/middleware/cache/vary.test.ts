import { Hono } from '../../hono'
import { cache } from '.'
import { memoryStore } from './adapters/memory'
import type { KVLike } from './types'
import { describe, it, expect, vi } from 'vitest'

/**
 * Mimics the CacheApi adapter behavior: stores/returns Response objects.
 * Used for parity testing without requiring globalThis.caches.
 */
const responseLikeStore = (): KVLike => {
  const map = new Map<string, Response>()
  return {
    async get(key) {
      return map.get(key)?.clone() ?? null
    },
    async set(key, env) {
      map.set(key, new Response(env.body, { status: env.status, headers: env.headers }))
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

describe('Vary-aware cache keying (memoryStore)', () => {
  it('different Accept values produce different cache entries', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/api/*', cache({ store, vary: ['Accept'], wait: true }))
    let n = 0
    app.get('/api/data', (c) => {
      n++
      return c.json({ n })
    })

    const r1 = await app.request('/api/data', { headers: { Accept: 'application/json' } })
    const r2 = await app.request('/api/data', { headers: { Accept: 'text/html' } })
    expect(await r1.json()).toEqual({ n: 1 })
    expect(await r2.json()).toEqual({ n: 2 })

    const r3 = await app.request('/api/data', { headers: { Accept: 'application/json' } })
    expect(await r3.json()).toEqual({ n: 1 })
  })

  it('same Accept value -> cache hit', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`hit-${++n}`))
    await app.request('/x', { headers: { Accept: 'a' } })
    const r2 = await app.request('/x', { headers: { Accept: 'a' } })
    expect(await r2.text()).toBe('hit-1')
  })

  it('vary header name is case-insensitive', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['ACCEPT'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))
    await app.request('/x', { headers: { accept: 'a' } })
    const r2 = await app.request('/x', { headers: { Accept: 'a' } })
    expect(await r2.text()).toBe('v1')
  })

  it('multi-vary: order independence', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept', 'Accept-Language'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))
    const a = await app.request('/x', {
      headers: { Accept: 'a', 'Accept-Language': 'en' },
    })
    const b = await app.request('/x', {
      headers: { 'Accept-Language': 'en', Accept: 'a' },
    })
    expect(await a.text()).toBe('v1')
    expect(await b.text()).toBe('v1')
  })

  it('warm-up rewrite when vary hint missing but response Vary set', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, wait: true }))
    let n = 0
    app.get('/x', (c) => {
      c.header('Vary', 'Accept')
      return c.text(`v${++n}`)
    })

    // First request: stored under bare key.
    await app.request('/x', { headers: { Accept: 'a' } })
    // Second request, same Accept: read bare, rewrite under vary key.
    const r2 = await app.request('/x', { headers: { Accept: 'a' } })
    expect(await r2.text()).toBe('v1')
    // Third request, different Accept: should NOT hit (proper vary keying now).
    const r3 = await app.request('/x', { headers: { Accept: 'b' } })
    expect(await r3.text()).toBe('v2')
  })

  it('explicit vary hint avoids warm-up double-write', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept'], wait: true }))
    const setSpy = vi.spyOn(store, 'set')
    app.get('/x', (c) => c.text('v1'))
    await app.request('/x', { headers: { Accept: 'a' } })
    expect(setSpy).toHaveBeenCalledTimes(1)
  })

  it('Vary: * skips storage on memoryStore', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, wait: true }))
    let n = 0
    app.get('/x', (c) => {
      c.header('Vary', '*')
      return c.text(`v${++n}`)
    })
    await app.request('/x')
    const r2 = await app.request('/x')
    expect(await r2.text()).toBe('v2')
  })

  it('missing request header treated as empty value (consistent)', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))
    await app.request('/x') // no Accept
    const r2 = await app.request('/x') // no Accept
    expect(await r2.text()).toBe('v1')
  })

  it('response Vary does not override hint: keying follows configured vary only', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept'], wait: true }))
    let n = 0
    app.get('/x', (c) => {
      c.header('Vary', 'Accept-Encoding')
      return c.text(`v${++n}`)
    })

    // Same Accept, different Accept-Encoding → still a cache HIT (keyed by Accept only)
    const r1 = await app.request('/x', {
      headers: { Accept: 'a', 'Accept-Encoding': 'gzip' },
    })
    const r2 = await app.request('/x', {
      headers: { Accept: 'a', 'Accept-Encoding': 'br' },
    })
    expect(await r1.text()).toBe('v1')
    expect(await r2.text()).toBe('v1')

    // Different Accept → cache MISS (different vary dimension)
    const r3 = await app.request('/x', {
      headers: { Accept: 'b', 'Accept-Encoding': 'gzip' },
    })
    expect(await r3.text()).toBe('v2')
  })

  it('multi-vary: all distinct combinations produce distinct entries', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept', 'Accept-Language', 'Accept-Encoding'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))

    const combos = [
      { Accept: 'json', 'Accept-Language': 'en', 'Accept-Encoding': 'gzip' },
      { Accept: 'json', 'Accept-Language': 'fr', 'Accept-Encoding': 'gzip' },
      { Accept: 'html', 'Accept-Language': 'en', 'Accept-Encoding': 'br' },
      { Accept: 'json', 'Accept-Language': 'en', 'Accept-Encoding': 'br' },
    ]

    const results: string[] = []
    for (const headers of combos) {
      const r = await app.request('/x', { headers })
      results.push(await r.text())
    }
    expect(results).toEqual(['v1', 'v2', 'v3', 'v4'])

    // Replay all combos → all cache hits
    const replay: string[] = []
    for (const headers of combos) {
      const r = await app.request('/x', { headers })
      replay.push(await r.text())
    }
    expect(replay).toEqual(['v1', 'v2', 'v3', 'v4'])
  })

  it('parity: responseLikeStore (cacheApi-shaped) matches memoryStore behavior', async () => {
    const matrix = [
      { Accept: 'json' },
      { Accept: 'html' },
      { Accept: 'json' },
      { Accept: 'html' },
      { Accept: 'xml' },
    ]

    const run = async (store: KVLike) => {
      const app = new Hono()
      app.use('/x/*', cache({ store, vary: ['Accept'], wait: true }))
      let n = 0
      app.get('/x', (c) => c.text(`v${++n}`))
      const results: string[] = []
      for (const headers of matrix) {
        const r = await app.request('/x', { headers })
        results.push(await r.text())
      }
      return results
    }

    const memResults = await run(memoryStore())
    const apiResults = await run(responseLikeStore())

    expect(memResults).toEqual(apiResults)
    expect(memResults).toEqual(['v1', 'v2', 'v1', 'v2', 'v3'])
  })

  it('warm-up rewrite handles multi-Vary response without hint', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, wait: true }))
    let n = 0
    app.get('/x', (c) => {
      c.header('Vary', 'Accept, Accept-Language')
      return c.text(`v${++n}`)
    })

    await app.request('/x', { headers: { Accept: 'a', 'Accept-Language': 'en' } })
    // Same headers → warm-up finds bare key, rewrites, returns cached
    const r2 = await app.request('/x', { headers: { Accept: 'a', 'Accept-Language': 'en' } })
    expect(await r2.text()).toBe('v1')

    // Different Accept-Language → miss after rewrite
    const r3 = await app.request('/x', { headers: { Accept: 'a', 'Accept-Language': 'fr' } })
    expect(await r3.text()).toBe('v2')
  })

  it('partial header overlap: shared value in one vary dimension, different in another', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, vary: ['Accept', 'X-Tenant'], wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))

    const r1 = await app.request('/x', { headers: { Accept: 'json', 'X-Tenant': 'acme' } })
    const r2 = await app.request('/x', { headers: { Accept: 'json', 'X-Tenant': 'globex' } })
    expect(await r1.text()).toBe('v1')
    expect(await r2.text()).toBe('v2')

    // Hit existing entries
    const r3 = await app.request('/x', { headers: { Accept: 'json', 'X-Tenant': 'acme' } })
    const r4 = await app.request('/x', { headers: { Accept: 'json', 'X-Tenant': 'globex' } })
    expect(await r3.text()).toBe('v1')
    expect(await r4.text()).toBe('v2')
  })

  it('no vary hint + no response Vary → single bare key for all requests', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.use('/x/*', cache({ store, wait: true }))
    let n = 0
    app.get('/x', (c) => c.text(`v${++n}`))

    const r1 = await app.request('/x', { headers: { Accept: 'json' } })
    const r2 = await app.request('/x', { headers: { Accept: 'html' } })
    const r3 = await app.request('/x', { headers: { 'X-Custom': 'anything' } })
    expect(await r1.text()).toBe('v1')
    // Without any vary, all requests share the same cache entry
    expect(await r2.text()).toBe('v1')
    expect(await r3.text()).toBe('v1')
  })
})
