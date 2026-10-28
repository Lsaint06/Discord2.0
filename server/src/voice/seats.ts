/**
 * Voice channel user limits. LiveKit (through webhooks) tells us who is in a room; a token that
 * was just issued but hasn't connected yet holds a seat for a short while, so two people can't
 * both take the last seat in the few seconds before LiveKit reports the first one. A token
 * stays valid for minutes, though, so the limit is checked again when someone actually
 * connects (voiceSeatAdmission).
 */
import type { AppContext } from '../context.js'
import type { ChannelRecord } from '../db/repository.js'
import { forbidden } from '../lib/errors.js'
import { has } from '../lib/permissions.js'
import { Permissions } from '../protocol.js'
import type { VoiceAdmission } from './livekitBridge.js'

export const SEAT_HOLD_MS = 20_000

const holds = new WeakMap<AppContext, Map<string, Map<string, number>>>()

function holdsFor(ctx: AppContext): Map<string, Map<string, number>> {
  let map = holds.get(ctx)
  if (!map) {
    map = new Map()
    holds.set(ctx, map)
  }
  return map
}

/** People in (or about to join) the channel, other than `userId`. */
export function occupantsExcept(ctx: AppContext, channelId: string, userId: string, now = Date.now()): number {
  const inRoom = new Set(
    ctx.voice.store
      .snapshot()
      .filter((s) => s.channelId === channelId)
      .map((s) => s.userId)
  )
  const pending = holdsFor(ctx).get(channelId)
  if (pending) {
    for (const [id, until] of pending) {
      if (until <= now || inRoom.has(id)) pending.delete(id)
      else inRoom.add(id)
    }
    if (pending.size === 0) holdsFor(ctx).delete(channelId)
  }
  inRoom.delete(userId)
  return inRoom.size
}

/**
 * Throws 403 `channel_full` when the voice channel has a user limit that is reached. People who
 * can manage the channel may still join (to moderate). Otherwise holds a seat for the joiner.
 */
export function claimVoiceSeat(
  ctx: AppContext,
  channel: ChannelRecord,
  userId: string,
  permissions: number,
  now = Date.now()
): void {
  const limit = channel.userLimit ?? 0
  if (limit <= 0) return
  // Someone already in the room keeps their seat (reconnecting), whoever else came in meanwhile.
  const seated = ctx.voice.store.channelOf(userId) === channel.id
  if (!seated && !has(permissions, Permissions.manageChannels) && occupantsExcept(ctx, channel.id, userId, now) >= limit) {
    throw forbidden(`This voice channel is full (${limit} ${limit === 1 ? 'person' : 'people'}).`, 'channel_full')
  }
  let pending = holdsFor(ctx).get(channel.id)
  if (!pending) {
    pending = new Map()
    holdsFor(ctx).set(channel.id, pending)
  }
  pending.set(userId, now + SEAT_HOLD_MS)
}

/**
 * The limit, checked again when LiveKit reports someone connecting: a seat that was free when
 * their token was issued may be taken by now. People who can manage the channel are always let
 * in, and lowering a limit never removes anyone who is already in the room.
 */
export function voiceSeatAdmission(ctx: AppContext): VoiceAdmission {
  return async (identity, channelId, permissions) => {
    const limit = (await ctx.repo.getChannel(channelId))?.userLimit ?? 0
    if (limit <= 0 || has(permissions, Permissions.manageChannels)) return true
    const inRoom = ctx.voice.store.snapshot().filter((s) => s.channelId === channelId)
    // Reconnecting keeps your seat, even if a manager joined a full room meanwhile.
    if (inRoom.some((s) => s.userId === identity)) return true
    return inRoom.length < limit
  }
}
