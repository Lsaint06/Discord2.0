import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'
import type { ApiVoiceToken } from '../net/protocol'
import { GainProcessor } from './GainProcessor'
import {
  CameraController,
  type CameraState,
  type CameraStopReason,
  type PublishedCamera
} from './CameraController'
import {
  cameraAllowedBy,
  cameraConstraints,
  cameraEncodings,
  namedError,
  type CameraPreset,
  type CameraPresetId
} from './cameraProfiles'
import {
  ScreenShareController,
  type CapturedScreen,
  type ScreenShareOptions,
  type ScreenShareState,
  type ScreenSource
} from './ScreenShareController'
import {
  captureConstraints,
  degradationPreference,
  scaledBitrate,
  videoPublishPlan,
  type ScreenProfile,
  type ScreenProfileId
} from './screenProfiles'
import { shouldSubscribe } from './subscriptions'
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
  /** Publishing a screen share in this room. */
  sharingScreen: boolean
  /** Publishing system audio with the screen share. */
  sharingAudio: boolean
  /** Milestone 14.5: publishing a camera that isn't paused. */
  cameraOn: boolean
}

export type ConnectionQualityLabel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

export interface MediaSnapshot {
  status: VoiceStatus
  /** Channel we're connected/connecting to (also kept on error so the UI can offer a retry). */
  channelId: string | null
  error?: string
  /** Problem with the local microphone; we stay connected and can still listen. */
  micError?: string
  /** Informational device message (e.g. a headset was unplugged and we fell back). */
  deviceNotice?: string
  retryInMs?: number
  participants: VoiceParticipant[]
  /** Identity whose screen share we're watching (may be ourselves for a preview). */
  watching: string | null
  /** Bumped whenever a watchable video track appears/disappears so viewers re-attach. */
  streamRevision: number
  screenShare: ScreenShareState
  connectionQuality: ConnectionQualityLabel
  /** The browser blocked audio playback until a user gesture (rare in Electron). */
  audioBlocked: boolean
  /** Milestone 14.5: your camera in this call (always 'off' on join; only you turn it on). */
  camera: CameraState
  /** Whether the voice grant allows a camera here (null = not connected / unknown yet). */
  cameraAllowed: boolean | null
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
  /** Per-user volume for shared screen audio (percent), keyed by user id. */
  streamVolumes: Record<string, number>
  /** Manual voice-activity threshold (noise gate). null = automatic (no gate). */
  inputSensitivityDb: number | null
  /** Milestone 14.5: camera device ('' = system default) and quality, used when YOU turn it on. */
  cameraDeviceId: string
  cameraPresetId: CameraPresetId
  /** Receive other people's cameras (on by default). */
  receiveCameras: boolean
}

export interface MediaSessionDeps {
  describeError: (err: unknown) => string
  /** Errors that retrying won't fix (unauthorized, forbidden, not found, voice disabled…). */
  isFatalError: (err: unknown) => boolean
}

export type TokenSource = (channelId: string) => Promise<ApiVoiceToken>

const INITIAL: MediaSnapshot = {
  status: 'idle',
  channelId: null,
  participants: [],
  watching: null,
  streamRevision: 0,
  screenShare: { status: 'idle', audio: 'off' },
  connectionQuality: 'unknown',
  audioBlocked: false,
  camera: { status: 'off', presetId: 'balanced' },
  cameraAllowed: null
}

const QUALITY_LABELS: Record<ConnectionQuality, ConnectionQualityLabel> = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
  [ConnectionQuality.Unknown]: 'unknown'
}

