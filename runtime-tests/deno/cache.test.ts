import { assertEquals, assertNotEquals } from '@std/assert'
import type { Context } from '../../src/context.ts'
import { cacheApi } from '../../src/middleware/cache/adapters/cache-api.ts'
import { memoryStore } from '../../src/middleware/cache/adapters/memory.ts'
import type { Envelope, KVLike } from '../../src/middleware/cache/types.ts'

const env = (status: number, body: string, headers: Record<string, string> = {}): Envelope => ({
  status,
  headers: { 'content-type': 'text/plain', ...headers },
  body: new TextEncoder().encode(body),
})

const readBody = async (r: Response | Envelope): Promise<string> => {
  if (r instanceof Response) {
    return r.text()
  }
  return new TextDecoder().decode(r.body)
}

async function runContract(name: string, factory: () => Promise<KVLike> | KVLike) {
  const makeStore = async () => await factory()

  Deno.test(`${name}: get returns null for missing keys`, async () => {
    const store = await makeStore()
    assertEquals(await store.get('missing'), null)
  })

  Deno.test(`${name}: set then get round-trips`, async () => {
    const store = await makeStore()
    await store.set('k1', env(200, 'hello'), {})
    const got = await store.get('k1')
    assertNotEquals(got, null)
    assertEquals(await readBody(got!), 'hello')
  })

  Deno.test(`${name}: delete removes a key`, async () => {
    const store = await makeStore()
    await store.set('k1', env(200, 'x'), {})
    await store.delete('k1')
    assertEquals(await store.get('k1'), null)
  })

  Deno.test(`${name}: set is overwrite-by-key`, async () => {
    const store = await makeStore()
    await store.set('k1', env(200, 'first'), {})
    await store.set('k1', env(200, 'second'), {})
    const got = await store.get('k1')
    assertEquals(await readBody(got!), 'second')
  })

  Deno.test(`${name}: preserves status and headers`, async () => {
    const store = await makeStore()
    await store.set('k1', env(201, 'created', { 'x-custom': 'y' }), {})
    const got = await store.get('k1')
    if (got instanceof Response) {
      assertEquals(got.status, 201)
      assertEquals(got.headers.get('x-custom'), 'y')
      // Drain the body so the underlying CacheResponseResource is released
      // (Deno's resource-leak detector requires this).
      await got.body?.cancel()
    } else {
      assertEquals(got!.status, 201)
      assertEquals(got!.headers['x-custom'], 'y')
    }
  })
}

const fakeCtx = {} as Context

runContract('cacheApi (Deno caches)', async () => {
  const factory = cacheApi({ cacheName: `deno-contract-${crypto.randomUUID()}` })
  return factory(fakeCtx)
})

runContract('memoryStore', () => memoryStore())
