import {
  CAMERA_PRESETS,
  cameraErrorMessage,
  classifyCameraError,
  namedError,
  type CameraPreset,
  type CameraPresetId
} from './cameraProfiles'

/**
 * Your camera in voice, independent of LiveKit and the DOM so it can be unit tested.
 * MediaSession supplies the real capture/publish functions.
 *
 * Invariants:
 * - the camera only starts from an explicit start() (never on join, rejoin or app start);
 * - at most one capture at a time; a newer start/stop always wins over an older one in flight;
 * - a capture that finishes after it was cancelled (or timed out) is stopped, never published;
 * - every exit path stops the device track first (the camera light goes out immediately) and
 *   then withdraws the publication; stop() is safe to call any number of times.
 */

export type CameraStatus = 'off' | 'starting' | 'on' | 'error'
export type CameraStopReason =
  | 'user'
  | 'left'
  | 'switch'
  | 'disconnected'
  | 'rejoin'
  | 'device-lost'
  | 'not-allowed'
  | 'replaced'

export interface CameraState {
  status: CameraStatus
  presetId: CameraPresetId
  /** The device actually in use while starting/on. */
  deviceId?: string
  deviceLabel?: string
  /** What the camera really delivers (may be less than the preset asks for). */
  capture?: { width?: number; height?: number; fps?: number }
  error?: string
  /** Informational message after an automatic change (fallback device, reconnect…). */
  notice?: string
}

export interface PublishedCamera {
  /** Swaps the published video for another captured track (device change) without unpublishing. */
  replace: (track: MediaStreamTrack) => Promise<void>
  /** Withdraws the publication (the controller stops the device track itself). */
  unpublish: () => Promise<void>
}

export interface CameraDeps {
  capture: (deviceId: string | undefined, preset: CameraPreset) => Promise<MediaStreamTrack>
  publish: (track: MediaStreamTrack, preset: CameraPreset) => Promise<PublishedCamera>
  /** Whether the voice grant allows a camera: null = not known yet. */
  allowed: () => boolean | null
}

export interface CameraOptions {
  /** How long the camera may take to start before we give up (ms). */
  startTimeoutMs?: number
}

const STOP_NOTICES: Partial<Record<CameraStopReason, string>> = {
  rejoin: 'Your camera turned off because voice reconnected. Turn it on again when you’re ready.',
  disconnected: 'Your camera turned off because the voice connection dropped.',
  switch: 'Your camera turned off because you switched voice channels.'
}
const STOP_ERRORS: Partial<Record<CameraStopReason, string>> = {
  'device-lost': 'Your camera was disconnected or stopped working.',
  'not-allowed': 'You can no longer use video in this channel.'
}

function captureInfo(track: MediaStreamTrack): CameraState['capture'] {
  const s = track.getSettings()
  return { width: s.width, height: s.height, fps: s.frameRate }
}

function deviceOf(track: MediaStreamTrack): { deviceId?: string; deviceLabel?: string } {
  return { deviceId: track.getSettings().deviceId, deviceLabel: track.label || undefined }
}

export class CameraController {
  private state: CameraState
  private seq = 0
  private track: MediaStreamTrack | null = null
  private published: PublishedCamera | null = null
  private listeners: AbortController | null = null
  private readonly timeoutMs: number

  constructor(
    private readonly deps: CameraDeps,
    private readonly onChange: (state: CameraState) => void,
    presetId: CameraPresetId,
    options: CameraOptions = {}
  ) {
    this.state = { status: 'off', presetId }
    this.timeoutMs = options.startTimeoutMs ?? 12_000
  }

  getState(): CameraState {
    return this.state
  }

  /** The live device track while the camera is on (self-view / settings preview reuse it). */
  getTrack(): MediaStreamTrack | null {
    return this.track?.readyState === 'live' ? this.track : null
  }

  /** True while the camera device is open. */
  isCapturing(): boolean {
    return this.track?.readyState === 'live'
  }

  private set(next: CameraState): void {
    this.state = next
    this.onChange(next)
  }

