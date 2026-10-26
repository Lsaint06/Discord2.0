import type { ApiErrorBody, ApiMessage, ApiServer, ApiUser } from './protocol'

const REQUEST_TIMEOUT_MS = 10_000

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }

  get isNetwork(): boolean {
    return this.status === 0
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

export interface ServerMeta {
  name: string
  apiVersion: number
  devAuth: boolean
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      throw new ApiError(
        0,
        'network_error',
        timedOut ? 'The server took too long to respond.' : 'Cannot reach the server.'
      )
    }

    if (!res.ok) {
      let payload: Partial<ApiErrorBody> = {}
      try {
        payload = (await res.json()) as ApiErrorBody
      } catch {
        // Non-JSON error body.
      }
      throw new ApiError(
        res.status,
        payload.error?.code ?? 'http_error',
        payload.error?.message ?? `Request failed (${res.status})`,
        payload.error?.retryAfterMs
      )
    }
    return (await res.json()) as T
  }

  meta(): Promise<ServerMeta> {
    return this.request('GET', '/api/meta')
  }

  devLogin(username: string): Promise<{ token: string; user: ApiUser }> {
    return this.request('POST', '/api/dev/login', { username })
  }

  me(): Promise<ApiUser> {
    return this.request('GET', '/api/users/me')
  }

  users(): Promise<ApiUser[]> {
    return this.request('GET', '/api/users')
  }

  updateMe(patch: { displayName?: string; avatarColor?: string }): Promise<ApiUser> {
    return this.request('PATCH', '/api/users/me', patch)
  }

  servers(): Promise<ApiServer[]> {
    return this.request('GET', '/api/servers')
  }

  createServer(name: string, color: string): Promise<ApiServer> {
    return this.request('POST', '/api/servers', { name, color })
  }

  messages(
    channelId: string,
    page: { before?: string; after?: string; limit?: number } = {}
  ): Promise<ApiMessage[]> {
    const qs = new URLSearchParams()
    if (page.before) qs.set('before', page.before)
    if (page.after) qs.set('after', page.after)
    if (page.limit) qs.set('limit', String(page.limit))
    const query = qs.size > 0 ? `?${qs}` : ''
    return this.request('GET', `/api/channels/${encodeURIComponent(channelId)}/messages${query}`)
  }

  sendMessage(channelId: string, content: string, nonce: string): Promise<ApiMessage> {
    return this.request('POST', `/api/channels/${encodeURIComponent(channelId)}/messages`, {
      content,
      nonce
    })
  }
}
