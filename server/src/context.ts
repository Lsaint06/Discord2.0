import type { AccessService } from './access.js'
import type { AttachmentStore } from './attachments/store.js'
import type { ProfileMediaStore } from './profile/media.js'
import type { AuditLog } from './audit.js'
import type { PasswordHasher } from './auth/password.js'
import type { Config } from './config.js'
import type { Repository } from './db/repository.js'
import type { GatewayHub } from './gateway.js'
import { TokenBucketLimiter } from './lib/rateLimit.js'
import type { LiveKitBridge } from './voice/livekitBridge.js'
import type { VoiceStateStore } from './voice/voiceStates.js'

export interface AppContext {
  config: Config
  repo: Repository
  hub: GatewayHub
  attachments: AttachmentStore
  /** Processed avatars and banners (inside the attachments directory / data volume). */
  profileMedia: ProfileMediaStore
  access: AccessService
  audit: AuditLog
  hasher: PasswordHasher
  voice: {
    store: VoiceStateStore
    /** null when voice (LiveKit) is not configured. */
    bridge: LiveKitBridge | null
  }
  limiters: {
    apiPerIp: TokenBucketLimiter
    gatewayPerIp: TokenBucketLimiter
    loginPerIp: TokenBucketLimiter
    /** Keyed by the attempted username (also for usernames that don't exist). */
    loginPerAccount: TokenBucketLimiter
    registerPerIp: TokenBucketLimiter
    recoverPerIp: TokenBucketLimiter
    recoverPerAccount: TokenBucketLimiter
    accountPerUser: TokenBucketLimiter
    adminPerUser: TokenBucketLimiter
    invitesPerUser: TokenBucketLimiter
    joinPerUser: TokenBucketLimiter
    moderationPerUser: TokenBucketLimiter
    messagesPerUser: TokenBucketLimiter
    editsPerUser: TokenBucketLimiter
    reactionsPerUser: TokenBucketLimiter
    pinsPerUser: TokenBucketLimiter
    uploadsPerUser: TokenBucketLimiter
    searchPerUser: TokenBucketLimiter
    readAcksPerUser: TokenBucketLimiter
    serversPerUser: TokenBucketLimiter
    profilePerUser: TokenBucketLimiter
    /** Avatar/banner uploads (each one is decoded and re-encoded). */
    profileMediaPerUser: TokenBucketLimiter
    /** Status, custom status and preference changes. */
    presencePerUser: TokenBucketLimiter
    /** Profile lookups (popouts) and profile image downloads. */
    profileReadsPerUser: TokenBucketLimiter
    voiceTokensPerUser: TokenBucketLimiter
  }
}

export function createLimiters(): AppContext['limiters'] {
  return {
    apiPerIp: new TokenBucketLimiter(120, 20),
    gatewayPerIp: new TokenBucketLimiter(10, 0.5),
    loginPerIp: new TokenBucketLimiter(10, 0.1),
    // Credential stuffing / guessing against one account: 5 tries, then one per minute.
    loginPerAccount: new TokenBucketLimiter(5, 1 / 60),
    registerPerIp: new TokenBucketLimiter(5, 1 / 60),
    recoverPerIp: new TokenBucketLimiter(5, 1 / 60),
    recoverPerAccount: new TokenBucketLimiter(5, 1 / 300),
    // Password change, recovery code regeneration, session management.
    accountPerUser: new TokenBucketLimiter(10, 1 / 30),
    adminPerUser: new TokenBucketLimiter(30, 0.5),
    invitesPerUser: new TokenBucketLimiter(10, 1 / 30),
    joinPerUser: new TokenBucketLimiter(10, 1 / 30),
    moderationPerUser: new TokenBucketLimiter(30, 1),
    messagesPerUser: new TokenBucketLimiter(5, 1),
    editsPerUser: new TokenBucketLimiter(10, 1),
    reactionsPerUser: new TokenBucketLimiter(20, 4),
    pinsPerUser: new TokenBucketLimiter(10, 0.5),
    // One request per file: a burst of 10 files, then about one every 2 s.
    uploadsPerUser: new TokenBucketLimiter(10, 0.5),
    searchPerUser: new TokenBucketLimiter(10, 1),
    readAcksPerUser: new TokenBucketLimiter(60, 10),
    serversPerUser: new TokenBucketLimiter(3, 1 / 60),
    profilePerUser: new TokenBucketLimiter(10, 0.2),
    profileMediaPerUser: new TokenBucketLimiter(6, 1 / 10),
    presencePerUser: new TokenBucketLimiter(20, 0.5),
    // Opening popouts and loading avatars for a whole member list: generous.
    profileReadsPerUser: new TokenBucketLimiter(300, 20),
    // Joins, channel switches and reconnects: generous burst, ~1 per 3 s sustained.
    voiceTokensPerUser: new TokenBucketLimiter(10, 1 / 3)
  }
}
