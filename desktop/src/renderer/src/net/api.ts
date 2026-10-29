import type {
  ApiAccount,
  ApiAccountEmail,
  ApiAttachment,
  ApiAuditEvent,
  ApiAuthResult,
  ApiBan,
  ApiChannel,
  ApiChannelOverride,
  ApiConversation,
  ApiConversationEvent,
  ApiEmailSent,
  ApiErrorBody,
  ApiGifPage,
  ApiInvitePreview,
  ApiLegacyIdentity,
  ApiMe,
  ApiMember,
  ApiMessage,
  ApiPreferences,
  ApiProfile,
  ApiProfileStyle,
  ApiReadState,
  ApiRegistrationInvite,
  ApiRelationship,
  ApiRolePermissions,
  ApiSavedMessage,
  ApiSearchResult,
  ApiServer,
  ApiServerInvite,
  ApiSession,
  ApiSoundboardSound,
  ApiUser,
  ApiUserNote,
  ApiUploadSession,
  ApiVoiceToken,
  ConfigurableRole,
  NotificationLevel,
  ProfileImageKind,
  SelectableStatus
} from './protocol'

export interface ProfilePatch {
  displayName?: string
  avatarColor?: string
  bio?: string | null
  pronouns?: string | null
  accentColor?: string | null
  /** Milestone 14 (API 6 servers only). */
  profileStyle?: ApiProfileStyle | null
}

export interface CustomStatusInput {
  text: string | null
  emoji: string | null
  /** Relative, so client clock skew doesn't matter; null = until cleared. */
  expiresInMs: number | null
}

export type PreferencesPatch = Partial<Omit<ApiPreferences, 'updatedAt'>>

export type InviteInfo =
  | { kind: 'register'; serverName: string | null }
  | { kind: 'claim'; username: string; displayName: string }

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
  /** Milestone 7+: password accounts exist. */
  accounts?: boolean
  /** Who may create accounts (Milestone 13 adds 'open' and 'closed'; older servers: 'invite'). */
  registration?: RegistrationMode
  /** Milestone 13+: email sign-up / confirmation / reset endpoints exist. */
  emailAccounts?: boolean
  /** Milestone 13+: this server can send email (password reset by email works). */
  email?: boolean
  /** Milestone 8+: profiles, presence preferences, profile images. */
  profiles?: boolean
  /** Milestone 10+: friends, blocking, direct and group conversations. */
  connections?: boolean
  /** Milestone 13+ (API 5): server icons/descriptions, layout, user limits, timeouts. */
  serverAdmin?: boolean
  /** Milestone 14+ (API 6): profile styles, animated pictures/banners, synced app theme. */
  customization?: boolean
  /** Milestone 14+: private saved messages (bookmarks). */
  savedMessages?: boolean
  /** Milestone 14+: private notes about people. */
  userNotes?: boolean
  /** Milestone 14.5: voice tokens may publish a camera (Video permission). */
  camera?: boolean
  /** Milestone 13+: GIF picker through the server (null/absent = not set up). */
  gifs?: { provider: string; attribution: { text: string; url: string } } | null
  /** Milestone 13+: chunked uploads of large files (null/absent = off). */
  largeFiles?: LargeFileSupport | null
}

export interface LargeFileSupport {
  maxBytes: number
  /** Files strictly larger than this are deleted `ephemeralMs` after the upload completes. */
  ephemeralThresholdBytes: number
  ephemeralMs: number
  chunkBytes: number
  /** Files up to this size use the normal (one-request) upload. */
  normalMaxBytes: number
}

export type RegistrationMode = 'invite' | 'open' | 'closed'

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

/**
 * The ApiError for a failed response. Never throws: proxies and crashes can answer with an
 * empty or non-JSON body (null from an XHR with responseType 'json'), and some errors use
 * other shapes (Fastify's default body has `error` as a string).
 */
