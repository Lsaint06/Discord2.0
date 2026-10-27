import type {
  ApiAttachment,
  ApiErrorBody,
  ApiMessage,
  ApiReadState,
  ApiSearchResult,
  ApiServer,
  ApiUser,
  ApiVoiceToken
} from './protocol'

const REQUEST_TIMEOUT_MS = 10_000
const AUTH_SCHEME = 'Bearer'

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

/** The upload was cancelled by the user. */
export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'AbortError'
  }
}

export interface ServerMeta {
  name: string
  apiVersion: number
  devAuth: boolean
  voice?: boolean
}

export interface SendMessageBody {
  content: string
  nonce: string
  replyToId?: string
  attachmentIds?: string[]
}

export interface SearchParams {
  q?: string
  channelId?: string
  serverId?: string
  authorId?: string
  /** YYYY-MM-DD */
  since?: string
  until?: string
  before?: string
  limit?: number
}

async function errorFrom(res: { status: number; json: () => Promise<unknown> }): Promise<ApiError> {
  let payload: Partial<ApiErrorBody> = {}
  try {
    payload = (await res.json()) as ApiErrorBody
  } catch {
    // Non-JSON error body.
  }
  return new ApiError(
    res.status,
    payload.error?.code ?? 'http_error',
    payload.error?.message ?? `Request failed (${res.status})`,
    payload.error?.retryAfterMs
  )
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null
  ) {}

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `${AUTH_SCHEME} ${this.token}` } : {}
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...this.authHeaders()
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

    if (!res.ok) throw await errorFrom(res)
    if (res.status === 204) return undefined as T
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

  // ---- Messages ----

  messages(
    channelId: string,
    page: { before?: string; after?: string; around?: string; limit?: number } = {}
  ): Promise<ApiMessage[]> {
    const qs = new URLSearchParams()
    if (page.before) qs.set('before', page.before)
    if (page.after) qs.set('after', page.after)
    if (page.around) qs.set('around', page.around)
    if (page.limit) qs.set('limit', String(page.limit))
    const query = qs.size > 0 ? `?${qs}` : ''
    return this.request('GET', `/api/channels/${encodeURIComponent(channelId)}/messages${query}`)
  }

  sendMessage(channelId: string, body: SendMessageBody): Promise<ApiMessage> {
    return this.request('POST', `/api/channels/${encodeURIComponent(channelId)}/messages`, body)
  }

  editMessage(
    channelId: string,
    messageId: string,
    content: string,
    expectedEditedAt: number | null
  ): Promise<ApiMessage> {
    return this.request(
      'PATCH',
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { content, expectedEditedAt }
    )
  }

  deleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`
    )
  }

  setReaction(channelId: string, messageId: string, emoji: string, add: boolean): Promise<unknown> {
    return this.request(
      add ? 'PUT' : 'DELETE',
      `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`
    )
  }

  pins(channelId: string): Promise<ApiMessage[]> {
    return this.request('GET', `/api/channels/${encodeURIComponent(channelId)}/pins`)
  }

  setPinned(channelId: string, messageId: string, pinned: boolean): Promise<unknown> {
    return this.request(
      pinned ? 'PUT' : 'DELETE',
      `/api/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`
    )
  }

  readStates(): Promise<ApiReadState[]> {
    return this.request('GET', '/api/read-states')
  }

  markRead(channelId: string, messageId: string): Promise<{ lastReadId: string }> {
    return this.request('PUT', `/api/channels/${encodeURIComponent(channelId)}/read`, {
      messageId
    })
  }

  search(params: SearchParams): Promise<ApiSearchResult> {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') qs.set(key, String(value))
    }
    return this.request('GET', `/api/search?${qs}`)
  }

  // ---- Attachments ----

  /**
   * Uploads one file (XMLHttpRequest, because fetch has no upload progress). Resolves with the
   * stored (not yet sent) attachment; it is attached to a message by sending its id.
   */
  uploadAttachment(
    channelId: string,
    file: Blob,
    filename: string,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
  ): Promise<ApiAttachment> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${this.baseUrl}/api/channels/${encodeURIComponent(channelId)}/attachments`)
      for (const [k, v] of Object.entries(this.authHeaders())) xhr.setRequestHeader(k, v)
      xhr.responseType = 'json'
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) options.onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const list = xhr.response as ApiAttachment[] | null
          if (list?.[0]) resolve(list[0])
          else reject(new ApiError(xhr.status, 'bad_response', 'Unexpected upload response.'))
          return
        }
        void errorFrom({ status: xhr.status, json: async () => xhr.response }).then(reject)
      }
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the server.'))
      xhr.onabort = () => reject(new UploadAbortedError())
      if (options.signal) {
        if (options.signal.aborted) return reject(new UploadAbortedError())
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      const form = new FormData()
      form.append('file', file, filename)
      xhr.send(form)
    })
  }

  /** Removes an uploaded attachment that hasn't been sent. */
  deleteAttachment(attachmentId: string): Promise<void> {
    return this.request('DELETE', `/api/attachments/${encodeURIComponent(attachmentId)}`)
  }

  /** Downloads an attachment with the session token (attachments are never public URLs). */
  async fetchAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`, {
        headers: this.authHeaders(),
        signal
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  }

  /** Short-lived LiveKit credentials for one voice channel (minted server-side). */
  voiceToken(channelId: string): Promise<ApiVoiceToken> {
    return this.request('POST', `/api/voice/channels/${encodeURIComponent(channelId)}/token`)
  }
}
