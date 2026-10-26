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
    serversPerUser: new TokenBucketLimiter(3, 1 / 60),
    profilePerUser: new TokenBucketLimiter(10, 0.2),
    // Joins, channel switches and reconnects: generous burst, ~1 per 3 s sustained.
    voiceTokensPerUser: new TokenBucketLimiter(10, 1 / 3)
  }
}
