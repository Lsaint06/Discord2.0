import { describe, expect, it, vi } from 'vitest'
import {
  ScreenShareController,
  type CapturedScreen,
  type ScreenShareDeps,
  type ScreenShareOptions,
  type ScreenShareState
} from './ScreenShareController'

/** Minimal MediaStreamTrack stand-in built on Node's EventTarget. */
class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  contentHint = ''
  constraints: MediaTrackConstraints[] = []
  constructor(
    readonly kind: 'video' | 'audio',
    private readonly settings: Record<string, unknown> = {}
  ) {
    super()
  }
  stop(): void {
    this.readyState = 'ended'
  }
  /** Simulates the OS ending capture (window closed, monitor unplugged). */
  end(): void {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
  getSettings(): Record<string, unknown> {
    return this.settings
  }
  async applyConstraints(c: MediaTrackConstraints): Promise<void> {
    this.constraints.push(c)
  }
}

const asTrack = (t: FakeTrack): MediaStreamTrack => t as unknown as MediaStreamTrack
const source = { id: 'screen:1:0', name: 'Screen 1' }
const options: ScreenShareOptions = {
  profileId: 'smooth',
  audio: false,
  hint: 'motion',
  codec: 'h264'
}

interface Harness {
  controller: ScreenShareController
  deps: ScreenShareDeps
  video: FakeTrack
  audio: FakeTrack
  published: Set<string>
  states: ScreenShareState[]
}

function setup(overrides: Partial<ScreenShareDeps> = {}, captured?: () => CapturedScreen): Harness {
  const video = new FakeTrack('video', { width: 1920, height: 1080, frameRate: 60 })
  const audio = new FakeTrack('audio', { restrictOwnAudio: true })
  const published = new Set<string>()
  const states: ScreenShareState[] = []
  const deps: ScreenShareDeps = {
    capture: vi.fn(async () => captured?.() ?? { video: asTrack(video) }),
    publishVideo: vi.fn(async () => {
      published.add('video')
      return async () => void published.delete('video')
    }),
    publishAudio: vi.fn(async () => {
      published.add('audio')
      return async () => void published.delete('audio')
    }),
    ...overrides
  }
  const controller = new ScreenShareController(deps, (s) => states.push(s))
  return { controller, deps, video, audio, published, states }
}

