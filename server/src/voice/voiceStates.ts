import type { ApiVoiceState } from '../protocol.js'

export interface VoiceStateChange {
  userId: string
  channelId: string | null
  /** Present when the user's screen-share state is part of the change. */
  streaming?: boolean
}

export interface VoiceMembership {
  channelId: string
  streaming: boolean
}

/**
 * Who is in which voice channel, and who is screen sharing. LiveKit is the source of truth;
 * this mirrors it from webhooks and periodic reconciliation. A user is tracked in at most one
 * channel.
 */
export class VoiceStateStore {
  private readonly byUser = new Map<string, string>()
  private readonly streaming = new Set<string>()

  snapshot(): ApiVoiceState[] {
    return [...this.byUser].map(([userId, channelId]) =>
      this.streaming.has(userId) ? { userId, channelId, streaming: true } : { userId, channelId }
    )
  }

  channelOf(userId: string): string | undefined {
    return this.byUser.get(userId)
  }

  isStreaming(userId: string): boolean {
    return this.streaming.has(userId)
  }

  join(userId: string, channelId: string): VoiceStateChange[] {
    if (this.byUser.get(userId) === channelId) return []
    // Moving channels always ends any screen share from the previous room.
    this.streaming.delete(userId)
    this.byUser.set(userId, channelId)
    return [{ userId, channelId }]
  }

  /** Only removes the user if they're still recorded in `channelId` (ignores stale leave events). */
  leave(userId: string, channelId: string): VoiceStateChange[] {
    if (this.byUser.get(userId) !== channelId) return []
    this.byUser.delete(userId)
    this.streaming.delete(userId)
    return [{ userId, channelId: null }]
  }

  /** Records a screen share starting/stopping. Ignored unless the user is in that channel. */
  setStreaming(userId: string, channelId: string, streaming: boolean): VoiceStateChange[] {
    if (this.byUser.get(userId) !== channelId) return []
    if (this.streaming.has(userId) === streaming) return []
    if (streaming) this.streaming.add(userId)
    else this.streaming.delete(userId)
    return [{ userId, channelId, streaming }]
  }

  clearChannel(channelId: string): VoiceStateChange[] {
    const changes: VoiceStateChange[] = []
    for (const [userId, current] of this.byUser) {
      if (current === channelId) {
        this.byUser.delete(userId)
        this.streaming.delete(userId)
        changes.push({ userId, channelId: null })
      }
    }
    return changes
  }

  /**
   * Replaces everything with an authoritative snapshot and returns the differences.
   * Values may be a channel id (membership only) or a membership with streaming state.
   */
  replaceAll(next: Map<string, string | VoiceMembership>): VoiceStateChange[] {
    const normalized = new Map<string, VoiceMembership>()
    for (const [userId, value] of next) {
      normalized.set(
        userId,
        typeof value === 'string' ? { channelId: value, streaming: false } : value
      )
    }

    const changes: VoiceStateChange[] = []
    for (const [userId] of this.byUser) {
      if (!normalized.has(userId)) {
        this.byUser.delete(userId)
        this.streaming.delete(userId)
        changes.push({ userId, channelId: null })
      }
    }
    for (const [userId, { channelId, streaming }] of normalized) {
      if (this.byUser.get(userId) !== channelId) {
        changes.push(...this.join(userId, channelId))
      }
      changes.push(...this.setStreaming(userId, channelId, streaming))
    }
    return changes
  }
}
