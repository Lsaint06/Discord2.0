import type { FastifyBaseLogger } from 'fastify'
import { RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk'
import type { LiveKitConfig } from '../config.js'
import { channelIdFromRoom, publishSourcesFor, roomNameForChannel } from './access.js'
import type { VoiceMembership, VoiceStateChange, VoiceStateStore } from './voiceStates.js'

/** ParticipantInfo.State.DISCONNECTED in LiveKit's protocol. */
const PARTICIPANT_DISCONNECTED = 3

/**
 * Returns the participant's channel permissions if they may be in this voice channel right now
 * (member, can view, Connect, active account), or null if they must be removed.
 */
export type VoiceAuthorizer = (identity: string, channelId: string) => Promise<number | null>

/** A second check when someone connects (after authorization): e.g. the channel's user limit. */
export type VoiceAdmission = (identity: string, channelId: string, permissions: number) => Promise<boolean>

/**
 * Keeps the backend's voice presence in sync with LiveKit:
 * signed webhooks for low-latency updates, plus periodic reconciliation through the
 * RoomService API so state self-heals after missed webhooks or a LiveKit restart.
 * Participants who are no longer authorized (kicked, banned, disabled, permission removed)
 * are removed from the room, even if they still hold an unexpired token.
 */
export class LiveKitBridge {
  private readonly receiver: WebhookReceiver
  private readonly rooms: RoomServiceClient
  private readonly admit: VoiceAdmission
  private timer: NodeJS.Timeout | null = null

  constructor(
    config: LiveKitConfig,
    private readonly store: VoiceStateStore,
    private readonly authorize: VoiceAuthorizer,
    private readonly onChanges: (changes: VoiceStateChange[]) => void,
    private readonly log: FastifyBaseLogger,
    options: { rooms?: RoomServiceClient; admit?: VoiceAdmission } = {}
  ) {
    this.receiver = new WebhookReceiver(config.apiKey, config.apiSecret)
    this.rooms = options.rooms ?? new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret)
    this.admit = options.admit ?? (async () => true)
  }

  /** Verifies the webhook signature (throws if invalid) and applies the event. */
  async handleWebhook(body: string, authHeader: string | undefined): Promise<void> {
    const event = await this.receiver.receive(body, authHeader)
    const channelId = event.room?.name ? channelIdFromRoom(event.room.name) : undefined
    if (!channelId) return

    const identity = event.participant?.identity
    let changes: VoiceStateChange[] = []
    switch (event.event) {
      case 'participant_joined':
        if (identity) {
          const permissions = await this.authorize(identity, channelId)
          if (permissions === null) {
            await this.kick(channelId, identity, 'not authorized on join')
          } else if (!(await this.admit(identity, channelId, permissions))) {
            await this.kick(channelId, identity, 'channel full on join')
          } else {
            changes = this.store.join(identity, channelId)
          }
        }
        break
      case 'participant_left':
      case 'participant_connection_aborted':
        if (identity) changes = this.store.leave(identity, channelId)
        break
      case 'track_published':
      case 'track_unpublished':
        // Screen-share video marks a user as "live"; mic and screen audio don't.
        if (identity && event.track?.source === TrackSource.SCREEN_SHARE) {
          changes = this.store.setStreaming(identity, channelId, event.event === 'track_published')
        }
        break
      case 'room_finished':
        changes = this.store.clearChannel(channelId)
        break
    }
    if (changes.length > 0) this.onChanges(changes)
  }

  async reconcile(): Promise<void> {
    const rooms = await this.rooms.listRooms()
    const next = new Map<string, VoiceMembership>()
    for (const room of rooms) {
      const channelId = channelIdFromRoom(room.name)
      if (!channelId) continue
      const participants = await this.rooms.listParticipants(room.name)
      for (const p of participants) {
        if (p.state === PARTICIPANT_DISCONNECTED) continue
        if ((await this.authorize(p.identity, channelId)) === null) {
          await this.kick(channelId, p.identity, 'not authorized (reconcile)')
          continue
        }
        const streaming = p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE)
        next.set(p.identity, { channelId, streaming })
      }
    }
    const changes = this.store.replaceAll(next)
    if (changes.length > 0) {
      this.log.info({ changes: changes.length }, 'voice state reconciled with LiveKit')
      this.onChanges(changes)
    }
  }

  /**
   * Removes a participant from a room and asks LiveKit to reject tokens issued before now
   * (`revokeTokenTs`; servers without support ignore it — the join check above still applies).
   */
  async kick(channelId: string, identity: string, reason: string): Promise<void> {
    try {
      await this.rooms.removeParticipant(roomNameForChannel(channelId), identity, {
        revokeTokenTs: BigInt(Math.floor(Date.now() / 1000))
      })
      this.log.info({ channel: channelId, identity, reason }, 'removed voice participant')
    } catch (err) {
      // Already gone (404) is fine; anything else is logged and retried by reconciliation.
      this.log.warn({ err: (err as Error).message, channel: channelId, identity }, 'remove participant failed')
    }
    const changes = this.store.leave(identity, channelId)
    if (changes.length > 0) this.onChanges(changes)
  }

  /** Applies new publish permissions to a live participant (e.g. Speak/Stream revoked). */
  async updatePermissions(channelId: string, identity: string, permissions: number): Promise<void> {
    const sources = publishSourcesFor(permissions)
    try {
      await this.rooms.updateParticipant(roomNameForChannel(channelId), identity, {
        permission: {
          canSubscribe: true,
          canPublish: sources.length > 0,
          canPublishSources: sources,
          canPublishData: false,
          canUpdateMetadata: true
        }
      })
    } catch (err) {
      this.log.warn({ err: (err as Error).message, channel: channelId, identity }, 'update participant failed')
    }
  }

  start(intervalMs: number): void {
    const run = (): void => {
      this.reconcile().catch((err: unknown) =>
        this.log.warn({ err: (err as Error).message }, 'LiveKit reconcile failed (is LiveKit running?)')
      )
    }
    run()
    this.timer = setInterval(run, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
