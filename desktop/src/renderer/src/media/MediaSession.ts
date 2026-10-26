import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'
import type { ApiVoiceToken } from '../net/protocol'
import { GainProcessor } from './GainProcessor'
import {
  backoffDelay,
  describeDisconnect,
  micShouldTransmit,
  playbackVolume,
  REJOIN_MAX_ATTEMPTS,
  shouldAutoRejoin,
  type MicState,
  type VoiceStatus
} from './voiceLogic'

export interface VoiceParticipant {
  identity: string
  isLocal: boolean
  speaking: boolean
  micEnabled: boolean
  deafened: boolean
}

export interface MediaSnapshot {
  status: VoiceStatus
  /** Channel we're connected/connecting to (also kept on error so the UI can offer a retry). */
  channelId: string | null
  error?: string
  /** Problem with the local microphone; we stay connected and can still listen. */
  micError?: string
  retryInMs?: number
  participants: VoiceParticipant[]
}

export interface MediaPreferences {
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputVolume: number
  outputVolume: number
  userVolumes: Record<string, number>
}

export interface MediaSessionDeps {
  describeError: (err: unknown) => string
  /** Errors that retrying won't fix (unauthorized, forbidden, not found, voice disabled…). */
  isFatalError: (err: unknown) => boolean
}

export type TokenSource = (channelId: string) => Promise<ApiVoiceToken>

const INITIAL: MediaSnapshot = { status: 'idle', channelId: null, participants: [] }

