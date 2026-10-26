import type { Config } from './config.js'
import type { Repository } from './db/repository.js'
import type { GatewayHub } from './gateway.js'
import { TokenBucketLimiter } from './lib/rateLimit.js'

export interface AppContext {
  config: Config
  repo: Repository
  hub: GatewayHub
  limiters: {
    apiPerIp: TokenBucketLimiter
    gatewayPerIp: TokenBucketLimiter
    loginPerIp: TokenBucketLimiter
    messagesPerUser: TokenBucketLimiter
    serversPerUser: TokenBucketLimiter
    profilePerUser: TokenBucketLimiter
  }
}

export function createLimiters(): AppContext['limiters'] {
  return {
    apiPerIp: new TokenBucketLimiter(120, 20),
    gatewayPerIp: new TokenBucketLimiter(10, 0.5),
    loginPerIp: new TokenBucketLimiter(10, 0.1),
    messagesPerUser: new TokenBucketLimiter(5, 1),
    serversPerUser: new TokenBucketLimiter(3, 1 / 60),
    profilePerUser: new TokenBucketLimiter(10, 0.2)
  }
}
