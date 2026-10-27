/**
 * Realtime fan-out with authorization: every gateway event goes only to users allowed to see
 * it (channel viewers, server members, the user themself). Nothing is broadcast to everyone.
 */
import type { AppContext } from './context.js'
import type { ChannelRecord, UserRecord } from './db/repository.js'
import type { ApiMe, ApiVoiceState, GatewayServerFrame } from './protocol.js'
import { Permissions } from './protocol.js'
import type { VoiceStateChange } from './voice/voiceStates.js'
import { ownCustomStatus } from './gateway.js'

/** Sends a channel-scoped event to everyone who can currently view the channel. */
export async function publishToChannel(
  ctx: AppContext,
  channel: ChannelRecord,
  frame: GatewayServerFrame
): Promise<void> {
  ctx.hub.sendToUsers(await ctx.access.channelViewers(channel), frame)
}

/** Tells members (plus any extra users, e.g. someone just removed) to refetch a server. */
export async function publishServerChanged(
  ctx: AppContext,
  serverId: string,
  extraUserIds: string[] = []
): Promise<void> {
  const members = await ctx.access.serverMembers(serverId)
  for (const id of extraUserIds) members.add(id)
  ctx.hub.sendToUsers(members, { op: 'server_update', d: { serverId } })
}

export async function toApiMe(ctx: AppContext, user: UserRecord): Promise<ApiMe> {
  const withPassword = await ctx.repo.hasPassword([user.id])
  return {
    ...ctx.hub.toApiUser(user),
    instanceAdmin: Boolean(user.instanceAdmin),
    hasPassword: withPassword.has(user.id),
    statusPreference: user.statusPreference ?? 'online',
    ownCustomStatus: ownCustomStatus(user)
  }
}

/**
 * After the user changed their profile (name, picture, bio…): everyone who can see them gets
 * the new profile, and all of their own devices get the updated account view.
 */
export async function publishProfileChange(ctx: AppContext, user: UserRecord): Promise<void> {
  await ctx.hub.publishUser(user)
  await ctx.hub.publishMe(user)
}

/** After a status / custom status change: others only if what they see changed. */
export async function publishStatusChange(ctx: AppContext, user: UserRecord): Promise<void> {
  await ctx.hub.publishPresenceIfChanged(user)
  await ctx.hub.publishMe(user)
}

/** Clears expired custom statuses and tells everyone affected. Returns how many expired. */
export async function expireCustomStatuses(ctx: AppContext, now = Date.now()): Promise<number> {
  const ids = await ctx.repo.clearExpiredCustomStatuses(now)
  for (const id of ids) {
    const user = await ctx.repo.getUser(id)
    if (user) await publishStatusChange(ctx, user)
  }
  return ids.length
}

/** Voice states in voice channels the user can view. */
export async function visibleVoiceStates(ctx: AppContext, user: UserRecord): Promise<ApiVoiceState[]> {
  const viewable = new Set(await ctx.access.viewableChannelIds(user, undefined, 'voice'))
  return ctx.voice.store.snapshot().filter((s) => viewable.has(s.channelId))
}

/**
 * Publishes voice presence changes. Viewers of the channel see the change; other people who
 * share a server with the user see them leave (so a move into a hidden channel isn't revealed).
 */
export async function publishVoiceChanges(ctx: AppContext, changes: VoiceStateChange[]): Promise<void> {
  for (const change of changes) {
    const audience = await ctx.access.presenceAudienceOf(change.userId)
    if (change.channelId === null) {
      ctx.hub.sendToUsers(audience, { op: 'voice_state_update', d: change })
      continue
    }
    const channel = await ctx.repo.getChannel(change.channelId)
    const viewers = channel ? await ctx.access.channelViewers(channel) : new Set<string>()
    const hidden = [...audience].filter((id) => !viewers.has(id))
    ctx.hub.sendToUsers(viewers, { op: 'voice_state_update', d: change })
    ctx.hub.sendToUsers(hidden, {
      op: 'voice_state_update',
      d: { userId: change.userId, channelId: null }
    })
  }
}

/** Bits that matter for a LiveKit grant (used to decide whether to update live participants). */
export const VOICE_BITS = Permissions.connect | Permissions.speak | Permissions.stream
