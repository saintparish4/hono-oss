import { unstable_dev } from 'wrangler'
import type { Unstable_DevWorker } from 'wrangler'

describe('workerd cache middleware (CacheApi adapter)', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await unstable_dev('./runtime-tests/workerd/cache-worker.ts', {
      experimental: { disableExperimentalWarning: true },
    })
  })

  afterAll(async () => {
    await worker.stop()
  })

  const counter = async (name: string): Promise<number> => {
    const res = await worker.fetch(`/counter/${name}`)
    return Number(await res.text())
  }

  it('serves cached response on second hit and runs handler exactly once', async () => {
    const res1 = await worker.fetch('/cached/data')
    expect(res1.status).toBe(200)
    expect(res1.headers.get('cache-control')).toContain('max-age=60')
    const body1 = await res1.text()
    expect(body1).toBe('invocation:1')

    const res2 = await worker.fetch('/cached/data')
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe(body1)

    expect(await counter('cached')).toBe(1)
  })

  it('does not cache responses with Cache-Control: no-store', async () => {
    const res1 = await worker.fetch('/no-store/data')
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('invocation:1')

    const res2 = await worker.fetch('/no-store/data')
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe('invocation:2')

    expect(await counter('no-store')).toBe(2)
  })

  it('uses a custom keyGenerator so distinct URLs share a cache entry', async () => {
    const res1 = await worker.fetch('/keyed/a')
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('a:1')

    const res2 = await worker.fetch('/keyed/b')
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe('a:1')

    expect(await counter('keyed')).toBe(1)
  })

  it('does not cache non-cacheable status codes by default (404)', async () => {
    const res1 = await worker.fetch('/notfound/data')
    expect(res1.status).toBe(404)
    expect(await res1.text()).toBe('miss:1')

    const res2 = await worker.fetch('/notfound/data')
    expect(res2.status).toBe(404)
    expect(await res2.text()).toBe('miss:2')

    expect(await counter('notfound')).toBe(2)
  })
})
