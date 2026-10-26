import type { FastifyBaseLogger } from 'fastify'
import { RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk'
import type { LiveKitConfig } from '../config.js'
import type { Repository } from '../db/repository.js'
import { channelIdFromRoom } from './access.js'
import type { VoiceMembership, VoiceStateChange, VoiceStateStore } from './voiceStates.js'

/** ParticipantInfo.State.DISCONNECTED in LiveKit's protocol. */
const PARTICIPANT_DISCONNECTED = 3

/**
 * Keeps the backend's voice presence in sync with LiveKit:
 * signed webhooks for low-latency updates, plus periodic reconciliation through the
 * RoomService API so state self-heals after missed webhooks or a LiveKit restart.
 */
export class LiveKitBridge {
  private readonly receiver: WebhookReceiver
  private readonly rooms: RoomServiceClient
  private timer: NodeJS.Timeout | null = null

  constructor(
    config: LiveKitConfig,
    private readonly store: VoiceStateStore,
    private readonly repo: Repository,
    private readonly onChanges: (changes: VoiceStateChange[]) => void,
    private readonly log: FastifyBaseLogger
  ) {
    this.receiver = new WebhookReceiver(config.apiKey, config.apiSecret)
    this.rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret)
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
        if (identity && (await this.repo.getUser(identity))) {
          changes = this.store.join(identity, channelId)
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
        if (p.state !== PARTICIPANT_DISCONNECTED && (await this.repo.getUser(p.identity))) {
          const streaming = p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE)
          next.set(p.identity, { channelId, streaming })
        }
      }
    }
    const changes = this.store.replaceAll(next)
    if (changes.length > 0) {
      this.log.info({ changes: changes.length }, 'voice state reconciled with LiveKit')
      this.onChanges(changes)
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
