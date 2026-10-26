import {
  captureConstraints,
  SCREEN_PROFILES,
  type ScreenCodec,
  type ScreenContentHint,
  type ScreenProfile,
  type ScreenProfileId
} from './screenProfiles'

/**
 * Screen-share lifecycle, independent of LiveKit and the DOM so it can be unit tested.
 * MediaSession supplies the real capture/publish functions.
 *
 * Invariants:
 * - at most one capture session at a time (starting a new share stops the old one first);
 * - every exit path (stop, leave, disconnect, source ended, failure) stops all captured tracks;
 * - audio is only reported "live" when a live audio track was actually published.
 */

export type ScreenShareStatus = 'idle' | 'starting' | 'live' | 'error'
export type ScreenAudioStatus = 'off' | 'live' | 'unavailable' | 'failed'
export type StopReason = 'user' | 'left' | 'disconnected' | 'source-ended' | 'replaced'

export interface ScreenSource {
  id: string
  name: string
}

export interface ScreenShareOptions {
  profileId: ScreenProfileId
  audio: boolean
  hint: ScreenContentHint
  codec: ScreenCodec
}

export interface CapturedScreen {
  video: MediaStreamTrack
  audio?: MediaStreamTrack
}

/** Resolves to a function that unpublishes the track (without stopping it). */
export type Unpublish = () => Promise<void>

export interface ScreenShareDeps {
  capture: (
    source: ScreenSource,
    options: ScreenShareOptions,
    profile: ScreenProfile
  ) => Promise<CapturedScreen>
  publishVideo: (
    track: MediaStreamTrack,
    options: ScreenShareOptions,
    profile: ScreenProfile
  ) => Promise<Unpublish>
  publishAudio: (track: MediaStreamTrack) => Promise<Unpublish>
}

export interface ScreenShareState {
  status: ScreenShareStatus
  sourceName?: string
  options?: ScreenShareOptions
  audio: ScreenAudioStatus
  /** true when the OS confirmed our own playback is excluded from shared audio (no echo). */
  audioEchoProtected?: boolean
  /** Actual capture size/frame rate reported by the track. */
  capture?: { width?: number; height?: number; fps?: number }
  error?: string
  /** Informational message after an automatic stop (e.g. the shared window closed). */
  notice?: string
}

const IDLE: ScreenShareState = { status: 'idle', audio: 'off' }

export function describeCaptureError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
      return 'Screen capture was blocked or cancelled.'
    case 'NotFoundError':
      return 'That window or screen is no longer available.'
    case 'NotReadableError':
    case 'AbortError':
      return 'Windows could not capture this source. It may be protected (DRM/secure content) or minimized.'
    case 'OverconstrainedError':
      return 'This source can’t be captured at the selected quality.'
    default:
      return err instanceof Error && err.message ? err.message : 'Screen sharing failed.'
  }
}

const STOP_NOTICES: Partial<Record<StopReason, string>> = {
  'source-ended': 'Your stream ended because the shared window or screen closed.',
  disconnected:
    'Your stream stopped because the voice connection dropped. Share again when reconnected.'
}

function captureInfo(track: MediaStreamTrack): ScreenShareState['capture'] {
  const s = track.getSettings()
  return { width: s.width, height: s.height, fps: s.frameRate }
}

export class ScreenShareController {
  private state: ScreenShareState = IDLE
  private seq = 0
  private video: MediaStreamTrack | null = null
  private audio: MediaStreamTrack | null = null
  private unpublishVideo: Unpublish | null = null
  private unpublishAudio: Unpublish | null = null
  private listeners: AbortController | null = null

  constructor(
    private readonly deps: ScreenShareDeps,
    private readonly onChange: (state: ScreenShareState) => void
  ) {}

  getState(): ScreenShareState {
    return this.state
  }

  /** True while any captured screen track is still live. */
  isCapturing(): boolean {
    return this.video?.readyState === 'live' || this.audio?.readyState === 'live'
  }

  private set(next: ScreenShareState): void {
    this.state = next
    this.onChange(next)
  }

