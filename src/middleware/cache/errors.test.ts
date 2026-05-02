import type { ExecutionContext } from '../../context'
import { Hono } from '../../hono'
import { cache } from '.'
import type { Envelope, KVLike, SetOptions, StoreOp } from './types'

const noopEnv = (): Envelope => ({
  status: 200,
  headers: {},
  body: new Uint8Array(),
})

class FaultInjectingStore implements KVLike {
  private failures = new Map<StoreOp, number>()
  public calls: Array<{ op: StoreOp; key: string }> = []

  failOnce(op: StoreOp): this {
    this.failures.set(op, (this.failures.get(op) ?? 0) + 1)
    return this
  }

  private maybeThrow(op: StoreOp) {
    const remaining = this.failures.get(op)
    if (remaining && remaining > 0) {
      this.failures.set(op, remaining - 1)
      throw new Error(`fault: ${op}`)
    }
  }

  async get(key: string) {
    this.calls.push({ op: 'get', key })
    this.maybeThrow('get')
    return null
  }
  async set(key: string, _env: Envelope, _o: SetOptions) {
    this.calls.push({ op: 'set', key })
    this.maybeThrow('set')
  }
  async delete(key: string) {
    this.calls.push({ op: 'delete', key })
    this.maybeThrow('delete')
  }
}

describe('Cache middleware - store error handling', () => {
  it('get throws -> handler runs, hook called once with op=get', async () => {
    const store = new FaultInjectingStore().failOnce('get')
    const onStoreError = vi.fn()
    const app = new Hono()
    app.use('/x', cache({ store, onStoreError, wait: true }))
    app.get('/x', (c) => c.text('handler-ran'))
    const res = await app.request('/x')
    expect(await res.text()).toBe('handler-ran')
    expect(onStoreError).toHaveBeenCalledTimes(1)
    expect(onStoreError.mock.calls[0][1]).toBe('get')
  })

  it('set throws (await mode) -> response served, hook called', async () => {
    const store = new FaultInjectingStore().failOnce('set')
    const onStoreError = vi.fn()
    const app = new Hono()
    app.use('/x', cache({ store, onStoreError, wait: true }))
    app.get('/x', (c) => c.text('ok'))
    const res = await app.request('/x')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(onStoreError).toHaveBeenCalledWith(
      expect.any(Error),
      'set',
      expect.any(String),
      expect.anything()
    )
  })

  it('set throws (background mode) -> no unhandled rejection', async () => {
    const unhandled = vi.fn()
    if (typeof process !== 'undefined') {
      process.on('unhandledRejection', unhandled)
    }
    const store = new FaultInjectingStore().failOnce('set')
    const onStoreError = vi.fn()
    const app = new Hono()
    app.use('/x', cache({ store, onStoreError /* default writeStrategy */ }))
    app.get('/x', (c) => c.text('ok'))
    await app.fetch(new Request('http://x/x'), undefined, {
      waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)
    await new Promise((r) => setImmediate(r))
    expect(unhandled).not.toHaveBeenCalled()
    expect(onStoreError).toHaveBeenCalled()
    if (typeof process !== 'undefined') {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('onStoreError: false suppresses default warn', async () => {
    const store = new FaultInjectingStore().failOnce('get')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    app.use('/x', cache({ store, onStoreError: false, wait: true }))
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('quota-style errors pass through to hook unchanged', async () => {
    class QuotaExceededError extends Error {
      override name = 'QuotaExceededError'
    }
    const store: KVLike = {
      async get() {
        return null
      },
      async set() {
        throw new QuotaExceededError('quota')
      },
      async delete() {},
    }
    const onStoreError = vi.fn()
    const app = new Hono()
    app.use('/x', cache({ store, onStoreError, wait: true }))
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(onStoreError.mock.calls[0][0]).toBeInstanceOf(QuotaExceededError)
  })
})
