interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimitResult {
  ok: boolean
  retryAfterMs: number
}

/**
 * In-memory token-bucket limiter. Good enough for a single-process server;
 * swap for a shared store (e.g. Redis) if the backend is ever scaled horizontally.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly sweeper: NodeJS.Timeout

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  take(key: string, now = Date.now()): RateLimitResult {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now }
    const elapsed = (now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond)
    bucket.updatedAt = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(key, bucket)
      return { ok: true, retryAfterMs: 0 }
    }
    this.buckets.set(key, bucket)
    return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / this.refillPerSecond) * 1000) }
  }

  private sweep(now = Date.now()): void {
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > fullAfterMs) this.buckets.delete(key)
    }
  }

  dispose(): void {
    clearInterval(this.sweeper)
  }
}