/** Thrown for screen-capture problems detected before getDisplayMedia (e.g. window closed). */
class CaptureError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

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
  private watching: string | null = null
  private streamRevision = 0
  private readonly screen: ScreenShareController
  private readonly camera: CameraController
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
  ) {
    this.screen = new ScreenShareController(
      {
        capture: (source, options, profile) => this.captureScreen(source, options, profile),
        publishVideo: (track, options, profile) => this.publishScreenVideo(track, options, profile),
        publishAudio: (track) => this.publishScreenAudio(track)
      },
      (screenShare) => {
        this.set({ screenShare })
        this.refreshParticipants()
      }
    )
    this.camera = new CameraController(
      {
        capture: (deviceId, preset) => this.captureCamera(deviceId, preset),
        publish: (track, preset) => this.publishCamera(track, preset),
        allowed: () => this.cameraGrant()
      },
      (camera) => {
        this.set({ camera })
        this.refreshParticipants()
      },
      prefs.cameraPresetId
    )
    this.snapshot = { ...INITIAL, camera: this.camera.getState() }
  }

  /** Starts listening for network and device changes. Pair with deactivate(). */
  activate(): void {
    window.addEventListener('online', this.onNetworkOnline)
    navigator.mediaDevices?.addEventListener('devicechange', this.onDeviceChange)
  }

  /** Where join credentials come from (the backend's voice-token endpoint). */
  setTokenSource(source: TokenSource): void {
    this.tokenSource = source
  }

  /** Leaves voice and releases every resource. The session can be activated again later. */
  async deactivate(): Promise<void> {
    window.removeEventListener('online', this.onNetworkOnline)
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange)
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

  /** True while a screen (or system-audio) capture is live. */
  isCapturingScreen(): boolean {
    return this.screen.isCapturing()
  }

  /** True while your camera device is open for the call. */
  isCapturingCamera(): boolean {
    return this.camera.isCapturing()
  }

  // ---- Camera (Milestone 14.5) ----

  /** Turns your camera on in the current call. Never called automatically. */
  async startCamera(): Promise<void> {
    if (this.snapshot.status !== 'connected' || !this.room) return
    await this.camera.start(this.prefs.cameraDeviceId, this.prefs.cameraPresetId)
  }

  /** Turns your camera off at once (the device is released before the publication is withdrawn). */
  async stopCamera(): Promise<void> {
    await this.camera.stop('user')
  }

  dismissCameraMessage(): void {
    this.camera.dismiss()
  }

  /** The live device track while your camera is on (settings preview reuses it). */
  getLocalCameraTrack(): MediaStreamTrack | null {
    return this.camera.getTrack()
  }

  /**
   * The camera track to render for someone in this room: your own while it's on, or a remote
   * camera once it's subscribed. Undefined otherwise (render the avatar instead).
   */
  getCameraTrack(identity: string): Track | undefined {
    const room = this.room
    if (!room) return undefined
    const participant =
      identity === room.localParticipant.identity
        ? room.localParticipant
        : room.remoteParticipants.get(identity)
    const pub = participant?.getTrackPublication(Track.Source.Camera)
    if (!pub || pub.isMuted) return undefined
    return pub.track ?? undefined
  }

  private cameraGrant(): boolean | null {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return null
    const p = room.localParticipant.permissions
    if (!p) return null
    return cameraAllowedBy({
      canPublish: p.canPublish,
      canPublishSources: (p.canPublishSources ?? []).map((s) => Track.sourceFromProto(s))
    })
  }

  private async captureCamera(
    deviceId: string | undefined,
    preset: CameraPreset
  ): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(preset, deviceId),
      audio: false
    })
    for (const t of stream.getAudioTracks()) t.stop()
    const [track] = stream.getVideoTracks()
    if (!track) throw namedError('NotFoundError', 'No camera video was captured.')
    track.contentHint = 'motion'
    return track
  }

  private async publishCamera(
    track: MediaStreamTrack,
    preset: CameraPreset
  ): Promise<PublishedCamera> {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected)
      throw new Error('Not connected to voice.')
    const s = track.getSettings()
    const encodings = cameraEncodings(preset, {
      width: s.width,
      height: s.height,
      fps: s.frameRate
    })
    const pub = await room.localParticipant.publishTrack(track, {
      // Its own source: viewers can always tell a camera from a screen share.
      source: Track.Source.Camera,
      name: 'camera',
      videoCodec: 'vp8',
      backupCodec: false,
      simulcast: encodings.layers.length > 0,
      videoEncoding: { maxBitrate: encodings.maxBitrate, maxFramerate: encodings.maxFramerate },
      videoSimulcastLayers: encodings.layers.map(
        (l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.fps)
      ),
      degradationPreference: 'balanced'
    })
    this.bumpStreams()
    return {
      replace: async (next) => {
        const local = pub.track as LocalVideoTrack | undefined
        if (!local) throw new Error('Your camera is no longer published.')
        // true = we own the device track (the controller stops it), LiveKit won't restart it.
        await local.replaceTrack(next, true)
        this.bumpStreams()
      },
      unpublish: async () => {
        if (pub.track && this.room === room) {
          await room.localParticipant.unpublishTrack(pub.track, false).catch(() => undefined)
        }
        this.bumpStreams()
      }
    }
  }

  /** Current microphone level in dBFS (pre-gate), or null when not capturing. */
  getInputLevelDb(): number | null {
    return this.gain?.getLevelDb() ?? null
  }

  // ---- Screen sharing ----

  /** Starts sharing a source the user explicitly picked. Voice is unaffected. */
  async startScreenShare(source: ScreenSource, options: ScreenShareOptions): Promise<void> {
    if (this.snapshot.status !== 'connected' || !this.room) {
      this.set({
        screenShare: {
          status: 'error',
          audio: 'off',
          error: 'Join a voice channel before sharing.'
        }
      })
      return
    }
    await this.screen.start(source, options)
  }

  async stopScreenShare(): Promise<void> {
    await this.screen.stop('user')
  }

  async setScreenShareProfile(profileId: ScreenProfileId): Promise<void> {
    await this.screen.setProfile(profileId)
  }

  dismissScreenShareMessage(): void {
    this.screen.dismiss()
  }

  /** Watch someone's stream (or null to stop). Only the watched stream is subscribed/decoded. */
  watch(identity: string | null): void {
    if (this.watching === identity) return
    this.watching = identity
    this.set({ watching: identity })
    this.applySubscriptions()
  }

  /** The video track to render for a watched identity (local preview for ourselves). */
  getScreenTrack(identity: string): Track | undefined {
    const room = this.room
    if (!room) return undefined
    const participant =
      identity === room.localParticipant.identity
        ? room.localParticipant
        : room.remoteParticipants.get(identity)
    return participant?.getTrackPublication(Track.Source.ScreenShare)?.track ?? undefined
  }

  /** Tracks the diagnostics panel can sample. */
  getStatsTargets(): { localScreen?: Track; watched?: Track; microphone?: Track } {
    const room = this.room
    if (!room) return {}
    const local = room.localParticipant
    return {
      localScreen: local.getTrackPublication(Track.Source.ScreenShare)?.track,
      watched:
        this.watching && this.watching !== local.identity
          ? this.getScreenTrack(this.watching)
          : undefined,
      microphone: local.getTrackPublication(Track.Source.Microphone)?.track
    }
  }

  /**
   * Audio tracks for the voice connection panel: your published microphone (sender stats) and
   * every subscribed remote voice (receiver stats), keyed by track sid.
   */
  getConnectionStatTracks(): { microphone?: Track; remoteAudio: Map<string, Track> } {
    const room = this.room
    const remoteAudio = new Map<string, Track>()
    if (!room || room.state !== ConnectionState.Connected) return { remoteAudio }
    for (const participant of room.remoteParticipants.values()) {
      const pub = participant.getTrackPublication(Track.Source.Microphone)
      if (pub?.track && pub.isSubscribed) remoteAudio.set(pub.trackSid, pub.track)
    }
    return {
      microphone: room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track,
      remoteAudio
    }
  }

  /** Resumes audio playback if the browser blocked it (needs a user gesture). */
  async startAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => undefined)
    this.set({ audioBlocked: this.room ? !this.room.canPlaybackAudio : false })
  }

  dismissDeviceNotice(): void {
    if (this.snapshot.deviceNotice) this.set({ deviceNotice: undefined })
  }

  private async captureScreen(
    source: ScreenSource,
    options: ScreenShareOptions,
    profile: ScreenProfile
  ): Promise<CapturedScreen> {
    const bridge = window.d2
    if (bridge) {
      // Arm exactly this source in the main process; getDisplayMedia is denied otherwise.
      const armed = await bridge.screen.select(source.id, { audio: options.audio })
      if (!armed.ok) {
        throw new CaptureError(
          'NotFoundError',
          armed.error === 'source-gone'
            ? 'That window or screen is no longer available.'
            : 'That source can’t be shared.'
        )
      }
    }
    const audio: MediaTrackConstraints | false = options.audio
      ? ({
          // Exclude Discord 2.0's own playback (voices) from system audio where the OS allows.
          restrictOwnAudio: true,
          suppressLocalAudioPlayback: false,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        } as MediaTrackConstraints)
      : false
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(profile),
      audio
    })
    const [video] = stream.getVideoTracks()
    if (!video) {
      for (const t of stream.getTracks()) t.stop()
      throw new CaptureError('NotFoundError', 'No video was captured from that source.')
    }
    return { video, audio: stream.getAudioTracks()[0] }
  }

  private async publishScreenVideo(
    track: MediaStreamTrack,
    options: ScreenShareOptions,
    profile: ScreenProfile
  ): Promise<() => Promise<void>> {
    const room = this.room
    if (!room) throw new Error('Not connected to voice.')
    const settings = track.getSettings()
    const actual = {
      width: settings.width ?? profile.width,
      height: settings.height ?? profile.height,
      fps: settings.frameRate ?? profile.fps
    }
    const plan = videoPublishPlan(
      options.codec,
      options.layering ?? 'simulcast',
      actual,
      options.backupLayer ?? true
    )
    const pub = await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      videoCodec: options.codec,
      screenShareEncoding: {
        maxBitrate: scaledBitrate(profile, actual),
        maxFramerate: profile.fps,
        priority: 'high'
      },
      simulcast: plan.simulcast,
      scalabilityMode: plan.scalabilityMode,
      screenShareSimulcastLayers: plan.layers.map(
        (l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.fps)
      ),
      // Every Discord 2.0 client decodes H.264/VP9/AV1, so a VP8 backup stream would only
      // cost the sharer encoder time.
      backupCodec: false,
      degradationPreference: degradationPreference(options.hint)
    })
    this.bumpStreams()
    return async () => {
      // Keep the capture alive: the controller decides when to stop it.
      if (pub.track) await room.localParticipant.unpublishTrack(pub.track, false)
      this.bumpStreams()
    }
  }

  private async publishScreenAudio(track: MediaStreamTrack): Promise<() => Promise<void>> {
    const room = this.room
    if (!room) throw new Error('Not connected to voice.')
    const pub: LocalTrackPublication = await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      name: 'screen-audio',
      audioPreset: AudioPresets.musicHighQualityStereo,
      forceStereo: true,
      dtx: false,
      red: false
    })
    return async () => {
      if (pub.track) await room.localParticipant.unpublishTrack(pub.track, false)
    }
  }

  private bumpStreams(): void {
    this.streamRevision++
    this.set({ streamRevision: this.streamRevision })
    this.refreshParticipants()
  }

  // ---- Public API ----

  /** Joins (or switches to) a voice channel; optionally starts watching someone's stream there. */
  async join(channelId: string, options: { watch?: string } = {}): Promise<void> {
    const s = this.snapshot
    if (this.desiredChannel === channelId && s.status !== 'error' && s.status !== 'disconnected') {
      if (options.watch) this.watch(options.watch)
      return
    }
    // Streams belong to a room: switching channels stops watching the old one.
    if (channelId !== s.channelId || options.watch) {
      this.watching = options.watch ?? null
      this.set({ watching: this.watching })
    }
    this.desiredChannel = channelId
    this.rejoinAttempt = 0
    this.clearRejoinTimer()
    await this.connect(channelId)
  }

  async leave(): Promise<void> {
    this.desiredChannel = null
    const seq = ++this.joinSeq
    this.clearRejoinTimer()
    this.watching = null
    // You've left as soon as you ask to: the panel, your icon and the disconnect sound update now,
    // while the connection and devices are released in the background (closing the connection
    // can take a moment).
    const teardown = this.teardownRoom('left', 'left')
    this.set({ ...INITIAL, screenShare: this.screen.getState(), camera: this.camera.getState() })
    await teardown
    // A join started meanwhile owns the state now.
    if (seq === this.joinSeq)
      this.set({ screenShare: this.screen.getState(), camera: this.camera.getState() })
  }

  /** Retry after an error or a give-up. */
  retry(): void {
    const channelId = this.snapshot.channelId
    if (channelId) void this.join(channelId)
  }

  setMicState(next: MicState): void {
    const deafenChanged = next.deafened !== this.micState.deafened
    const modeChanged = next.pushToTalk !== this.micState.pushToTalk
    this.micState = next
    this.applyMic()
    if (deafenChanged) this.applyDeafen()
    if (modeChanged) this.applyGate()
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
      // Also used when LiveKit re-acquires the microphone itself (device change, republish).
      room.options.audioCaptureDefaults = this.captureOptions()
      const track = this.localMicTrack()
      if (track) {
        void track
          .restartTrack(this.captureOptions())
          .then(() => this.trackCaptured())
          .catch((err) => this.set({ micError: micErrorMessage(err) }))
      }
    }
    if (next.inputVolume !== prev.inputVolume) this.gain?.setGain(next.inputVolume / 100)
    if (next.inputSensitivityDb !== prev.inputSensitivityDb) this.applyGate()
    if (
      next.outputVolume !== prev.outputVolume ||
      next.userVolumes !== prev.userVolumes ||
      next.streamVolumes !== prev.streamVolumes
    ) {
      this.applyVolumes()
    }
    if (next.cameraDeviceId !== prev.cameraDeviceId)
      void this.camera.switchDevice(next.cameraDeviceId)
    if (next.cameraPresetId !== prev.cameraPresetId) {
      void this.camera.setPreset(next.cameraPresetId, next.cameraDeviceId)
    }
    if (next.receiveCameras !== prev.receiveCameras) {
      this.applySubscriptions()
      this.bumpStreams()
    }
  }

  // ---- Connection lifecycle ----

  private async connect(channelId: string): Promise<void> {
    const seq = ++this.joinSeq
    // Switching channels (or rejoining) always ends any screen share and camera from the previous
    // room. The camera is never turned back on by itself: the user does that in the new room.
    const cameraReason: CameraStopReason =
      this.rejoinAttempt > 0
        ? 'rejoin'
        : this.snapshot.channelId && this.snapshot.channelId !== channelId
          ? 'switch'
          : 'left'
    await this.teardownRoom(this.room ? 'left' : 'disconnected', cameraReason)
    if (seq !== this.joinSeq) return

    this.set({
      status: this.rejoinAttempt > 0 ? 'reconnecting' : 'connecting',
      channelId,
      retryInMs: undefined,
      participants: [],
      connectionQuality: 'unknown',
      cameraAllowed: null
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
      // Manual subscriptions: see applySubscriptions() / subscriptions.ts.
      await room.connect(grant.url, grant.token, { autoSubscribe: false })
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
    this.set({
      status: 'connected',
      error: undefined,
      micError: undefined,
      retryInMs: undefined,
      audioBlocked: !room.canPlaybackAudio,
      cameraAllowed: this.cameraGrant()
    })
    this.applyDeafen()
    this.applySubscriptions()
    this.applyVolumes()
    this.applyMic()
    this.refreshParticipants()
  }

  private wire(room: Room): void {
    const refresh = (): void => this.refreshParticipants()
    const resubscribe = (): void => {
      this.applySubscriptions()
      refresh()
    }

    room
      .on(RoomEvent.Reconnecting, () => this.set({ status: 'reconnecting', retryInMs: undefined }))
      .on(RoomEvent.SignalReconnecting, () => this.set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.set({ status: 'connected', error: undefined })
        resubscribe()
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(room, reason))
      .on(RoomEvent.ParticipantConnected, resubscribe)
      .on(RoomEvent.ParticipantDisconnected, () => this.bumpStreams())
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.TrackPublished, resubscribe)
      .on(RoomEvent.TrackUnpublished, () => this.bumpStreams())
      .on(
        RoomEvent.ConnectionQualityChanged,
        (quality: ConnectionQuality, participant: Participant) => {
          if (participant.isLocal)
            this.set({ connectionQuality: QUALITY_LABELS[quality] ?? 'unknown' })
        }
      )
      .on(RoomEvent.AudioPlaybackStatusChanged, () =>
        this.set({ audioBlocked: !room.canPlaybackAudio })
      )
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, pub: RemoteTrackPublication, participant) => {
          if (track.kind === Track.Kind.Video) {
            // Rendered by the stream viewer (which attaches/detaches its own element).
            this.bumpStreams()
            return
          }
          const element = track.attach()
          element.dataset.identity = participant.identity
          element.dataset.trackSid = track.sid
          element.dataset.source = pub.source
          this.container().appendChild(element)
          this.applyVolumes()
          refresh()
        }
      )
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) el.remove()
        // LiveKit may already have detached the element itself; remove anything we attached.
        for (const el of [...(this.audioContainer?.children ?? [])]) {
          if ((el as HTMLElement).dataset.trackSid === track.sid) {
            ;(el as HTMLMediaElement).srcObject = null
            el.remove()
          }
        }
        if (track.kind === Track.Kind.Video) this.bumpStreams()
        else refresh()
      })
      .on(RoomEvent.MediaDevicesError, (err: Error) => this.set({ micError: micErrorMessage(err) }))
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev: unknown, participant: Participant) => {
        if (!participant.isLocal) return
        const cameraAllowed = this.cameraGrant()
        this.set({ cameraAllowed })
        // Video permission removed mid-call (role change): the camera goes off at once.
        if (cameraAllowed === false) void this.camera.stop('not-allowed')
      })
  }

  private onDisconnected(room: Room, reason?: DisconnectReason): void {
    if (room !== this.room) return
    this.room = null
    void this.teardownRoom(
      reason === DisconnectReason.CLIENT_INITIATED ? 'left' : 'disconnected',
      reason === DisconnectReason.CLIENT_INITIATED ? 'left' : 'disconnected'
    )
    if (this.desiredChannel && shouldAutoRejoin(reason)) {
      this.scheduleRejoin(describeDisconnect(reason))
      return
    }
    this.desiredChannel = null
    this.watching = null
    if (reason === DisconnectReason.CLIENT_INITIATED) {
      this.set({ ...INITIAL, screenShare: this.screen.getState(), camera: this.camera.getState() })
    } else {
      this.set({
        status: 'disconnected',
        error: describeDisconnect(reason),
        participants: [],
        watching: null
      })
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
    void this.teardownRoom('disconnected', 'disconnected')
    this.set({
      status: 'error',
      error: message,
      retryInMs: undefined,
      participants: [],
      cameraAllowed: null
    })
  }

  private readonly onNetworkOnline = (): void => {
    if (this.rejoinTimer && this.desiredChannel) {
      this.clearRejoinTimer()
      void this.connect(this.desiredChannel)
    }
  }

  /** Hot-plug: fall back to the default device if the selected one disappears. */
  private readonly onDeviceChange = (): void => {
    void (async () => {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
      const has = (kind: MediaDeviceKind, id: string): boolean =>
        devices.some((d) => d.kind === kind && d.deviceId === id)
      const room = this.room
      if (this.prefs.inputDeviceId && !has('audioinput', this.prefs.inputDeviceId)) {
        this.set({
          deviceNotice: 'Your selected microphone was disconnected. Using the default microphone.'
        })
        if (room) {
          await room.switchActiveDevice('audioinput', 'default').catch(() => undefined)
          this.trackCaptured()
        }
      }
      if (this.prefs.outputDeviceId && !has('audiooutput', this.prefs.outputDeviceId)) {
        this.set({
          deviceNotice:
            'Your selected speakers/headset were disconnected. Using the default output.'
        })
        if (room) await room.switchActiveDevice('audiooutput', 'default').catch(() => undefined)
      }
    })()
  }

  private clearRejoinTimer(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer)
    this.rejoinTimer = null
  }

  /**
   * Disconnects and releases every media resource: the camera device first (its light goes out
   * immediately), then the screen capture (so it's cleanly unpublished), then the room, mic
   * device, processors and audio elements.
   */
  private async teardownRoom(
    reason: 'left' | 'disconnected' = 'left',
    cameraReason: CameraStopReason = reason
  ): Promise<void> {
    // Synchronous part of stop(): the camera state and device are released before anything awaits.
    const cameraStopped = this.camera.stop(cameraReason)
    // Detach the room first: events it fires while closing (e.g. the screen share ending) can no
    // longer touch the snapshot, which may already show that we've left.
    const room = this.room
    this.room = null
    await this.screen.stop(reason)
    await cameraStopped
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
        // Pass the current processing settings explicitly: the room's capture defaults were fixed
        // when it connected, so a change made while unpublished would otherwise be ignored.
        await lp.setMicrophoneEnabled(true, this.captureOptions())
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
      this.applyGate()
    } catch (err) {
      // Not fatal: the raw microphone is still published, just without the gain stage.
      console.warn('[voice] input gain unavailable', err)
      this.gain = null
    }
  }

  /** Manual input sensitivity (noise gate) applies to voice activity only, never push-to-talk. */
  private applyGate(): void {
    const threshold = this.prefs.inputSensitivityDb
    this.gain?.setGate(!this.micState.pushToTalk && threshold !== null ? threshold : null)
  }

  // ---- Remote audio & video ----

  private applyDeafen(): void {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return
    this.applySubscriptions()
    void room.localParticipant
      .setAttributes({ deafened: this.micState.deafened ? '1' : '0' })
      .catch(() => undefined)
  }

  /** Subscribe only to what we need: microphones, plus the one stream we're watching. */
  private applySubscriptions(): void {
    const room = this.room
    if (!room || room.state !== ConnectionState.Connected) return
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        const want = shouldSubscribe(pub.source, {
          identity: participant.identity,
          deafened: this.micState.deafened,
          watching: this.watching,
          cameras: this.prefs.receiveCameras
        })
        if (pub.isDesired !== want) pub.setSubscribed(want)
      }
    }
  }

  private applyVolumes(): void {
    const room = this.room
    if (!room) return
    for (const participant of room.remoteParticipants.values()) {
      participant.setVolume(
        playbackVolume(this.prefs.outputVolume, this.prefs.userVolumes[participant.identity]),
        Track.Source.Microphone
      )
      participant.setVolume(
        playbackVolume(this.prefs.outputVolume, this.prefs.streamVolumes[participant.identity]),
        Track.Source.ScreenShareAudio
      )
    }
  }

  private refreshParticipants(): void {
    const room = this.room
    if (!room) return
    const speakers = new Set(room.activeSpeakers.map((p) => p.identity))
    const describe = (p: Participant): VoiceParticipant => {
      const camera = p.getTrackPublication(Track.Source.Camera)
      return {
        identity: p.identity,
        isLocal: p.isLocal,
        speaking: speakers.has(p.identity),
        micEnabled: p.isMicrophoneEnabled,
        deafened: p.attributes?.deafened === '1',
        sharingScreen: p.getTrackPublication(Track.Source.ScreenShare) !== undefined,
        sharingAudio: p.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined,
        cameraOn: camera !== undefined && !camera.isMuted
      }
    }
    this.set({
      participants: [room.localParticipant, ...room.remoteParticipants.values()].map(describe)
    })
  }
}