function micErrorMessage(err: unknown): string {
  switch (MediaDeviceFailure.getFailure(err)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'Microphone access is blocked. Allow it in Windows Settings → Privacy & security → Microphone.'
    case MediaDeviceFailure.NotFound:
      return 'No microphone was found.'
    case MediaDeviceFailure.DeviceInUse:
      return 'Your microphone is in use by another app or unavailable.'
    default:
      return `Microphone error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Owns the LiveKit connection for voice. One instance per signed-in session.
 *
 * Designed to grow into screen sharing: tracks are managed per source, the room is created
 * with dynacast/adaptive streaming (needed for simulcast/SVC video), and the backend grant
 * decides which sources may be published.
 */
export class MediaSession {
  private snapshot: MediaSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private room: Room | null = null
  private desiredChannel: string | null = null
  private joinSeq = 0
  private rejoinAttempt = 0
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null
  private micQueue: Promise<void> = Promise.resolve()
  private gain: GainProcessor | null = null
  private micAudioContext: AudioContext | null = null
  /** Every raw microphone track we've captured in the current room; all are stopped on teardown. */
  private readonly capturedTracks = new Set<MediaStreamTrack>()
  private audioContainer: HTMLDivElement | null = null
  private tokenSource: TokenSource | null = null
  private micState: MicState = {
    muted: false,
    deafened: false,
    pushToTalk: false,
    pushToTalkActive: false
  }

  /** Side-effect free so it can be created in a React state initializer; see activate(). */
  constructor(
    private readonly deps: MediaSessionDeps,
    private prefs: MediaPreferences
  ) {}

  /** Starts listening for network changes. Pair with deactivate(). */
  activate(): void {
    window.addEventListener('online', this.onNetworkOnline)
  }

  /** Where join credentials come from (the backend's voice-token endpoint). */
  setTokenSource(source: TokenSource): void {
    this.tokenSource = source
  }

  /** Leaves voice and releases every resource. The session can be activated again later. */
  async deactivate(): Promise<void> {
    window.removeEventListener('online', this.onNetworkOnline)
    await this.leave()
    this.audioContainer?.remove()
    this.audioContainer = null
  }

  private container(): HTMLDivElement {
    if (!this.audioContainer) {
      this.audioContainer = document.createElement('div')
      this.audioContainer.hidden = true
      this.audioContainer.dataset.d2 = 'voice-audio'
      document.body.appendChild(this.audioContainer)
    }
    return this.audioContainer
  }

  // ---- Observable state (useSyncExternalStore) ----

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): MediaSnapshot => this.snapshot

  private set(patch: Partial<MediaSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** True while any microphone MediaStreamTrack we opened is still live (device capturing). */
  isCapturing(): boolean {
    return [...this.capturedTracks].some((t) => t.readyState === 'live')
  }

  // ---- Public API ----

  async join(channelId: string): Promise<void> {
    const s = this.snapshot
    if (this.desiredChannel === channelId && s.status !== 'error' && s.status !== 'disconnected') {
      return
    }
    this.desiredChannel = channelId
    this.rejoinAttempt = 0
    this.clearRejoinTimer()
    await this.connect(channelId)
  }

  async leave(): Promise<void> {
    this.desiredChannel = null
    this.joinSeq++
    this.clearRejoinTimer()
    await this.teardownRoom()
    this.set({ ...INITIAL })
  }

  /** Retry after an error or a give-up. */
  retry(): void {
    const channelId = this.snapshot.channelId
    if (channelId) void this.join(channelId)
  }

  setMicState(next: MicState): void {
    const deafenChanged = next.deafened !== this.micState.deafened
    this.micState = next
    this.applyMic()
    if (deafenChanged) this.applyDeafen()
  }

  setPreferences(next: MediaPreferences): void {
    const prev = this.prefs
    this.prefs = next
    const room = this.room
    if (!room) return

    if (next.inputDeviceId !== prev.inputDeviceId) {
      void room
        .switchActiveDevice('audioinput', next.inputDeviceId || 'default')
        .then(() => this.trackCaptured())
        .catch((err) => this.set({ micError: micErrorMessage(err) }))
    }
    if (next.outputDeviceId !== prev.outputDeviceId) {
      void room.switchActiveDevice('audiooutput', next.outputDeviceId || 'default').catch(() => {
        // Output selection is best-effort (setSinkId support varies).
      })
    }
    if (
      next.echoCancellation !== prev.echoCancellation ||
      next.noiseSuppression !== prev.noiseSuppression ||
      next.autoGainControl !== prev.autoGainControl
    ) {
      const track = this.localMicTrack()
      if (track) {
        void track
          .restartTrack(this.captureOptions())
          .then(() => this.trackCaptured())
          .catch((err) => this.set({ micError: micErrorMessage(err) }))
      }
    }
    if (next.inputVolume !== prev.inputVolume) this.gain?.setGain(next.inputVolume / 100)
    if (next.outputVolume !== prev.outputVolume || next.userVolumes !== prev.userVolumes) {
      this.applyVolumes()
    }
  }

  // ---- Connection lifecycle ----

  private async connect(channelId: string): Promise<void> {
    const seq = ++this.joinSeq
    await this.teardownRoom()
    if (seq !== this.joinSeq) return

    this.set({
      status: this.rejoinAttempt > 0 ? 'reconnecting' : 'connecting',
      channelId,
      retryInMs: undefined,
      participants: []
    })

    let grant: ApiVoiceToken
    try {
      if (!this.tokenSource) throw new Error('Voice is not ready yet.')
      grant = await this.tokenSource(channelId)
    } catch (err) {
      if (seq !== this.joinSeq) return
      if (this.deps.isFatalError(err)) return this.fail(this.deps.describeError(err))
      return this.scheduleRejoin(this.deps.describeError(err))
    }
    if (seq !== this.joinSeq) return

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      // Routes playback through Web Audio so per-user volume can exceed 100%.
      webAudioMix: true,
      audioCaptureDefaults: this.captureOptions(),
      audioOutput: this.prefs.outputDeviceId ? { deviceId: this.prefs.outputDeviceId } : undefined,
      publishDefaults: {
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
        // Keep the device open while muted so push-to-talk engages instantly.
        stopMicTrackOnMute: false
      }
    })
    this.room = room
    this.wire(room)

    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: !this.micState.deafened })
    } catch (err) {
      if (seq !== this.joinSeq) return
      room.removeAllListeners()
      this.room = null
      await room.disconnect().catch(() => undefined)
      const detail = err instanceof Error ? err.message : String(err)
      return this.scheduleRejoin(`Could not reach the voice server (${detail}).`)
    }
    if (seq !== this.joinSeq) {
      await room.disconnect()
      return
    }

    this.rejoinAttempt = 0
    this.set({ status: 'connected', error: undefined, micError: undefined, retryInMs: undefined })
    this.applyDeafen()
    this.applyVolumes()
    this.applyMic()
    this.refreshParticipants()
  }

  private wire(room: Room): void {
    const refresh = (): void => this.refreshParticipants()

    room
      .on(RoomEvent.Reconnecting, () => this.set({ status: 'reconnecting', retryInMs: undefined }))
      .on(RoomEvent.SignalReconnecting, () => this.set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.set({ status: 'connected', error: undefined })
        refresh()
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(room, reason))
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => {
        if (pub.kind === Track.Kind.Audio && this.micState.deafened) pub.setSubscribed(false)
        refresh()
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return
        const element = track.attach()
        element.dataset.identity = participant.identity
        element.dataset.trackSid = track.sid
        this.container().appendChild(element)
        participant.setVolume(
          playbackVolume(this.prefs.outputVolume, this.prefs.userVolumes[participant.identity])
        )
        refresh()
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) el.remove()
        // LiveKit may already have detached the element itself; remove anything we attached.
        for (const el of [...(this.audioContainer?.children ?? [])]) {
          if ((el as HTMLElement).dataset.trackSid === track.sid) {
            ;(el as HTMLMediaElement).srcObject = null
            el.remove()
          }
        }
        refresh()
      })
      .on(RoomEvent.MediaDevicesError, (err: Error) => this.set({ micError: micErrorMessage(err) }))
  }

  private onDisconnected(room: Room, reason?: DisconnectReason): void {
    if (room !== this.room) return
    this.room = null
    void this.teardownRoom()
    if (this.desiredChannel && shouldAutoRejoin(reason)) {
      this.scheduleRejoin(describeDisconnect(reason))
      return
    }
    this.desiredChannel = null
    if (reason === DisconnectReason.CLIENT_INITIATED) {
      this.set({ ...INITIAL })
    } else {
      this.set({ status: 'disconnected', error: describeDisconnect(reason), participants: [] })
    }
  }

  private scheduleRejoin(message: string): void {
    const channelId = this.desiredChannel
    if (!channelId) return
    if (this.rejoinAttempt >= REJOIN_MAX_ATTEMPTS) {
      return this.fail(`${message} Gave up after ${REJOIN_MAX_ATTEMPTS} attempts.`)
    }
    const delay = backoffDelay(this.rejoinAttempt++)
    this.set({
      status: 'reconnecting',
      channelId,
      error: message,
      retryInMs: delay,
      participants: []
    })
    this.clearRejoinTimer()
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null
      if (this.desiredChannel === channelId) void this.connect(channelId)
    }, delay)
  }

  private fail(message: string): void {
    this.desiredChannel = null
    this.clearRejoinTimer()
    void this.teardownRoom()
    this.set({ status: 'error', error: message, retryInMs: undefined, participants: [] })
  }

  private readonly onNetworkOnline = (): void => {
    if (this.rejoinTimer && this.desiredChannel) {
      this.clearRejoinTimer()
      void this.connect(this.desiredChannel)
    }
  }

  private clearRejoinTimer(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer)
    this.rejoinTimer = null
  }

  /** Disconnects and releases every media resource (mic device, processors, audio elements). */
  private async teardownRoom(): Promise<void> {
    const room = this.room
    this.room = null
    if (room) {
      room.removeAllListeners()
      const localTracks = [...room.localParticipant.trackPublications.values()]
        .map((pub) => pub.track)
        .filter((t) => t !== undefined)
      await room.disconnect(true).catch(() => undefined)
      for (const track of localTracks) track.stop()
    }
    for (const track of this.capturedTracks) track.stop()
    this.capturedTracks.clear()
    this.gain = null
    for (const el of [...(this.audioContainer?.children ?? [])]) {
      ;(el as HTMLMediaElement).srcObject = null
      el.remove()
    }
    const ctx = this.micAudioContext
    this.micAudioContext = null
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined)
  }

  // ---- Local microphone ----

  private captureOptions(): AudioCaptureOptions {
    return {
      deviceId: this.prefs.inputDeviceId || undefined,
      echoCancellation: this.prefs.echoCancellation,
      noiseSuppression: this.prefs.noiseSuppression,
      autoGainControl: this.prefs.autoGainControl
    }
  }

  private localMicTrack(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
      LocalAudioTrack | undefined
  }

  private trackCaptured(): void {
    const track = this.localMicTrack()
    // Before a processor is attached this is the raw capture track; afterwards the
    // processor reports raw tracks itself (see attachGain).
    if (track && !track.getProcessor()) this.capturedTracks.add(track.mediaStreamTrack)
  }

  /** Serialized so rapid push-to-talk presses can't interleave publish/mute calls. */
  private applyMic(): void {
    this.micQueue = this.micQueue.then(() => this.doApplyMic()).catch(() => undefined)
  }

  private async doApplyMic(): Promise<void> {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return
    const lp = room.localParticipant
    const transmit = micShouldTransmit(this.micState)
    const published = lp.getTrackPublication(Track.Source.Microphone)
    try {
      if (!published) {
        // In push-to-talk mode publish (muted) up front so the first key press is instant.
        const prewarm = this.micState.pushToTalk && !this.micState.muted && !this.micState.deafened
        if (!transmit && !prewarm) return
        await lp.setMicrophoneEnabled(true)
        this.trackCaptured()
        await this.attachGain()
        if (!transmit) await lp.setMicrophoneEnabled(false)
      } else {
        await lp.setMicrophoneEnabled(transmit)
      }
      if (this.snapshot.micError) this.set({ micError: undefined })
    } catch (err) {
      this.set({ micError: micErrorMessage(err) })
    }
    this.refreshParticipants()
  }

  private async attachGain(): Promise<void> {
    const track = this.localMicTrack()
    if (!track) return
    try {
      this.micAudioContext ??= new AudioContext()
      await track.setAudioContext(this.micAudioContext)
      this.gain = new GainProcessor(this.prefs.inputVolume / 100, (raw) =>
        this.capturedTracks.add(raw)
      )
      await track.setProcessor(this.gain)
    } catch (err) {
      // Not fatal: the raw microphone is still published, just without the gain stage.
      console.warn('[voice] input gain unavailable', err)
      this.gain = null
    }
  }

  // ---- Remote audio ----

  private applyDeafen(): void {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return
    const deafened = this.micState.deafened
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(!deafened)
    }
    void room.localParticipant
      .setAttributes({ deafened: deafened ? '1' : '0' })
      .catch(() => undefined)
  }

  private applyVolumes(): void {
    const room = this.room
    if (!room) return
    for (const participant of room.remoteParticipants.values()) {
      participant.setVolume(
        playbackVolume(this.prefs.outputVolume, this.prefs.userVolumes[participant.identity])
      )
    }
  }

  private refreshParticipants(): void {
    const room = this.room
    if (!room) return
    const speakers = new Set(room.activeSpeakers.map((p) => p.identity))
    const describe = (p: Participant): VoiceParticipant => ({
      identity: p.identity,
      isLocal: p.isLocal,
      speaking: speakers.has(p.identity),
      micEnabled: p.isMicrophoneEnabled,
      deafened: p.attributes?.deafened === '1'
    })
    this.set({
      participants: [room.localParticipant, ...room.remoteParticipants.values()].map(describe)
    })
  }
}
