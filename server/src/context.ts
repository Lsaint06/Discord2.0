import type { AttachmentStore } from './attachments/store.js'
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
  voice: {
    store: VoiceStateStore
    /** null when voice (LiveKit) is not configured. */
    bridge: LiveKitBridge | null
  }
  limiters: {
    apiPerIp: TokenBucketLimiter
    gatewayPerIp: TokenBucketLimiter
    loginPerIp: TokenBucketLimiter
    messagesPerUser: TokenBucketLimiter
    editsPerUser: TokenBucketLimiter
    reactionsPerUser: TokenBucketLimiter
    pinsPerUser: TokenBucketLimiter
    uploadsPerUser: TokenBucketLimiter
    searchPerUser: TokenBucketLimiter
    readAcksPerUser: TokenBucketLimiter
    serversPerUser: TokenBucketLimiter
    profilePerUser: TokenBucketLimiter
    voiceTokensPerUser: TokenBucketLimiter
  }
}

export function createLimiters(): AppContext['limiters'] {
  return {
    apiPerIp: new TokenBucketLimiter(120, 20),
    gatewayPerIp: new TokenBucketLimiter(10, 0.5),
    loginPerIp: new TokenBucketLimiter(10, 0.1),
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
    // Joins, channel switches and reconnects: generous burst, ~1 per 3 s sustained.
    voiceTokensPerUser: new TokenBucketLimiter(10, 1 / 3)
  }
}
