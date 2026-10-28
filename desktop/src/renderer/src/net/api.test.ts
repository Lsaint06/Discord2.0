import { describe, expect, it } from 'vitest'
import { ApiError, errorFrom } from './api'

const response = (
  status: number,
  body: unknown,
  invalidJson = false
): { status: number; json: () => Promise<unknown> } => ({
  status,
  json: async (): Promise<unknown> => {
    if (invalidJson) throw new SyntaxError('Unexpected end of JSON input')
    return body
  }
})

describe('errorFrom', () => {
  it('reads the server’s error body', async () => {
    const err = await errorFrom(
      response(429, { error: { code: 'rate_limited', message: 'Slow down', retryAfterMs: 1500 } })
    )
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.code, err.message, err.retryAfterMs]).toEqual([
      429,
      'rate_limited',
      'Slow down',
      1500
    ])
  })

  it('never throws on empty, null or foreign bodies (proxies, crashes)', async () => {
    const odd = [
      // An XHR with responseType 'json' gives null for an empty or non-JSON body.
      response(502, null),
      response(502, undefined),
      response(502, 'Bad Gateway'),
      // Fastify's default error shape.
      response(500, { statusCode: 500, error: 'Internal Server Error', message: 'boom' }),
      response(503, undefined, true),
      response(500, { error: { code: 5, message: null, retryAfterMs: 'soon' } })
    ]
    for (const r of odd) {
      const err = await errorFrom(r)
      expect(err.status).toBe(r.status)
      expect(err.code).toBe('http_error')
      expect(err.message).toBe(`Request failed (${r.status})`)
      expect(err.retryAfterMs).toBeUndefined()
    }
  })
})
