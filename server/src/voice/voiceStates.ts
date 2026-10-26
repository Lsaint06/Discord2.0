import type { ApiVoiceState } from '../protocol.js'

export interface VoiceStateChange {
  userId: string
  channelId: string | null
}

/**
 * Who is in which voice channel. LiveKit is the source of truth; this mirrors it from
 * webhooks and periodic reconciliation. A user is tracked in at most one channel.
 */
export class VoiceStateStore {
  private readonly byUser = new Map<string, string>()

  snapshot(): ApiVoiceState[] {
    return [...this.byUser].map(([userId, channelId]) => ({ userId, channelId }))
  }

  channelOf(userId: string): string | undefined {
    return this.byUser.get(userId)
  }

  join(userId: string, channelId: string): VoiceStateChange[] {
    if (this.byUser.get(userId) === channelId) return []
    this.byUser.set(userId, channelId)
    return [{ userId, channelId }]
  }

  /** Only removes the user if they're still recorded in `channelId` (ignores stale leave events). */
  leave(userId: string, channelId: string): VoiceStateChange[] {
    if (this.byUser.get(userId) !== channelId) return []
    this.byUser.delete(userId)
    return [{ userId, channelId: null }]
  }

  clearChannel(channelId: string): VoiceStateChange[] {
    const changes: VoiceStateChange[] = []
    for (const [userId, current] of this.byUser) {
      if (current === channelId) {
        this.byUser.delete(userId)
        changes.push({ userId, channelId: null })
      }
    }
    return changes
  }

  /** Replaces everything with an authoritative snapshot and returns the differences. */
  replaceAll(next: Map<string, string>): VoiceStateChange[] {
    const changes: VoiceStateChange[] = []
    for (const [userId] of this.byUser) {
      if (!next.has(userId)) {
        this.byUser.delete(userId)
        changes.push({ userId, channelId: null })
      }
    }
    for (const [userId, channelId] of next) {
      if (this.byUser.get(userId) !== channelId) {
        this.byUser.set(userId, channelId)
        changes.push({ userId, channelId })
      }
    }
    return changes
  }
}
