import { describe, it, expect, beforeEach } from 'bun:test'
import type { Envelope, KVLike } from '../../src/middleware/cache/types'
import { memoryStore } from '../../src/middleware/cache/adapters/memory'

const env = (status: number, body: string, headers: Record<string, string> = {}): Envelope => ({
  status,
  headers: { 'content-type': 'text/plain', ...headers },
  body: new TextEncoder().encode(body),
})

const readBody = (r: Response | Envelope): string => {
  if (r instanceof Response) {
    throw new Error('unexpected Response from memoryStore')
  }
  return new TextDecoder().decode(r.body)
}

describe('KVLike contract: memoryStore (bun)', () => {
  let store: KVLike
  beforeEach(() => {
    store = memoryStore()
  })

  it('get returns null for missing keys', async () => {
    expect(await store.get('missing')).toBeNull()
  })

  it('set then get round-trips', async () => {
    await store.set('k1', env(200, 'hello'), {})
    const got = await store.get('k1')
    expect(got).not.toBeNull()
    expect(readBody(got!)).toBe('hello')
  })

  it('delete removes a key', async () => {
    await store.set('k1', env(200, 'x'), {})
    await store.delete('k1')
    expect(await store.get('k1')).toBeNull()
  })

  it('set is overwrite-by-key', async () => {
    await store.set('k1', env(200, 'first'), {})
    await store.set('k1', env(200, 'second'), {})
    const got = await store.get('k1')
    expect(readBody(got!)).toBe('second')
  })

  it('preserves status and headers', async () => {
    await store.set('k1', env(201, 'created', { 'x-custom': 'y' }), {})
    const got = await store.get('k1')
    expect(got).not.toBeNull()
    expect(got).not.toBeInstanceOf(Response)
    const envelope = got as Envelope
    expect(envelope.status).toBe(201)
    expect(envelope.headers['x-custom']).toBe('y')
  })
})