describe('ScreenShareController', () => {
  it('starts and stops a share, releasing the capture', async () => {
    const { controller, video, published } = setup()
    await controller.start(source, options)
    expect(controller.getState()).toMatchObject({
      status: 'live',
      sourceName: 'Screen 1',
      audio: 'off',
      capture: { width: 1920, height: 1080, fps: 60 }
    })
    expect(video.contentHint).toBe('motion')
    expect(published.has('video')).toBe(true)
    expect(controller.isCapturing()).toBe(true)

    await controller.stop('user')
    expect(controller.getState().status).toBe('idle')
    expect(published.size).toBe(0)
    expect(video.readyState).toBe('ended')
    expect(controller.isCapturing()).toBe(false)
  })

  it('reports cancelled/denied capture without leaving anything running', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    const { controller, deps } = setup({ capture: vi.fn(async () => Promise.reject(denied)) })
    await controller.start(source, options)
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: 'Screen capture was blocked or cancelled.'
    })
    expect(deps.publishVideo).not.toHaveBeenCalled()
    expect(controller.isCapturing()).toBe(false)
  })

  it('stops automatically when the shared source ends', async () => {
    const { controller, video, published } = setup()
    await controller.start(source, options)
    video.end()
    await vi.waitFor(() => expect(controller.getState().status).toBe('idle'))
    expect(controller.getState().notice).toMatch(/closed/)
    expect(published.size).toBe(0)
  })

  it('publishes system audio separately when available', async () => {
    const { controller, video, audio, published } = setup({}, () => ({
      video: asTrack(video),
      audio: asTrack(audio)
    }))
    await controller.start(source, { ...options, audio: true })
    expect(controller.getState()).toMatchObject({ audio: 'live', audioEchoProtected: true })
    expect(published).toEqual(new Set(['video', 'audio']))
    await controller.stop()
    expect(audio.readyState).toBe('ended')
    expect(published.size).toBe(0)
  })

  it('reports audio as unavailable instead of pretending it is shared', async () => {
    const { controller, deps } = setup()
    await controller.start(source, { ...options, audio: true })
    expect(controller.getState()).toMatchObject({ status: 'live', audio: 'unavailable' })
    expect(deps.publishAudio).not.toHaveBeenCalled()
  })

  it('keeps the video share when audio publishing fails', async () => {
    const { controller, video, audio, published } = setup(
      { publishAudio: vi.fn(async () => Promise.reject(new Error('nope'))) },
      () => ({ video: asTrack(video), audio: asTrack(audio) })
    )
    await controller.start(source, { ...options, audio: true })
    expect(controller.getState()).toMatchObject({ status: 'live', audio: 'failed' })
    expect(audio.readyState).toBe('ended')
    expect(published).toEqual(new Set(['video']))
  })

  it('never publishes audio that was not requested', async () => {
    const { controller, video, audio, deps } = setup({}, () => ({
      video: asTrack(video),
      audio: asTrack(audio)
    }))
    await controller.start(source, options)
    expect(deps.publishAudio).not.toHaveBeenCalled()
    expect(audio.readyState).toBe('ended')
  })

  it('changes quality by republishing the same capture (no new capture)', async () => {
    const { controller, deps, video } = setup()
    await controller.start(source, options)
    await controller.setProfile('high')
    expect(deps.capture).toHaveBeenCalledTimes(1)
    expect(deps.publishVideo).toHaveBeenCalledTimes(2)
    expect(video.constraints.at(-1)).toEqual({
      width: { max: 2560 },
      height: { max: 1440 },
      frameRate: { ideal: 60, max: 60 }
    })
    expect(controller.getState()).toMatchObject({ status: 'live', options: { profileId: 'high' } })
    expect(video.readyState).toBe('live')
  })

  it('allows only one capture at a time', async () => {
    const first = new FakeTrack('video')
    const second = new FakeTrack('video')
    let n = 0
    const { controller } = setup({}, () => ({ video: asTrack(n++ === 0 ? first : second) }))
    await controller.start(source, options)
    await controller.start({ id: 'window:9:0', name: 'Game' }, options)
    expect(first.readyState).toBe('ended')
    expect(second.readyState).toBe('live')
    expect(controller.getState().sourceName).toBe('Game')
  })

  it('releases a capture that finishes after the share was cancelled', async () => {
    const video = new FakeTrack('video')
    let resolve!: (c: CapturedScreen) => void
    const { controller, deps } = setup({
      capture: vi.fn(() => new Promise<CapturedScreen>((r) => (resolve = r)))
    })
    const starting = controller.start(source, options)
    await controller.stop('left')
    resolve({ video: asTrack(video) })
    await starting
    expect(video.readyState).toBe('ended')
    expect(deps.publishVideo).not.toHaveBeenCalled()
    expect(controller.getState().status).toBe('idle')
  })

  it('withdraws a publication that completes after stop', async () => {
    let finishPublish!: () => void
    const published = new Set<string>()
    const { controller, video } = setup({
      publishVideo: vi.fn(
        () =>
          new Promise<() => Promise<void>>((r) => {
            finishPublish = () => {
              published.add('video')
              r(async () => void published.delete('video'))
            }
          })
      )
    })
    const starting = controller.start(source, options)
    await vi.waitFor(() => expect(finishPublish).toBeTypeOf('function'))
    await controller.stop('left') // e.g. user switched voice channels mid-start
    finishPublish()
    await starting
    expect(published.size).toBe(0)
    expect(video.readyState).toBe('ended')
  })

  it('explains why the stream stopped after a disconnect', async () => {
    const { controller } = setup()
    await controller.start(source, options)
    await controller.stop('disconnected')
    expect(controller.getState()).toMatchObject({
      status: 'idle',
      notice: expect.stringMatching(/voice connection/)
    })
    // Rejoin attempts stop again while idle; the notice must survive them.
    await controller.stop('disconnected')
    expect(controller.getState().notice).toMatch(/voice connection/)
    controller.dismiss()
    expect(controller.getState().notice).toBeUndefined()
  })
})
