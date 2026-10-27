import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk'
import type { AccessService } from '../access.js'
import type { LiveKitConfig } from '../config.js'
import type { ChannelRecord, UserRecord } from '../db/repository.js'
import { badRequest, forbidden } from '../lib/errors.js'
import { has } from '../lib/permissions.js'
import { Permissions, type ApiVoiceToken } from '../protocol.js'

const ROOM_PREFIX = 'voice_'

/** Voice tokens only need to be valid long enough to connect; LiveKit refreshes them for live sessions. */
export const VOICE_TOKEN_TTL_SECONDS = 5 * 60

/**
 * Everything a voice participant may ever publish: microphone plus screen sharing (video and its
 * system audio). Camera is intentionally excluded. The actual grant is narrowed by permissions.
 */
export const VOICE_PUBLISH_SOURCES: TrackSource[] = [
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO
]

/** Publish sources allowed by channel permissions: Speak → microphone, Stream → screen share. */
export function publishSourcesFor(permissions: number): TrackSource[] {
  const sources: TrackSource[] = []
  if (has(permissions, Permissions.speak)) sources.push(TrackSource.MICROPHONE)
  if (has(permissions, Permissions.stream)) {
    sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO)
  }
  return sources
}

export function roomNameForChannel(channelId: string): string {
  return `${ROOM_PREFIX}${channelId}`
}

export function channelIdFromRoom(roomName: string): string | undefined {
  return roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : undefined
}

/**
 * Throws unless `user` may join `channelId`'s voice room: a member of the server who can view
 * the channel and has Connect. Non-members get 404 (no probing of other servers' channels).
 */
export async function authorizeVoiceJoin(
  access: AccessService,
  user: UserRecord,
  channelId: string
): Promise<{ channel: ChannelRecord; permissions: number }> {
  const result = await access.requireChannel(user, channelId)
  if (result.channel.type !== 'voice') throw badRequest('Not a voice channel', 'not_voice_channel')
  if (!has(result.channelPermissions, Permissions.connect)) {
    throw forbidden('You can’t join this voice channel.', 'missing_permission')
  }
  return { channel: result.channel, permissions: result.channelPermissions }
}

/** The LiveKit grant for a participant with the given channel permissions. */
export function voiceGrant(room: string, permissions: number): VideoGrant {
  const sources = publishSourcesFor(permissions)
  return {
    roomJoin: true,
    room,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canSubscribe: true,
    canPublishData: false,
    // Lets the client publish its own "deafened" attribute; identity can't be changed.
    canUpdateOwnMetadata: true
  }
}

/** Mints a LiveKit join token. Identity always comes from the authenticated backend user. */
export async function issueVoiceToken(
  config: LiveKitConfig,
  user: UserRecord,
  channel: ChannelRecord,
  permissions: number,
  now = Date.now()
): Promise<ApiVoiceToken> {
  const room = roomNameForChannel(channel.id)
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: user.id,
    name: user.displayName,
    ttl: VOICE_TOKEN_TTL_SECONDS
  })
  at.addGrant(voiceGrant(room, permissions))
  return {
    url: config.publicUrl,
    token: await at.toJwt(),
    room,
    identity: user.id,
    expiresAt: now + VOICE_TOKEN_TTL_SECONDS * 1000
  }
}
