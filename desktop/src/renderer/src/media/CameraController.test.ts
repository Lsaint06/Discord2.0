import { describe, expect, it, vi } from 'vitest'
import {
  CameraController,
  type CameraDeps,
  type CameraState,
  type PublishedCamera
} from './CameraController'
import { namedError } from './cameraProfiles'

/** Minimal MediaStreamTrack stand-in built on Node's EventTarget. */
class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  constructor(
    readonly label: string,
    private readonly settings: Record<string, unknown> = { width: 1280, height: 720, frameRate: 30 }
  ) {
    super()
  }
  stop(): void {
    this.readyState = 'ended'
  }
  /** The OS ends capture (camera unplugged, driver crash). */
  end(): void {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
  getSettings(): Record<string, unknown> {
    return { deviceId: this.label, ...this.settings }
  }
}

const asTrack = (t: FakeTrack): MediaStreamTrack => t as unknown as MediaStreamTrack

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  controller: CameraController
  states: CameraState[]
  captured: FakeTrack[]
  published: Set<FakeTrack>
  unpublished: FakeTrack[]
  capture: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
}

function setup(overrides: Partial<CameraDeps> = {}, timeoutMs = 1000): Harness {
  const states: CameraState[] = []
  const captured: FakeTrack[] = []
  const published = new Set<FakeTrack>()
  const unpublished: FakeTrack[] = []
  const capture = vi.fn(async (deviceId: string | undefined) => {
    const t = new FakeTrack(deviceId ?? 'default-cam')
    captured.push(t)
    return asTrack(t)
  })
  const publish = vi.fn(async (track: MediaStreamTrack): Promise<PublishedCamera> => {
    let current = track as unknown as FakeTrack
    published.add(current)
    return {
      replace: async (next) => {
        published.delete(current)
        current = next as unknown as FakeTrack
        published.add(current)
      },
      unpublish: async () => {
        published.delete(current)
        unpublished.push(current)
      }
    }
  })
  const deps: CameraDeps = { capture, publish, allowed: () => true, ...overrides }
  const controller = new CameraController(deps, (s) => states.push(s), 'balanced', {
    startTimeoutMs: timeoutMs
  })
  return {
    controller,
    states,
    captured,
    published,
    unpublished,
    capture: (overrides.capture as ReturnType<typeof vi.fn>) ?? capture,
    publish: (overrides.publish as ReturnType<typeof vi.fn>) ?? publish
  }
}

describe('camera on/off', () => {
  it('starts off and only turns on from an explicit start', async () => {
    const h = setup()
    expect(h.controller.getState()).toEqual({ status: 'off', presetId: 'balanced' })
    expect(h.capture).not.toHaveBeenCalled()
    await h.controller.start('', 'balanced')
    expect(h.states.map((s) => s.status)).toEqual(['starting', 'on'])
    expect(h.controller.getState()).toMatchObject({
      status: 'on',
      deviceLabel: 'default-cam',
      capture: { width: 1280, height: 720, fps: 30 }
    })
    expect(h.published.size).toBe(1)
    expect(h.controller.isCapturing()).toBe(true)
  })

  it('stop releases the device first, then withdraws the publication; repeated stops are harmless', async () => {
    const h = setup()
    await h.controller.start('', 'balanced')
    const track = h.captured[0]!
    await h.controller.stop('user')
    expect(track.readyState).toBe('ended')
    expect(h.published.size).toBe(0)
    expect(h.controller.getState()).toEqual({ status: 'off', presetId: 'balanced' })
    expect(h.controller.isCapturing()).toBe(false)
    await h.controller.stop('user')
    await h.controller.stop('left')
    expect(h.unpublished).toHaveLength(1)
  })

  it('a second start while starting or on does not open the camera twice', async () => {
    const gate = deferred<MediaStreamTrack>()
    const h = setup({ capture: vi.fn(() => gate.promise) })
    const first = h.controller.start('', 'balanced')
    await h.controller.start('', 'balanced')
    gate.resolve(asTrack(new FakeTrack('cam')))
    await first
    expect(h.capture).toHaveBeenCalledTimes(1)
    await h.controller.start('', 'balanced')
    expect(h.capture).toHaveBeenCalledTimes(1)
  })
})

