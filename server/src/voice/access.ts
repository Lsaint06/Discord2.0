import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk'
import type { LiveKitConfig } from '../config.js'
import type { ChannelRecord, Repository, UserRecord } from '../db/repository.js'
import { ApiError, badRequest, notFound } from '../lib/errors.js'
import type { ApiVoiceToken } from '../protocol.js'

const ROOM_PREFIX = 'voice_'

/** Voice tokens only need to be valid long enough to connect; LiveKit refreshes them for live sessions. */
export const VOICE_TOKEN_TTL_SECONDS = 5 * 60

/**
 * Sources a voice participant may publish: microphone plus screen sharing (video and its
 * system audio). Camera is intentionally excluded. This is the single switch for publish rights.
 */
export const VOICE_PUBLISH_SOURCES: TrackSource[] = [
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO
]

export function roomNameForChannel(channelId: string): string {
  return `${ROOM_PREFIX}${channelId}`
}

export function channelIdFromRoom(roomName: string): string | undefined {
  return roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : undefined
}

/**
 * Membership policy. Today every registered (non-bot) user is a member of every server,
 * matching the rest of the API. When per-server membership exists, enforce it here.
 */
async function isServerMember(repo: Repository, user: UserRecord, serverId: string): Promise<boolean> {
  if (user.bot) return false
  const servers = await repo.listServers()
  return servers.some((s) => s.id === serverId)
}

/** Throws an ApiError unless `user` may join `channelId`'s voice room. */
export async function authorizeVoiceJoin(
  repo: Repository,
  user: UserRecord,
  channelId: string
): Promise<ChannelRecord> {
  const channel = await repo.getChannel(channelId)
  if (!channel) throw notFound('Channel not found')
  if (channel.type !== 'voice') throw badRequest('Not a voice channel', 'not_voice_channel')
  if (!(await isServerMember(repo, user, channel.serverId))) {
    throw new ApiError(403, 'forbidden', 'You are not a member of this server')
  }
  return channel
}

/** Mints a LiveKit join token. Identity always comes from the authenticated backend user. */
export async function issueVoiceToken(
  config: LiveKitConfig,
  user: UserRecord,
  channel: ChannelRecord,
  now = Date.now()
): Promise<ApiVoiceToken> {
  const room = roomNameForChannel(channel.id)
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: user.id,
    name: user.displayName,
    ttl: VOICE_TOKEN_TTL_SECONDS
  })
  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canPublish: true,
    canPublishSources: VOICE_PUBLISH_SOURCES,
    canSubscribe: true,
    canPublishData: false,
    // Lets the client publish its own "deafened" attribute; identity can't be changed.
    canUpdateOwnMetadata: true
  }
  at.addGrant(grant)
  return {
    url: config.publicUrl,
    token: await at.toJwt(),
    room,
    identity: user.id,
    expiresAt: now + VOICE_TOKEN_TTL_SECONDS * 1000
  }
}