  async start(source: ScreenSource, options: ScreenShareOptions): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'live')
      await this.stop('replaced')
    const seq = ++this.seq
    const profile = SCREEN_PROFILES[options.profileId]
    this.set({ status: 'starting', sourceName: source.name, options, audio: 'off' })

    let captured: CapturedScreen
    try {
      captured = await this.deps.capture(source, options, profile)
    } catch (err) {
      if (seq === this.seq) this.set({ ...IDLE, status: 'error', error: describeCaptureError(err) })
      return
    }
    if (seq !== this.seq) {
      // Stopped while the capture was starting: release it immediately.
      captured.video.stop()
      captured.audio?.stop()
      return
    }

    this.video = captured.video
    this.audio = captured.audio ?? null
    this.listeners = new AbortController()
    const { signal } = this.listeners
    this.video.contentHint = options.hint === 'motion' ? 'motion' : 'detail'
    this.video.addEventListener('ended', () => void this.stop('source-ended'), { signal })

    let unpublishVideo: Unpublish
    try {
      unpublishVideo = await this.deps.publishVideo(this.video, options, profile)
    } catch (err) {
      if (seq !== this.seq) return
      await this.release()
      this.set({
        ...IDLE,
        status: 'error',
        error: `Could not start the stream: ${describeCaptureError(err)}`
      })
      return
    }
    if (seq !== this.seq) {
      // Stopped while publishing: the cleanup already ran, so withdraw this late publication.
      await unpublishVideo().catch(() => undefined)
      return
    }
    this.unpublishVideo = unpublishVideo

    let audioStatus: ScreenAudioStatus = 'off'
    let echoProtected: boolean | undefined
    if (options.audio) {
      const audioTrack = this.audio
      if (!audioTrack || audioTrack.readyState !== 'live') {
        audioTrack?.stop()
        this.audio = null
        audioStatus = 'unavailable'
      } else {
        try {
          const unpublishAudio = await this.deps.publishAudio(audioTrack)
          if (seq !== this.seq) {
            await unpublishAudio().catch(() => undefined)
            return
          }
          this.unpublishAudio = unpublishAudio
          audioStatus = 'live'
          const settings = audioTrack.getSettings() as MediaTrackSettings & {
            restrictOwnAudio?: boolean
          }
          echoProtected = settings.restrictOwnAudio === true
          audioTrack.addEventListener('ended', () => void this.dropAudio('failed'), { signal })
        } catch {
          audioTrack.stop()
          this.audio = null
          audioStatus = 'failed'
        }
      }
    } else if (this.audio) {
      // Audio wasn't requested but the OS returned some anyway: never publish it.
      this.audio.stop()
      this.audio = null
    }
    if (seq !== this.seq) return

    this.set({
      status: 'live',
      sourceName: source.name,
      options,
      audio: audioStatus,
      audioEchoProtected: echoProtected,
      capture: captureInfo(this.video)
    })
  }

  /** Changes quality during a live share by republishing the same captured track (no re-pick). */
  async setProfile(profileId: ScreenProfileId): Promise<void> {
    const current = this.state
    if (current.status !== 'live' || !this.video || !current.options) return
    if (current.options.profileId === profileId) return
    const seq = this.seq
    const options = { ...current.options, profileId }
    const profile = SCREEN_PROFILES[profileId]
    try {
      await this.video.applyConstraints(captureConstraints(profile))
    } catch {
      // Keep the current capture size if the source can't satisfy the new caps.
    }
    try {
      await this.unpublishVideo?.()
      this.unpublishVideo = null
      if (seq !== this.seq || !this.video) return
      const unpublish = await this.deps.publishVideo(this.video, options, profile)
      if (seq !== this.seq) {
        await unpublish().catch(() => undefined)
        return
      }
      this.unpublishVideo = unpublish
      this.set({ ...this.state, options, capture: captureInfo(this.video), error: undefined })
    } catch (err) {
      if (seq !== this.seq) return
      await this.stop('user')
      this.set({
        ...IDLE,
        status: 'error',
        error: `Changing quality failed: ${describeCaptureError(err)}`
      })
    }
  }

  async stop(reason: StopReason = 'user'): Promise<void> {
    this.seq++
    const wasActive = this.state.status === 'live' || this.state.status === 'starting'
    await this.release()
    if (reason === 'replaced') return
    // Repeated automatic stops (e.g. each rejoin attempt) must not wipe the notice from the first.
    if (!wasActive && reason !== 'user' && reason !== 'left') return
    const notice = wasActive ? STOP_NOTICES[reason] : undefined
    this.set({ ...IDLE, notice })
  }

  /** Clears an error/notice without touching anything else. */
  dismiss(): void {
    if (this.state.status === 'error' || this.state.notice) this.set(IDLE)
  }

  private async dropAudio(status: ScreenAudioStatus): Promise<void> {
    const unpublish = this.unpublishAudio
    this.unpublishAudio = null
    this.audio?.stop()
    this.audio = null
    await unpublish?.().catch(() => undefined)
    if (this.state.status === 'live')
      this.set({ ...this.state, audio: status, audioEchoProtected: undefined })
  }

  /** Unpublishes and stops everything. Safe to call repeatedly. */
  private async release(): Promise<void> {
    this.listeners?.abort()
    this.listeners = null
    const video = this.video
    const audio = this.audio
    const unpublishVideo = this.unpublishVideo
    const unpublishAudio = this.unpublishAudio
    this.video = null
    this.audio = null
    this.unpublishVideo = null
    this.unpublishAudio = null
    await Promise.all([
      unpublishVideo?.().catch(() => undefined),
      unpublishAudio?.().catch(() => undefined)
    ])
    // Always stop capture, even if unpublishing failed (e.g. the room is already gone).
    video?.stop()
    audio?.stop()
  }
}
