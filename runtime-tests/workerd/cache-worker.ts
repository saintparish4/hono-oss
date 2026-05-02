import { Hono } from '../../src/hono'
import { cache } from '../../src/middleware/cache/index'

const counters = new Map<string, number>()
const bump = (name: string) => {
  const n = (counters.get(name) ?? 0) + 1
  counters.set(name, n)
  return n
}

const app = new Hono()

// Workers' Cache API behaves as a shared cache; miniflare locally enforces
// http-cache-semantics, which only stores responses with `public` or
// `s-maxage`. Setting it via the middleware keeps the assertions identical
// against the real edge cache too.
app.use(
  '/cached/*',
  cache({
    cacheName: 'workerd-cache-test',
    writeStrategy: 'await',
    cacheControl: 'public, max-age=60',
  })
)

app.get('/cached/data', (c) => {
  const n = bump('cached')
  return c.text(`invocation:${n}`)
})

app.use(
  '/no-store/*',
  cache({
    cacheName: 'workerd-cache-test',
    writeStrategy: 'await',
    cacheControl: 'public, max-age=60',
  })
)

app.get('/no-store/data', (c) => {
  const n = bump('no-store')
  c.header('Cache-Control', 'no-store')
  return c.text(`invocation:${n}`)
})

app.use(
  '/keyed/*',
  cache({
    cacheName: 'workerd-cache-test',
    writeStrategy: 'await',
    cacheControl: 'public, max-age=60',
    // Workers' Cache API requires keys to be valid URLs (it constructs a
    // Request internally). Strip the path variant so /keyed/a and /keyed/b
    // map to the same cache entry.
    keyGenerator: (c) => new URL('/keyed/shared', c.req.url).toString(),
  })
)

app.get('/keyed/:variant', (c) => {
  const n = bump('keyed')
  return c.text(`${c.req.param('variant')}:${n}`)
})

app.use(
  '/notfound/*',
  cache({
    cacheName: 'workerd-cache-test',
    writeStrategy: 'await',
    cacheControl: 'public, max-age=60',
  })
)

app.get('/notfound/data', (c) => {
  const n = bump('notfound')
  return c.text(`miss:${n}`, 404)
})

app.get('/counter/:name', (c) => {
  return c.text(`${counters.get(c.req.param('name')) ?? 0}`)
})

export default app
