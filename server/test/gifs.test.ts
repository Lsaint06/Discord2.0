/**
 * Milestone 13 GIF picker proxy: provider adapter (GIPHY mapping with a fake network), the
 * offline mock provider, caching, the shared provider budget, media streaming, SSRF guards and
 * configuration. No real provider is contacted.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { GiphyProvider, toGifItem } from '../src/gifs/giphy.js'
import { MockGifProvider } from '../src/gifs/mock.js'
import { fetchMediaOverHttps, type GifProvider } from '../src/gifs/provider.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { OpenMediaGate } from '../src/routes/gifs.js'
import type { ApiGifPage } from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const dir = mkdtempSync(join(tmpdir(), 'd2-gifs-'))
let counter = 0

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  base: string
  token: string
}

async function start(gifProvider: GifProvider | null, gifProviderCallsPerHour?: number): Promise<Server> {
  const n = ++counter
  const repo = new SqliteRepository(join(dir, `gifs-${n}.db`))
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH: 'true', LOG_LEVEL: 'silent', ATTACHMENTS_DIR: join(dir, `att-${n}`) })
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0,
    gifProvider,
    gifProviderCallsPerHour
  })
  for (const name of Object.keys(ctx.limiters) as (keyof AppContext['limiters'])[]) {
    ctx.limiters[name].dispose()
    ctx.limiters[name] = new TokenBucketLimiter(10_000, 1_000)
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const base = `http://127.0.0.1:${address.port}`
  const login = (await (await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gif_fan' }) })).json()) as { token: string }
  return { app, ctx, repo, base, token: login.token }
}

async function stop(s: Server): Promise<void> {
  await s.app.close()
  await s.repo.close()
}

const get = (s: Server, path: string, auth = true) =>
  fetch(`${s.base}${path}`, { headers: auth ? { Authorization: `${SCHEME} ${s.token}` } : {} })
const getAs = (s: Server, path: string, token: string) =>
  fetch(`${s.base}${path}`, { headers: { Authorization: `${SCHEME} ${token}` } })
const login = async (s: Server, username: string): Promise<string> =>
  (
    (await (
      await fetch(`${s.base}/api/dev/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      })
    ).json()) as { token: string }
  ).token

after(() => rmSync(dir, { recursive: true, force: true }))

// ======================================================================
describe('GIFs switched off (default)', () => {
  test('meta says so and the routes answer gifs_disabled', async () => {
    const s = await start(null)
    try {
      const meta = (await (await fetch(`${s.base}/api/meta`)).json()) as { gifs: unknown }
      assert.equal(meta.gifs, null)
      const res = await get(s, '/api/gifs/trending')
      assert.equal(res.status, 404)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'gifs_disabled')
      assert.equal((await get(s, '/api/gifs/trending', false)).status, 401)
    } finally {
      await stop(s)
    }
  })

  test('default configuration is off; giphy needs a key; mock is refused in production', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).gifs.provider, 'none')
    assert.throws(() => loadConfig({ NODE_ENV: 'test', GIF_PROVIDER: 'giphy' }), /GIF_API_KEY/)
    assert.throws(() => loadConfig({ NODE_ENV: 'test', GIF_PROVIDER: 'tenor' }), /GIF_PROVIDER/)
    assert.throws(() => loadConfig({ NODE_ENV: 'test', GIF_PROVIDER: 'giphy', GIF_API_KEY: 'bad key!' }), /format/)
    assert.throws(() => loadConfig({ NODE_ENV: 'test', GIF_RATING: 'nc-17' }), /GIF_RATING/)
    const giphy = loadConfig({ NODE_ENV: 'test', GIF_PROVIDER: 'giphy', GIF_API_KEY: 'abcdEFGH1234', GIF_COUNTRY: 'us' })
    assert.deepEqual(giphy.gifs, { provider: 'giphy', apiKey: 'abcdEFGH1234', rating: 'pg-13', country: 'US', locale: 'en' })
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          DEV_AUTH: 'false',
          GIF_PROVIDER: 'mock',
          TRUST_PROXY: 'loopback'
        }),
      /mock/
    )
  })
})

// ======================================================================
describe('GIF proxy with the offline provider', () => {
  test('trending and search pages, attribution, caching', async () => {
    const mock = new MockGifProvider()
    const s = await start(mock)
    try {
      const meta = (await (await fetch(`${s.base}/api/meta`)).json()) as { gifs: { provider: string } }
      assert.equal(meta.gifs.provider, 'mock')
      const first = (await (await get(s, '/api/gifs/trending')).json()) as ApiGifPage
      assert.equal(first.items.length, 24)
      assert.equal(first.next, 24)
      assert.equal(first.attribution.text, 'Test GIFs (offline)')
      assert.deepEqual(Object.keys(first.items[0]!).sort(), ['fullHeight', 'fullWidth', 'height', 'id', 'title', 'width'])
      const last = (await (await get(s, '/api/gifs/trending?offset=48')).json()) as ApiGifPage
      assert.equal(last.items.length, 12)
      assert.equal(last.next, null)
      const calls = mock.calls
      await get(s, '/api/gifs/trending')
      assert.equal(mock.calls, calls, 'served from the cache')

      const cats = (await (await get(s, '/api/gifs/search?q=%20CAT%20')).json()) as ApiGifPage
      assert.ok(cats.items.length > 0 && cats.items.every((g) => g.title.startsWith('cat')))
      await get(s, '/api/gifs/search?q=cat')
      assert.equal(mock.calls, calls + 1, 'same search (case/spacing) is cached')
      assert.equal((await get(s, '/api/gifs/search?q=')).status, 400)
      assert.equal((await get(s, `/api/gifs/search?q=${'x'.repeat(51)}`)).status, 400)
      assert.equal((await get(s, '/api/gifs/search?q=cat&offset=-1')).status, 400)
      assert.equal((await get(s, '/api/gifs/search?q=cat', false)).status, 401)
    } finally {
      await stop(s)
    }
  })

  test('media is streamed through the server; unknown or malformed ids are 404', async () => {
    const s = await start(new MockGifProvider())
    try {
      const page = (await (await get(s, '/api/gifs/trending')).json()) as ApiGifPage
      const id = page.items[0]!.id
      const res = await get(s, `/api/gifs/media/${id}?size=preview`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/webp')
      assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
      assert.ok((await res.arrayBuffer()).byteLength > 0)
      // Not seen in a listing yet: resolved through the provider by id.
      assert.equal((await get(s, '/api/gifs/media/mock-dog-49?size=full')).status, 200)
      assert.equal((await get(s, '/api/gifs/media/mock-dog-55?size=full')).status, 404, 'id must match')
      assert.equal((await get(s, '/api/gifs/media/mock-dog-999')).status, 404)
      assert.equal((await get(s, '/api/gifs/media/..%2F..%2Fetc')).status, 404)
      assert.equal((await get(s, `/api/gifs/media/${id}?size=huge`)).status, 400)
      assert.equal((await get(s, `/api/gifs/media/${id}`, false)).status, 401)
    } finally {
      await stop(s)
    }
  })

  test('the whole server shares the provider budget, and nobody can use it all up', async () => {
    const mock = new MockGifProvider()
    // A third each: 2 provider calls per person per hour.
    const s = await start(mock, 6)
    try {
      const [ann, bo, cy, di] = await Promise.all(['gif_ann', 'gif_bo', 'gif_cy', 'gif_di'].map((n) => login(s, n)))
      assert.equal((await getAs(s, '/api/gifs/search?q=a', ann)).status, 200)
      assert.equal((await getAs(s, '/api/gifs/search?q=b', ann)).status, 200)
      assert.equal((await getAs(s, '/api/gifs/search?q=c', ann)).status, 429, 'their share is used up')
      assert.equal((await getAs(s, '/api/gifs/search?q=a', ann)).status, 200, 'cached results are free')
      // An unknown id costs one lookup; the miss is remembered.
      const calls = mock.calls
      assert.equal((await getAs(s, '/api/gifs/media/mock-dog-999', bo)).status, 404)
      assert.equal((await getAs(s, '/api/gifs/media/mock-dog-999', bo)).status, 404)
      assert.equal(mock.calls, calls + 1, 'no second provider call for a known miss')
      assert.equal((await getAs(s, '/api/gifs/search?q=d', bo)).status, 200)
      assert.equal((await getAs(s, '/api/gifs/search?q=e', cy)).status, 200)
      assert.equal((await getAs(s, '/api/gifs/search?q=f', cy)).status, 200)
      // Six calls in all: the server-wide budget is spent, for everyone.
      const spent = await getAs(s, '/api/gifs/search?q=g', di)
      assert.equal(spent.status, 503)
      assert.equal(((await spent.json()) as { error: { code: string } }).error.code, 'gifs_busy')
      assert.equal((await getAs(s, '/api/gifs/search?q=a', di)).status, 200, 'cached results still work')
    } finally {
      await stop(s)
    }
  })

  test('media responses are counted while being sent and released when done', async () => {
    const s = await start(new MockGifProvider())
    try {
      const page = (await (await get(s, '/api/gifs/trending')).json()) as ApiGifPage
      // More than one person's limit of open responses, one after another.
      for (let i = 0; i < 20; i++) {
        const res = await get(s, `/api/gifs/media/${page.items[i]!.id}?size=preview`)
        assert.equal(res.status, 200)
        await res.arrayBuffer()
      }
    } finally {
      await stop(s)
    }
  })

  test('open media is bounded per person and in total bytes', () => {
    const gate = new OpenMediaGate(100, 2)
    const first = gate.open('ann', 40)!
    assert.ok(gate.open('ann', 40))
    assert.equal(gate.open('ann', 1), null, 'per person')
    assert.equal(gate.open('bo', 30), null, 'total bytes')
    assert.ok(gate.open('bo', 20))
    assert.deepEqual([gate.openBytes, gate.openResponses], [100, 3])
    first()
    first()
    assert.deepEqual([gate.openBytes, gate.openResponses], [60, 2], 'released once')
    assert.ok(gate.open('ann', 40))
  })
})

// ======================================================================
describe('GIPHY adapter (fake network)', () => {
  const image = (host: string, w = 200, h = 150) => ({
    url: `https://${host}/media/abc/200.gif`,
    webp: `https://${host}/media/abc/200.webp`,
    width: String(w),
    height: String(h),
    size: '12345'
  })
  const gif = (id: string, host = 'media1.giphy.com') => ({
    id,
    title: 'Happy dance GIF',
    images: {
      fixed_width: image(host),
      fixed_width_still: image(host),
      downsized_medium: image(host, 480, 360),
      original: image(host, 480, 360)
    }
  })

  test('maps GIF objects and drops anything off GIPHY’s media hosts', () => {
    const p = new GiphyProvider('key12345')
    const item = toGifItem(gif('abc123'), (u) => p.isMediaUrl(u))
    assert.equal(item?.preview.url, 'https://media1.giphy.com/media/abc/200.webp')
    assert.equal(item?.full.width, 480)
    assert.equal(toGifItem(gif('abc123', 'evil.example.com'), (u) => p.isMediaUrl(u)), null)
    assert.equal(toGifItem(gif('../x'), (u) => p.isMediaUrl(u)), null)
    assert.equal(p.isMediaUrl('http://media.giphy.com/a.gif'), false, 'https only')
    assert.equal(p.isMediaUrl('https://media.giphy.com.evil.com/a.gif'), false)
    assert.equal(p.isMediaUrl('https://user:pw@media.giphy.com/a.gif'), false)
    assert.equal(p.isMediaUrl('https://media.giphy.com:8443/a.gif'), false)
    assert.equal(p.isMediaUrl('https://i.giphy.com/a.webp'), true)
  })

  test('requests carry key, rating, country and paging; errors map cleanly', async () => {
    const seen: URL[] = []
    let status = 200
    const fake = (async (input: string | URL) => {
      const url = new URL(String(input))
      seen.push(url)
      if (status !== 200) return new Response('{}', { status })
      return new Response(
        JSON.stringify({ data: [gif('one'), gif('two', 'evil.example.com')], pagination: { total_count: 2, count: 2, offset: 0 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
    const p = new GiphyProvider('key12345', fake)
    const page = await p.search('dance', { limit: 24, offset: 0, rating: 'pg', locale: 'en', country: 'US', customerId: 'c'.repeat(32) })
    assert.deepEqual(page.items.map((g) => g.id), ['one'])
    assert.equal(page.next, null)
    const url = seen[0]!
    assert.equal(url.origin + url.pathname, 'https://api.giphy.com/v1/gifs/search')
    assert.equal(url.searchParams.get('api_key'), 'key12345')
    assert.equal(url.searchParams.get('q'), 'dance')
    assert.equal(url.searchParams.get('rating'), 'pg')
    assert.equal(url.searchParams.get('country_code'), 'US')
    assert.equal(url.searchParams.get('limit'), '24')

    // Through the server: the key never reaches the client.
    const s = await start(p)
    try {
      const res = await get(s, '/api/gifs/search?q=dance')
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.ok(!text.includes('key12345'))
      status = 429
      const busy = await get(s, '/api/gifs/search?q=other')
      assert.equal(busy.status, 503)
      status = 500
      assert.equal((await get(s, '/api/gifs/search?q=third')).status, 502)
    } finally {
      await stop(s)
    }
    await assert.rejects(p.fetchMedia('https://evil.example.com/x.gif', 1000), /Not a GIPHY media URL/)
  })

  test('media downloads are capped and type-checked', async () => {
    const respond = (body: Uint8Array, type: string, length?: number) =>
      (async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': type, ...(length ? { 'Content-Length': String(length) } : {}) }
        })) as unknown as typeof fetch
    const small = new Uint8Array([71, 73, 70, 56, 57, 97])
    const ok = await fetchMediaOverHttps('https://media.giphy.com/a.gif', 100, respond(small, 'image/gif'))
    assert.equal(ok.contentType, 'image/gif')
    await assert.rejects(fetchMediaOverHttps('https://media.giphy.com/a.gif', 100, respond(small, 'text/html')), /media type/)
    await assert.rejects(fetchMediaOverHttps('https://media.giphy.com/a.gif', 100, respond(small, 'image/gif', 5000)), /too large/)
    await assert.rejects(fetchMediaOverHttps('https://media.giphy.com/a.gif', 4, respond(small, 'image/gif')), /too large/)
  })
})