  /**
   * Captures with a time limit. If the camera answers after we gave up (or after a newer
   * start/stop), the late track is stopped at once so the device isn't left open.
   */
  private captureOnce(
    deviceId: string | undefined,
    preset: CameraPreset,
    seq: number
  ): Promise<MediaStreamTrack> {
    return new Promise<MediaStreamTrack>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(namedError('TimeoutError', 'Camera start timed out'))
      }, this.timeoutMs)
      this.deps.capture(deviceId, preset).then(
        (track) => {
          clearTimeout(timer)
          if (settled || seq !== this.seq) {
            track.stop()
            if (!settled) {
              settled = true
              reject(namedError('AbortError', 'Cancelled'))
            }
            return
          }
          settled = true
          resolve(track)
        },
        (err: unknown) => {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            reject(err)
          }
        }
      )
    })
  }

  /** Turns the camera on with the given device ('' = system default) and quality. */
  async start(deviceId: string, presetId: CameraPresetId): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'on') return
    const allowed = this.deps.allowed()
    if (allowed === false) {
      this.set({
        status: 'error',
        presetId,
        error: cameraErrorMessage(namedError('CameraUnavailableError', ''))
      })
      return
    }
    const seq = ++this.seq
    const preset = CAMERA_PRESETS[presetId]
    this.set({ status: 'starting', presetId })

    let track: MediaStreamTrack
    let notice: string | undefined
    try {
      try {
        track = await this.captureOnce(deviceId || undefined, preset, seq)
      } catch (err) {
        // The chosen camera is gone (or renamed): use the default one instead, and say so.
        const failure = classifyCameraError(err)
        if (!deviceId || seq !== this.seq || (failure !== 'not-found' && failure !== 'constraints'))
          throw err
        track = await this.captureOnce(undefined, preset, seq)
        notice = 'Your selected camera isn’t available, so your default camera is used.'
      }
    } catch (err) {
      if (seq === this.seq) this.set({ status: 'error', presetId, error: cameraErrorMessage(err) })
      return
    }
    if (seq !== this.seq) {
      track.stop()
      return
    }

    this.track = track
    this.listeners = new AbortController()
    track.addEventListener('ended', () => void this.stop('device-lost'), {
      signal: this.listeners.signal
    })
    let published: PublishedCamera
    try {
      published = await this.deps.publish(track, preset)
    } catch (err) {
      if (seq !== this.seq) return
      await this.release()
      this.set({
        status: 'error',
        presetId,
        error: `Could not turn on your camera: ${cameraErrorMessage(err)}`
      })
      return
    }
    if (seq !== this.seq) {
      // Stopped while publishing: the device is already closed; withdraw this late publication.
      await published.unpublish().catch(() => undefined)
      return
    }
    this.published = published
    this.set({ status: 'on', presetId, ...deviceOf(track), capture: captureInfo(track), notice })
  }

  /** Switches to another camera while on, without unpublishing (viewers keep their tile). */
  async switchDevice(deviceId: string): Promise<void> {
    if (this.state.status !== 'on' || !this.published) return
    const seq = this.seq
    const preset = CAMERA_PRESETS[this.state.presetId]
    let next: MediaStreamTrack
    try {
      next = await this.captureOnce(deviceId || undefined, preset, seq)
    } catch (err) {
      if (seq === this.seq && this.state.status === 'on') {
        this.set({ ...this.state, notice: `Couldn’t switch camera: ${cameraErrorMessage(err)}` })
      }
      return
    }
    if (seq !== this.seq || !this.published) {
      next.stop()
      return
    }
    try {
      await this.published.replace(next)
    } catch (err) {
      next.stop()
      if (seq === this.seq)
        this.set({ ...this.state, notice: `Couldn’t switch camera: ${cameraErrorMessage(err)}` })
      return
    }
    if (seq !== this.seq) {
      next.stop()
      return
    }
    const old = this.track
    this.listeners?.abort()
    this.track = next
    this.listeners = new AbortController()
    next.addEventListener('ended', () => void this.stop('device-lost'), {
      signal: this.listeners.signal
    })
    old?.stop()
    this.set({
      ...this.state,
      ...deviceOf(next),
      capture: captureInfo(next),
      notice: undefined,
      error: undefined
    })
  }

  /**
   * Changes quality. While on, the camera is republished with the new encodings (viewers see a
   * short gap); otherwise it is only remembered for the next start.
   */
  async setPreset(presetId: CameraPresetId, deviceId: string): Promise<void> {
    if (presetId === this.state.presetId) return
    if (this.state.status !== 'on') {
      this.set({ ...this.state, presetId })
      return
    }
    await this.stop('replaced')
    await this.start(deviceId, presetId)
  }

  async stop(reason: CameraStopReason = 'user'): Promise<void> {
    this.seq++
    const prev = this.state
    const wasActive = prev.status === 'starting' || prev.status === 'on'
    const presetId = prev.presetId
    // The new state is set before the (slower) cleanup, so a start() right after a stop() sees
    // the camera as off and quick off/on toggles end in the state the user chose last.
    if (reason === 'replaced') {
      if (wasActive) this.set({ status: 'off', presetId })
    } else if (!wasActive) {
      // Repeated automatic stops (each rejoin attempt) keep the first message; a user stop clears it.
      if ((reason === 'user' || reason === 'left') && (prev.status !== 'off' || prev.notice)) {
        this.set({ status: 'off', presetId })
      }
    } else {
      const error = STOP_ERRORS[reason]
      if (error) this.set({ status: 'error', presetId, error })
      else this.set({ status: 'off', presetId, notice: STOP_NOTICES[reason] })
    }
    await this.release()
  }

  /** Clears an error/notice without touching the camera. */
  dismiss(): void {
    if (this.state.status === 'error') this.set({ status: 'off', presetId: this.state.presetId })
    else if (this.state.notice) this.set({ ...this.state, notice: undefined })
  }

  /** Stops the device first (light off at once), then withdraws the publication. Idempotent. */
  private async release(): Promise<void> {
    this.listeners?.abort()
    this.listeners = null
    const track = this.track
    const published = this.published
    this.track = null
    this.published = null
    track?.stop()
    await published?.unpublish().catch(() => undefined)
  }
}
