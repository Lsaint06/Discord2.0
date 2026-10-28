import type { AccessService } from './access.js'
import type { AttachmentStore } from './attachments/store.js'
import type { ProfileMediaStore } from './profile/media.js'
import type { AuditLog } from './audit.js'
import type { PasswordHasher } from './auth/password.js'
import type { Config } from './config.js'
import type { Repository } from './db/repository.js'
import type { GatewayHub } from './gateway.js'
import { TokenBucketLimiter } from './lib/rateLimit.js'
import type { MailOutbox } from './mail/mailer.js'
import type { LiveKitBridge } from './voice/livekitBridge.js'
import type { VoiceStateStore } from './voice/voiceStates.js'

export interface AppContext {
  config: Config
  repo: Repository
  hub: GatewayHub
  attachments: AttachmentStore
  /** Processed avatars and banners (inside the attachments directory / data volume). */
  profileMedia: ProfileMediaStore
  /** Processed server icons (same format as avatars; their own folder and sweep). */
  serverIcons: ProfileMediaStore
  access: AccessService
  audit: AuditLog
  hasher: PasswordHasher
  /** Outgoing email (verification and reset codes); `available` is false without a transport. */
  mail: MailOutbox
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
    /** Email self-registration attempts (Milestone 13). */
    signupPerIp: TokenBucketLimiter
    /** Emails to one address (codes and notices), keyed by the address even if unknown. */
    emailsPerAddress: TokenBucketLimiter
    /** Every email the server sends (key 'all'): a cap if something goes wrong. */
    emailsGlobal: TokenBucketLimiter
    /** Code checks (verification, password reset by email). */
    emailCodesPerIp: TokenBucketLimiter
    emailCodesPerAddress: TokenBucketLimiter
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
    /** Friend requests by username (also limits probing which usernames exist). */
    friendRequestsPerUser: TokenBucketLimiter
    /** Accept, decline, remove, block, unblock, privacy changes. */
    relationshipsPerUser: TokenBucketLimiter
    /** Opening DMs and creating groups. */
    conversationsPerUser: TokenBucketLimiter
    /** Adding/removing members, renaming, leaving. */
    groupChangesPerUser: TokenBucketLimiter
    /** GIF picker searches and trending pages. */
    gifSearchPerUser: TokenBucketLimiter
    /** GIF media through the proxy (a grid loads many at once). */
    gifMediaPerUser: TokenBucketLimiter
    /** Chunks of large uploads (16 MB each). */
    uploadChunksPerUser: TokenBucketLimiter
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
    // 5 sign-ups, then one every 10 minutes, from one IP address.
    signupPerIp: new TokenBucketLimiter(5, 1 / 600),
    // 3 emails, then one every 5 minutes, to any one address.
    emailsPerAddress: new TokenBucketLimiter(3, 1 / 300),
    // 200 emails, then about one every 18 s for the whole server.
    emailsGlobal: new TokenBucketLimiter(200, 200 / 3600),
    emailCodesPerIp: new TokenBucketLimiter(20, 1 / 30),
    emailCodesPerAddress: new TokenBucketLimiter(10, 1 / 60),
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
    voiceTokensPerUser: new TokenBucketLimiter(10, 1 / 3),
    // 10 requests, then one a minute.
    friendRequestsPerUser: new TokenBucketLimiter(10, 1 / 60),
    relationshipsPerUser: new TokenBucketLimiter(30, 0.5),
    conversationsPerUser: new TokenBucketLimiter(20, 0.5),
    groupChangesPerUser: new TokenBucketLimiter(20, 0.5),
    // Typing in the picker is debounced by the app; ~1 search per second sustained.
    gifSearchPerUser: new TokenBucketLimiter(20, 1),
    gifMediaPerUser: new TokenBucketLimiter(200, 20),
    // 16 MB chunks: 5 GB is ~320 requests; this allows a fast LAN upload at full speed.
    uploadChunksPerUser: new TokenBucketLimiter(60, 10)
  }
}