export async function errorFrom(res: {
  status: number
  json: () => Promise<unknown>
}): Promise<ApiError> {
  let error: Partial<ApiErrorBody['error']> = {}
  try {
    const body = (await res.json()) as { error?: unknown } | null
    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      error = body.error as Partial<ApiErrorBody['error']>
    }
  } catch {
    // Non-JSON error body.
  }
  return new ApiError(
    res.status,
    typeof error.code === 'string' ? error.code : 'http_error',
    typeof error.message === 'string' ? error.message : `Request failed (${res.status})`,
    typeof error.retryAfterMs === 'number' ? error.retryAfterMs : undefined
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...this.authHeaders()
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      throw new ApiError(
        0,
        timedOut ? 'timeout' : 'network_error',
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

  devLogin(username: string, device?: string): Promise<ApiAuthResult & { devOnly: true }> {
    return this.request('POST', '/api/dev/login', { username, ...(device ? { device } : {}) })
  }

  // ---- Accounts and sessions ----

  login(username: string, password: string, device?: string): Promise<ApiAuthResult> {
    return this.request('POST', '/api/auth/login', {
      username,
      password,
      ...(device ? { device } : {})
    })
  }

  inviteInfo(code: string): Promise<InviteInfo> {
    return this.request('POST', '/api/auth/invite-info', { code })
  }

  register(body: {
    code: string
    username?: string
    displayName?: string
    password: string
    device?: string
  }): Promise<ApiAuthResult> {
    return this.request('POST', '/api/auth/register', body)
  }

  recover(body: {
    username: string
    code: string
    newPassword: string
    device?: string
  }): Promise<ApiAuthResult & { recoveryCodesRemaining: number }> {
    return this.request('POST', '/api/auth/recover', body)
  }

  logout(): Promise<void> {
    return this.request('POST', '/api/auth/logout')
  }

  logoutAll(keepCurrent: boolean): Promise<{ revoked: number }> {
    return this.request('POST', '/api/auth/logout-all', { keepCurrent })
  }

  sessions(): Promise<ApiSession[]> {
    return this.request('GET', '/api/auth/sessions')
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.request('DELETE', `/api/auth/sessions/${encodeURIComponent(sessionId)}`)
  }

  changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ otherSessionsRevoked: number }> {
    return this.request('POST', '/api/auth/password', { currentPassword, newPassword })
  }

  recoveryCodeCount(): Promise<{ remaining: number }> {
    return this.request('GET', '/api/auth/recovery-codes')
  }

  regenerateRecoveryCodes(password: string): Promise<{ codes: string[] }> {
    return this.request('POST', '/api/auth/recovery-codes', { password })
  }

  // ---- Email accounts (Milestone 13) ----

  /** Self-registration (servers with registration 'open'): a code is emailed. */
  signup(body: {
    email: string
    username: string
    displayName?: string
    password: string
  }): Promise<ApiEmailSent> {
    return this.request('POST', '/api/auth/signup', body)
  }

  /** Confirms a new account's address (login = username or address) and signs in. */
  verifyEmail(body: {
    login: string
    password: string
    code: string
    device?: string
  }): Promise<ApiAuthResult> {
    return this.request('POST', '/api/auth/verify-email', body)
  }

  resendVerification(login: string, password: string): Promise<ApiEmailSent> {
    return this.request('POST', '/api/auth/resend-verification', { login, password })
  }

  forgotPassword(email: string): Promise<ApiEmailSent> {
    return this.request('POST', '/api/auth/forgot-password', { email })
  }

  resetPassword(body: {
    email: string
    code: string
    newPassword: string
    device?: string
  }): Promise<ApiAuthResult> {
    return this.request('POST', '/api/auth/reset-password', body)
  }

  accountEmail(): Promise<ApiAccountEmail> {
    return this.request('GET', '/api/auth/email')
  }

  requestEmailChange(email: string, password: string): Promise<ApiEmailSent> {
    return this.request('POST', '/api/auth/email', { email, password })
  }

  confirmEmailChange(code: string): Promise<ApiAccountEmail> {
    return this.request('POST', '/api/auth/email/verify', { code })
  }

  removeEmail(password: string): Promise<ApiAccountEmail> {
    return this.request('POST', '/api/auth/email/remove', { password })
  }

  // ---- Instance administration ----

  adminAccounts(): Promise<ApiAccount[]> {
    return this.request('GET', '/api/admin/accounts')
  }

  adminRegistrationInvites(): Promise<ApiRegistrationInvite[]> {
    return this.request('GET', '/api/admin/registration-invites')
  }

  adminCreateRegistrationInvite(body: {
    password: string
    expiresInHours?: number
    note?: string
    serverId?: string | null
  }): Promise<ApiRegistrationInvite> {
    return this.request('POST', '/api/admin/registration-invites', body)
  }

  adminRevokeRegistrationInvite(id: string): Promise<void> {
    return this.request('DELETE', `/api/admin/registration-invites/${encodeURIComponent(id)}`)
  }

  adminLegacy(): Promise<ApiLegacyIdentity[]> {
    return this.request('GET', '/api/admin/legacy')
  }

  adminClaimCode(userId: string, password: string): Promise<ApiRegistrationInvite> {
    return this.request('POST', `/api/admin/legacy/${encodeURIComponent(userId)}/claim-code`, {
      password
    })
  }

  adminResetCode(
    userId: string,
    password: string
  ): Promise<{ code: string; expiresInHours: number }> {
    return this.request('POST', `/api/admin/accounts/${encodeURIComponent(userId)}/reset-code`, {
      password
    })
  }

  adminSetDisabled(
    userId: string,
    disabled: boolean,
    password: string
  ): Promise<{ disabled: boolean }> {
    return this.request('POST', `/api/admin/accounts/${encodeURIComponent(userId)}/disabled`, {
      disabled,
      password
    })
  }

  adminAudit(before?: string): Promise<(ApiAuditEvent & { ip: string | null })[]> {
    return this.request(
      'GET',
      `/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ''}`
    )
  }

  me(): Promise<ApiMe> {
    return this.request('GET', '/api/users/me')
  }

  users(): Promise<ApiUser[]> {
    return this.request('GET', '/api/users')
  }

  updateMe(patch: ProfilePatch): Promise<ApiMe> {
    return this.request('PATCH', '/api/users/me', patch)
  }

  // ---- Profiles, status and preferences (Milestone 8) ----

  setStatus(body: {
    status?: SelectableStatus
    customStatus?: CustomStatusInput | null
  }): Promise<ApiMe> {
    return this.request('PUT', '/api/users/me/status', body)
  }

  profile(userId: string): Promise<ApiProfile> {
    return this.request('GET', `/api/users/${encodeURIComponent(userId)}/profile`)
  }

  preferences(): Promise<ApiPreferences> {
    return this.request('GET', '/api/users/me/preferences')
  }

  updatePreferences(patch: PreferencesPatch): Promise<ApiPreferences> {
    return this.request('PATCH', '/api/users/me/preferences', patch)
  }

  /** Uploads a (cropped) profile picture or banner; the server re-encodes it. */
  uploadProfileImage(
    kind: ProfileImageKind,
    image: Blob,
    options: {
      onProgress?: (fraction: number) => void
      /** Milestone 14: crop of an animated original (whole source pixels). */
      crop?: { left: number; top: number; width: number; height: number }
    } = {}
  ): Promise<ApiMe> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${this.baseUrl}/api/users/me/${kind}`)
      for (const [k, v] of Object.entries(this.authHeaders())) xhr.setRequestHeader(k, v)
      xhr.responseType = 'json'
      xhr.timeout = 60_000
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) options.onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as ApiMe)
        void errorFrom({ status: xhr.status, json: async () => xhr.response }).then(reject)
      }
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the server.'))
      xhr.ontimeout = () =>
        reject(new ApiError(0, 'network_error', 'The upload took too long. Try again.'))
      const form = new FormData()
      if (options.crop) {
        // Text fields first; the server reads them with the file.
        form.append('cropLeft', String(Math.round(options.crop.left)))
        form.append('cropTop', String(Math.round(options.crop.top)))
        form.append('cropWidth', String(Math.round(options.crop.width)))
        form.append('cropHeight', String(Math.round(options.crop.height)))
      }
      const extension = image.type === 'image/gif' ? 'gif' : 'webp'
      form.append('file', image, `${kind}.${extension}`)
      xhr.send(form)
    })
  }

  removeProfileImage(kind: ProfileImageKind): Promise<ApiMe> {
    return this.request('DELETE', `/api/users/me/${kind}`)
  }

  /** Instance administrators: remove someone's inappropriate picture or banner. */
  adminRemoveProfileImage(userId: string, kind: ProfileImageKind): Promise<void> {
    return this.request(
      'DELETE',
      `/api/admin/accounts/${encodeURIComponent(userId)}/profile-media/${kind}`
    )
  }

  /** Profile pictures/banners are fetched with the session token (never public URLs). */
  async fetchProfileMedia(mediaId: string, size: 'full' | 'small' | 'still'): Promise<Blob> {
    let res: Response
    try {
      res = await fetch(
        `${this.baseUrl}/api/profile-media/${encodeURIComponent(mediaId)}?size=${size}`,
        { headers: this.authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) }
      )
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  }

  // ---- Soundboard (Milestone 14, API 6 servers) ----

  listSoundboard(serverId: string): Promise<ApiSoundboardSound[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/soundboard`)
  }

  /** Adds a clip (16-bit PCM WAV; see chat/wav.ts). */
  async uploadSoundboard(
    serverId: string,
    clip: { name: string; emoji: string | null; wav: Blob }
  ): Promise<ApiSoundboardSound> {
    const form = new FormData()
    form.append('name', clip.name)
    if (clip.emoji) form.append('emoji', clip.emoji)
    form.append('file', clip.wav, 'sound.wav')
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${encodeURIComponent(serverId)}/soundboard`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3)
      })
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return (await res.json()) as ApiSoundboardSound
  }

  deleteSoundboard(soundId: string): Promise<void> {
    return this.request('DELETE', `/api/soundboard/${encodeURIComponent(soundId)}`)
  }

  /** Plays a clip in your current voice channel (the server checks you're there). */
  playSoundboard(soundId: string): Promise<void> {
    return this.request('POST', `/api/soundboard/${encodeURIComponent(soundId)}/play`)
  }

  async fetchSoundboardAudio(soundId: string): Promise<ArrayBuffer> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/soundboard/${encodeURIComponent(soundId)}/audio`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2)
      })
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return res.arrayBuffer()
  }

  servers(): Promise<ApiServer[]> {
    return this.request('GET', '/api/servers')
  }

  createServer(name: string, color: string): Promise<ApiServer> {
    return this.request('POST', '/api/servers', { name, color })
  }

  // ---- Server management ----

  updateServer(
    serverId: string,
    patch: {
      name?: string
      color?: string
      description?: string | null
      defaultNotifications?: NotificationLevel
    }
  ): Promise<ApiServer> {
    return this.request('PATCH', `/api/servers/${encodeURIComponent(serverId)}`, patch)
  }

  /** Uploads a server icon (Manage Server); the server re-encodes it to a square WebP. */
  async uploadServerIcon(serverId: string, image: Blob): Promise<ApiServer> {
    const form = new FormData()
    form.append('file', image, 'icon.png')
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/servers/${encodeURIComponent(serverId)}/icon`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: AbortSignal.timeout(60_000)
      })
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return (await res.json()) as ApiServer
  }

  removeServerIcon(serverId: string): Promise<ApiServer> {
    return this.request('DELETE', `/api/servers/${encodeURIComponent(serverId)}/icon`)
  }

  /** Server icons are fetched with the session token (members only). */
  async fetchServerIcon(iconId: string, size: 'full' | 'small'): Promise<Blob> {
    let res: Response
    try {
      res = await fetch(
        `${this.baseUrl}/api/server-icons/${encodeURIComponent(iconId)}?size=${size}`,
        { headers: this.authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) }
      )
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  }

  // ---- GIF picker (proxied by the server; null provider = not set up) ----

  gifTrending(offset = 0): Promise<ApiGifPage> {
    return this.request('GET', `/api/gifs/trending?offset=${offset}`)
  }

  gifSearch(query: string, offset = 0): Promise<ApiGifPage> {
    return this.request('GET', `/api/gifs/search?q=${encodeURIComponent(query)}&offset=${offset}`)
  }

  async fetchGifMedia(id: string, size: 'preview' | 'still' | 'full'): Promise<Blob> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/gifs/media/${encodeURIComponent(id)}?size=${size}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3)
      })
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the server.')
    }
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  }

  /** Every channel you can see, in the new order, each with its category. */
  arrangeChannels(
    serverId: string,
    channels: { id: string; category: string }[]
  ): Promise<ApiServer> {
    return this.request('PUT', `/api/servers/${encodeURIComponent(serverId)}/layout`, {
      channels
    })
  }

  /** minutes null lifts the timeout. */
  setMemberTimeout(
    serverId: string,
    userId: string,
    minutes: number | null,
    reason?: string
  ): Promise<ApiMember> {
    return this.request(
      'PUT',
      `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/timeout`,
      reason ? { minutes, reason } : { minutes }
    )
  }

  members(serverId: string): Promise<ApiMember[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/members`)
  }

  setMemberRole(serverId: string, userId: string, role: ConfigurableRole): Promise<ApiMember> {
    return this.request(
      'PATCH',
      `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`,
      { role }
    )
  }

  kickMember(serverId: string, userId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`
    )
  }

  leaveServer(serverId: string): Promise<void> {
    return this.request('POST', `/api/servers/${encodeURIComponent(serverId)}/leave`)
  }

  bans(serverId: string): Promise<ApiBan[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/bans`)
  }

  banMember(serverId: string, userId: string, reason?: string): Promise<unknown> {
    return this.request(
      'PUT',
      `/api/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(userId)}`,
      reason ? { reason } : {}
    )
  }

  unbanMember(serverId: string, userId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(userId)}`
    )
  }

  roles(serverId: string): Promise<ApiRolePermissions[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/roles`)
  }

  setRolePermissions(
    serverId: string,
    role: ConfigurableRole,
    permissions: number | null
  ): Promise<ApiRolePermissions> {
    return this.request(
      'PUT',
      `/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(role)}`,
      { permissions }
    )
  }

  transferOwnership(serverId: string, userId: string, password: string): Promise<unknown> {
    return this.request('POST', `/api/servers/${encodeURIComponent(serverId)}/transfer`, {
      userId,
      password
    })
  }

  createChannel(
    serverId: string,
    body: { name: string; type: 'text' | 'voice'; topic?: string | null; category?: string }
  ): Promise<ApiChannel> {
    return this.request('POST', `/api/servers/${encodeURIComponent(serverId)}/channels`, body)
  }

  updateChannel(
    channelId: string,
    patch: { name?: string; topic?: string | null; userLimit?: number }
  ): Promise<ApiChannel> {
    return this.request('PATCH', `/api/channels/${encodeURIComponent(channelId)}`, patch)
  }

  deleteChannel(channelId: string): Promise<void> {
    return this.request('DELETE', `/api/channels/${encodeURIComponent(channelId)}`)
  }

  channelOverrides(channelId: string): Promise<ApiChannelOverride[]> {
    return this.request('GET', `/api/channels/${encodeURIComponent(channelId)}/overrides`)
  }

  setChannelOverride(
    channelId: string,
    role: ConfigurableRole,
    allow: number,
    deny: number
  ): Promise<ApiChannelOverride> {
    return this.request(
      'PUT',
      `/api/channels/${encodeURIComponent(channelId)}/overrides/${encodeURIComponent(role)}`,
      { allow, deny }
    )
  }

  serverAudit(serverId: string): Promise<ApiAuditEvent[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/audit`)
  }

  // ---- Server invitations (codes travel in request bodies, never URLs) ----

  createInvite(
    serverId: string,
    body: { expiresInHours?: number; maxUses?: number | null }
  ): Promise<ApiServerInvite> {
    return this.request('POST', `/api/servers/${encodeURIComponent(serverId)}/invites`, body)
  }

  invites(serverId: string): Promise<ApiServerInvite[]> {
    return this.request('GET', `/api/servers/${encodeURIComponent(serverId)}/invites`)
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/servers/${encodeURIComponent(serverId)}/invites/${encodeURIComponent(inviteId)}`
    )
  }

  previewInvite(code: string): Promise<ApiInvitePreview> {
    return this.request('POST', '/api/invites/preview', { code })
  }

  acceptInvite(code: string): Promise<ApiServer> {
    return this.request('POST', '/api/invites/accept', { code })
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

  // ---- Milestone 14: saved messages and personal notes (only you can see them) ----

  savedMessages(): Promise<ApiSavedMessage[]> {
    return this.request('GET', '/api/saved-messages')
  }

  setSaved(messageId: string, saved: boolean): Promise<unknown> {
    return this.request(
      saved ? 'PUT' : 'DELETE',
      `/api/saved-messages/${encodeURIComponent(messageId)}`
    )
  }

  userNote(userId: string): Promise<ApiUserNote> {
    return this.request('GET', `/api/users/${encodeURIComponent(userId)}/note`)
  }

  setUserNote(userId: string, note: string): Promise<ApiUserNote> {
    return this.request('PUT', `/api/users/${encodeURIComponent(userId)}/note`, { note })
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

  // ---- Large files: chunked, resumable uploads (Milestone 13) ----

  startLargeUpload(channelId: string, filename: string, size: number): Promise<ApiUploadSession> {
    return this.request('POST', `/api/channels/${encodeURIComponent(channelId)}/uploads`, {
      filename,
      size
    })
  }

  largeUploadStatus(id: string): Promise<ApiUploadSession> {
    return this.request('GET', `/api/uploads/${encodeURIComponent(id)}`)
  }

  /** Sends one chunk (raw bytes) at `offset`; progress is for this chunk only. */
  uploadChunk(
    id: string,
    offset: number,
    chunk: Blob,
    options: { onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}
  ): Promise<{ receivedBytes: number }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${this.baseUrl}/api/uploads/${encodeURIComponent(id)}?offset=${offset}`)
      for (const [k, v] of Object.entries(this.authHeaders())) xhr.setRequestHeader(k, v)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.responseType = 'json'
      xhr.timeout = 10 * 60_000
      xhr.upload.onprogress = (e) => options.onProgress?.(e.loaded)
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as { receivedBytes: number })
          return
        }
        void errorFrom({ status: xhr.status, json: async () => xhr.response }).then(reject)
      }
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the server.'))
      xhr.ontimeout = () => reject(new ApiError(0, 'timeout', 'The upload stalled.'))
      xhr.onabort = () => reject(new UploadAbortedError())
      if (options.signal) {
        if (options.signal.aborted) return reject(new UploadAbortedError())
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      xhr.send(chunk)
    })
  }

  /**
   * Finishes a large upload. The server re-reads and hashes the whole file, which can take
   * minutes for gigabytes on the Jetson, hence the caller-chosen timeout. Safe to repeat.
   */
  completeLargeUpload(id: string, timeoutMs?: number): Promise<ApiAttachment> {
    return this.request(
      'POST',
      `/api/uploads/${encodeURIComponent(id)}/complete`,
      undefined,
      timeoutMs
    )
  }

  cancelLargeUpload(id: string): Promise<void> {
    return this.request('DELETE', `/api/uploads/${encodeURIComponent(id)}`)
  }

  /** For downloads handed to the main process (streamed to disk, never through memory). */
  attachmentDownload(attachmentId: string): { url: string; authorization: string } | null {
    if (!this.token) return null
    return {
      url: `${this.baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`,
      authorization: `${AUTH_SCHEME} ${this.token}`
    }
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

  // ---- Friends and conversations ----

  relationships(): Promise<ApiRelationship[]> {
    return this.request('GET', '/api/relationships')
  }

  sendFriendRequest(username: string): Promise<{ userId: string; type: 'friend' | 'outgoing' }> {
    return this.request('POST', '/api/relationships/requests', { username })
  }

  acceptFriendRequest(userId: string): Promise<unknown> {
    return this.request('POST', `/api/relationships/${encodeURIComponent(userId)}/accept`)
  }

  /** Removes a friend, cancels your request or declines theirs. */
  removeRelationship(userId: string): Promise<void> {
    return this.request('DELETE', `/api/relationships/${encodeURIComponent(userId)}`)
  }

  setBlocked(userId: string, blocked: boolean): Promise<void> {
    return this.request(
      blocked ? 'PUT' : 'DELETE',
      `/api/relationships/${encodeURIComponent(userId)}/block`
    )
  }

  setPrivacy(allowServerDms: boolean): Promise<ApiMe> {
    return this.request('PATCH', '/api/users/me/privacy', { allowServerDms })
  }

  conversations(): Promise<ApiConversation[]> {
    return this.request('GET', '/api/conversations')
  }

  openDm(userId: string): Promise<ApiConversation> {
    return this.request('POST', '/api/conversations/dm', { userId })
  }

  createGroup(userIds: string[], name: string | null): Promise<ApiConversation> {
    return this.request('POST', '/api/conversations/group', { userIds, name })
  }

  renameGroup(channelId: string, name: string | null): Promise<ApiConversation> {
    return this.request('PATCH', `/api/conversations/${encodeURIComponent(channelId)}`, { name })
  }

  addGroupMember(channelId: string, userId: string): Promise<ApiConversation> {
    return this.request('POST', `/api/conversations/${encodeURIComponent(channelId)}/members`, {
      userId
    })
  }

  removeGroupMember(channelId: string, userId: string): Promise<void> {
    return this.request(
      'DELETE',
      `/api/conversations/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`
    )
  }

  leaveGroup(channelId: string): Promise<void> {
    return this.request('POST', `/api/conversations/${encodeURIComponent(channelId)}/leave`)
  }

  closeConversation(channelId: string): Promise<void> {
    return this.request('POST', `/api/conversations/${encodeURIComponent(channelId)}/close`)
  }

  conversationEvents(channelId: string): Promise<ApiConversationEvent[]> {
    return this.request('GET', `/api/conversations/${encodeURIComponent(channelId)}/events`)
  }
}