describe('cancellation and races', () => {
  it('turning the camera off while it is starting releases the late capture and never publishes it', async () => {
    const gate = deferred<MediaStreamTrack>()
    const h = setup({ capture: vi.fn(() => gate.promise) })
    const starting = h.controller.start('', 'balanced')
    await h.controller.stop('user')
    const late = new FakeTrack('cam')
    gate.resolve(asTrack(late))
    await starting
    expect(late.readyState).toBe('ended')
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.controller.getState().status).toBe('off')
  })

  it('leaving voice while publishing withdraws the publication as soon as it lands', async () => {
    const gate = deferred<PublishedCamera>()
    const unpublish = vi.fn(async () => undefined)
    const h = setup({ publish: vi.fn(() => gate.promise) })
    const starting = h.controller.start('', 'balanced')
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1))
    await h.controller.stop('left')
    expect(h.captured[0]!.readyState).toBe('ended') // the light goes out immediately
    gate.resolve({ replace: async () => undefined, unpublish })
    await starting
    expect(unpublish).toHaveBeenCalledTimes(1)
    expect(h.controller.getState().status).toBe('off')
  })

  it('turning the camera off while it is still capturing closes the late capture and never publishes', async () => {
    const h = setup()
    const starting = h.controller.start('', 'balanced')
    await h.controller.stop('left')
    await starting
    expect(h.captured.every((t) => t.readyState === 'ended')).toBe(true)
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('rapid on/off/on toggles end with exactly one live camera', async () => {
    const h = setup()
    const a = h.controller.start('', 'balanced')
    const b = h.controller.stop('user')
    const c = h.controller.start('', 'balanced')
    await Promise.all([a, b, c])
    await vi.waitFor(() => expect(h.controller.getState().status).toBe('on'))
    const live = h.captured.filter((t) => t.readyState === 'live')
    expect(live).toHaveLength(1)
    expect(h.published.size).toBe(1)
  })

  it('a camera that never answers times out, and a very late answer is closed at once', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<MediaStreamTrack>()
      const h = setup({ capture: vi.fn(() => gate.promise) }, 5000)
      const starting = h.controller.start('', 'balanced')
      await vi.advanceTimersByTimeAsync(5001)
      await starting
      expect(h.controller.getState()).toMatchObject({ status: 'error' })
      expect(h.controller.getState().error).toMatch(/didn’t start in time/)
      const late = new FakeTrack('cam')
      gate.resolve(asTrack(late))
      await vi.advanceTimersByTimeAsync(0)
      expect(late.readyState).toBe('ended')
      expect(h.publish).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('failures', () => {
  it.each([
    ['NotAllowedError', /Privacy & security → Camera/],
    ['NotFoundError', /No camera was found/],
    ['NotReadableError', /busy in another app/],
    ['OverconstrainedError', /can’t provide that video format/]
  ])('%s is reported clearly and nothing is published', async (name, message) => {
    const h = setup({ capture: vi.fn(async () => Promise.reject(namedError(name, 'x'))) })
    await h.controller.start('', 'balanced')
    expect(h.controller.getState().status).toBe('error')
    expect(h.controller.getState().error).toMatch(message)
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('a selected camera that disappeared falls back to the default one and says so', async () => {
    const capture = vi.fn(async (deviceId: string | undefined) => {
      if (deviceId) throw namedError('OverconstrainedError', 'deviceId')
      return asTrack(new FakeTrack('default-cam'))
    })
    const h = setup({ capture })
    await h.controller.start('usb-cam-123', 'balanced')
    expect(capture.mock.calls.map((c) => c[0])).toEqual(['usb-cam-123', undefined])
    expect(h.controller.getState()).toMatchObject({ status: 'on', deviceLabel: 'default-cam' })
    expect(h.controller.getState().notice).toMatch(/default camera/)
  })

  it('permission is never retried on another device', async () => {
    const capture = vi.fn(async () => Promise.reject(namedError('NotAllowedError', 'denied')))
    const h = setup({ capture })
    await h.controller.start('usb-cam-123', 'balanced')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('a failed publication closes the camera', async () => {
    const h = setup({ publish: vi.fn(async () => Promise.reject(new Error('publish refused'))) })
    await h.controller.start('', 'balanced')
    expect(h.captured[0]!.readyState).toBe('ended')
    expect(h.controller.getState()).toMatchObject({ status: 'error' })
  })

  it('a channel without the Video permission is refused before the camera is opened', async () => {
    const h = setup({ allowed: () => false })
    await h.controller.start('', 'balanced')
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.controller.getState().error).toMatch(/aren’t available in this voice channel/)
  })

  it('an unplugged camera stops the publication and explains why', async () => {
    const h = setup()
    await h.controller.start('', 'balanced')
    h.captured[0]!.end()
    await vi.waitFor(() => expect(h.controller.getState().status).toBe('error'))
    expect(h.controller.getState().error).toMatch(/disconnected/)
    expect(h.published.size).toBe(0)
  })
})

describe('reconnects, devices and quality', () => {
  it('a rejoin turns the camera off with a notice and does not turn it back on', async () => {
    const h = setup()
    await h.controller.start('', 'balanced')
    await h.controller.stop('rejoin')
    expect(h.controller.getState()).toMatchObject({ status: 'off' })
    expect(h.controller.getState().notice).toMatch(/voice reconnected/)
    // Later automatic stops keep the first message; nothing restarts on its own.
    await h.controller.stop('disconnected')
    expect(h.controller.getState().notice).toMatch(/voice reconnected/)
    expect(h.capture).toHaveBeenCalledTimes(1)
  })

  it('switching device while on replaces the published track without unpublishing', async () => {
    const h = setup()
    await h.controller.start('', 'balanced')
    const first = h.captured[0]!
    await h.controller.switchDevice('usb-cam-2')
    expect(first.readyState).toBe('ended')
    expect(h.unpublished).toHaveLength(0)
    expect([...h.published][0]!.label).toBe('usb-cam-2')
    expect(h.controller.getState()).toMatchObject({ status: 'on', deviceLabel: 'usb-cam-2' })
  })

  it('a failed switch keeps the current camera running', async () => {
    let calls = 0
    const capture = vi.fn(async () => {
      calls++
      if (calls > 1) throw namedError('NotReadableError', 'busy')
      return asTrack(new FakeTrack('cam-1'))
    })
    const h = setup({ capture })
    await h.controller.start('', 'balanced')
    await h.controller.switchDevice('cam-2')
    expect(h.controller.getState()).toMatchObject({ status: 'on', deviceLabel: 'cam-1' })
    expect(h.controller.getState().notice).toMatch(/Couldn’t switch camera/)
  })

  it('changing quality while off is only remembered; while on it republishes', async () => {
    const h = setup()
    await h.controller.setPreset('high', '')
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.controller.getState()).toEqual({ status: 'off', presetId: 'high' })
    await h.controller.start('', 'high')
    await h.controller.setPreset('data-saver', '')
    expect(h.controller.getState()).toMatchObject({ status: 'on', presetId: 'data-saver' })
    expect(h.captured.filter((t) => t.readyState === 'live')).toHaveLength(1)
    expect(h.publish).toHaveBeenCalledTimes(2)
  })
})
