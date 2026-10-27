/**
 * Keeps live voice participants in line with current permissions: removes people who were
 * kicked, banned, disabled or lost Connect/View, and narrows publish rights (Speak/Stream)
 * without touching anyone whose voice permissions didn't change (so streams aren't disturbed).
 */
import type { AppContext } from '../context.js'
import { has } from '../lib/permissions.js'
import { Permissions } from '../protocol.js'
import { VOICE_BITS } from '../realtime.js'
import type { VoiceAuthorizer } from './livekitBridge.js'

const applied = new WeakMap<AppContext, Map<string, number>>()

function appliedFor(ctx: AppContext): Map<string, number> {
  let map = applied.get(ctx)
  if (!map) {
    map = new Map()
    applied.set(ctx, map)
  }
  return map
}

/** Remembers the voice permissions a participant was granted (when a token is issued). */
export function rememberVoiceGrant(ctx: AppContext, userId: string, channelId: string, permissions: number): void {
  appliedFor(ctx).set(`${userId}:${channelId}`, permissions & VOICE_BITS)
}

export function voiceAuthorizer(ctx: AppContext): VoiceAuthorizer {
  return async (identity, channelId) => {
    const user = await ctx.repo.getUser(identity)
    if (!user || user.bot || user.disabledAt) return null
    const access = await ctx.access.channel(user, channelId)
    if (!access || access.channel.type !== 'voice') return null
    if (!has(access.channelPermissions, Permissions.connect)) return null
    return access.channelPermissions
  }
}

/** Re-checks everyone currently in voice (optionally only in one server, or one user). */
export async function enforceVoiceAccess(
  ctx: AppContext,
  filter: { serverId?: string; userId?: string } = {}
): Promise<void> {
  const bridge = ctx.voice.bridge
  if (!bridge) return
  const authorize = voiceAuthorizer(ctx)
  const grants = appliedFor(ctx)
  for (const state of ctx.voice.store.snapshot()) {
    if (filter.userId && state.userId !== filter.userId) continue
    if (filter.serverId) {
      const channel = await ctx.repo.getChannel(state.channelId)
      if (channel && channel.serverId !== filter.serverId) continue
    }
    const key = `${state.userId}:${state.channelId}`
    const perms = await authorize(state.userId, state.channelId)
    if (perms === null) {
      grants.delete(key)
      await bridge.kick(state.channelId, state.userId, 'access revoked')
      continue
    }
    const voiceBits = perms & VOICE_BITS
    if (grants.get(key) !== voiceBits) {
      grants.set(key, voiceBits)
      await bridge.updatePermissions(state.channelId, state.userId, perms)
    }
  }
}

/** Disconnects a user from voice (sign-out everywhere, password change, account disabled). */
export async function disconnectUserFromVoice(ctx: AppContext, userId: string, reason: string): Promise<void> {
  const channelId = ctx.voice.store.channelOf(userId)
  if (channelId && ctx.voice.bridge) {
    appliedFor(ctx).delete(`${userId}:${channelId}`)
    await ctx.voice.bridge.kick(channelId, userId, reason)
  }
}
