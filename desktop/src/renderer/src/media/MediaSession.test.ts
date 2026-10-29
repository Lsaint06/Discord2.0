import { describe, expect, it, vi } from 'vitest'
import { MediaSession, type MediaPreferences, type MediaSnapshot } from './MediaSession'

const PREFS: MediaPreferences = {
  inputDeviceId: '',
  outputDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputVolume: 100,
  outputVolume: 100,
  userVolumes: {},
  streamVolumes: {},
  inputSensitivityDb: null,
  cameraDeviceId: '',
  cameraPresetId: 'balanced',
  receiveCameras: true
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function participant(identity: string, isLocal: boolean): object {
  return {
    identity,
    isLocal,
    isMicrophoneEnabled: true,
    attributes: {},
    getTrackPublication: () => undefined
  }
}

interface FakeRoom {
  room: {
    removeAllListeners: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    activeSpeakers: never[]
    localParticipant: object
    remoteParticipants: Map<string, object>
  }
  micTrack: { stop: ReturnType<typeof vi.fn> }
}

/** Just enough of a LiveKit Room for teardown: closing the connection takes as long as we say. */
function fakeRoom(closing: Promise<void>): FakeRoom {
  const micTrack = { stop: vi.fn() }
  return {
    room: {
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(() => closing),
      activeSpeakers: [],
      localParticipant: {
        ...participant('me', true),
        trackPublications: new Map([['mic', { track: micTrack }]])
      },
      remoteParticipants: new Map([['ana', participant('ana', false)]])
    },
    micTrack
  }
}

/** A session that is connected to `lounge` through the given room (white-box setup). */
function connectedSession(room: object): MediaSession {
  const session = new MediaSession({ describeError: String, isFatalError: () => false }, PREFS)
  const inner = session as unknown as {
    room: object
    desiredChannel: string
    set: (patch: Partial<MediaSnapshot>) => void
    refreshParticipants: () => void
  }
  inner.room = room
  inner.desiredChannel = 'lounge'
  inner.set({ status: 'connected', channelId: 'lounge' })
  inner.refreshParticipants()
  return session
}

const refresh = (session: MediaSession): void =>
  (session as unknown as { refreshParticipants: () => void }).refreshParticipants()

/** Minimal camera MediaStreamTrack stand-in (Node's EventTarget). */
class FakeCamera extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  readonly kind = 'video'
  label = 'Fake HD Camera'
  contentHint = ''
  stop(): void {
    this.readyState = 'ended'
  }
  getSettings(): Record<string, unknown> {
    return { width: 1280, height: 720, frameRate: 30, deviceId: 'cam-1' }
  }
}

/** A connected room whose grant lists the given LiveKit proto sources (1 = camera, 2 = mic). */
function cameraRoom(
  sources: number[],
  closing: Promise<void> = Promise.resolve()
): {
  room: Record<string, unknown>
  publishTrack: ReturnType<typeof vi.fn>
  unpublishTrack: ReturnType<typeof vi.fn>
} {
  const publishTrack = vi.fn(async (track: unknown, options: { source: string }) => ({
    track: { mediaStreamTrack: track, source: options.source },
    source: options.source
  }))
  const unpublishTrack = vi.fn(async () => undefined)
  const room = {
    state: 'connected',
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(() => closing),
    activeSpeakers: [],
    localParticipant: {
      ...participant('me', true),
      permissions: { canPublish: true, canPublishSources: sources },
      trackPublications: new Map(),
      publishTrack,
      unpublishTrack
    },
    remoteParticipants: new Map([['ana', participant('ana', false)]])
  }
  return { room, publishTrack, unpublishTrack }
}

function withCamera(): { camera: FakeCamera; getUserMedia: ReturnType<typeof vi.fn> } {
  const camera = new FakeCamera()
  const getUserMedia = vi.fn(async () => ({
    getVideoTracks: () => [camera],
    getAudioTracks: () => []
  }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { camera, getUserMedia }
}

describe('camera in a call (Milestone 14.5)', () => {
  it('is off when you join and only turns on when you ask, as a Camera source', async () => {
    const { camera, getUserMedia } = withCamera()
    try {
      const { room, publishTrack } = cameraRoom([2, 1, 3, 4])
      const session = connectedSession(room)
      expect(session.getSnapshot().camera.status).toBe('off')
      expect(getUserMedia).not.toHaveBeenCalled()

      await session.startCamera()
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      expect(getUserMedia.mock.calls[0]![0]).toMatchObject({
        audio: false,
        video: { width: { ideal: 1280 } }
      })
      expect(publishTrack).toHaveBeenCalledWith(
        camera,
        expect.objectContaining({ source: 'camera', simulcast: true })
      )
      expect(session.getSnapshot().camera).toMatchObject({
        status: 'on',
        deviceLabel: 'Fake HD Camera'
      })
      expect(session.isCapturingCamera()).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaving releases the camera at once, before the connection has finished closing', async () => {
    const { camera } = withCamera()
    try {
      const closing = deferred()
      const { room } = cameraRoom([2, 1], closing.promise)
      const session = connectedSession(room)
      await session.startCamera()

      const left = session.leave()
      // Synchronously: you're out, your camera state is off and the device light is off.
      expect(session.getSnapshot()).toMatchObject({ status: 'idle', camera: { status: 'off' } })
      expect(camera.readyState).toBe('ended')
      expect(session.isCapturingCamera()).toBe(false)
      closing.resolve()
      await left
      expect(session.getSnapshot().camera.status).toBe('off')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('switching channels turns the camera off and never back on by itself', async () => {
    const { camera, getUserMedia } = withCamera()
    try {
      const { room } = cameraRoom([2, 1])
      const session = connectedSession(room)
      await session.startCamera()
      session.setTokenSource(() => new Promise(() => undefined))
      void session.join('games')
      await vi.waitFor(() => expect(session.getSnapshot().channelId).toBe('games'))
      expect(camera.readyState).toBe('ended')
      expect(session.getSnapshot().camera.status).toBe('off')
      expect(session.getSnapshot().camera.notice).toMatch(/switched voice channels/)
      expect(getUserMedia).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('on a server whose grant has no camera (production API 4) the camera is never opened', async () => {
    const { getUserMedia } = withCamera()
    try {
      const { room, publishTrack } = cameraRoom([2, 3, 4])
      const session = connectedSession(room)
      await session.startCamera()
      expect(getUserMedia).not.toHaveBeenCalled()
      expect(publishTrack).not.toHaveBeenCalled()
      expect(session.getSnapshot().camera.status).toBe('error')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is not started at all while not connected', async () => {
    const { getUserMedia } = withCamera()
    try {
      const session = new MediaSession({ describeError: String, isFatalError: () => false }, PREFS)
      await session.startCamera()
      expect(getUserMedia).not.toHaveBeenCalled()
      expect(session.getSnapshot().camera.status).toBe('off')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows who has a camera on (a paused camera counts as off)', () => {
    const cameraPub = { isMuted: false, track: { kind: 'video' } }
    const ana = {
      ...participant('ana', false),
      getTrackPublication: (source: string) => (source === 'camera' ? cameraPub : undefined)
    }
    const { room } = cameraRoom([2, 1])
    room.remoteParticipants = new Map([['ana', ana]])
    const session = connectedSession(room)
    expect(session.getSnapshot().participants.find((p) => p.identity === 'ana')?.cameraOn).toBe(
      true
    )
    expect(session.getCameraTrack('ana')).toBe(cameraPub.track)
    cameraPub.isMuted = true
    refresh(session)
    expect(session.getSnapshot().participants.find((p) => p.identity === 'ana')?.cameraOn).toBe(
      false
    )
    expect(session.getCameraTrack('ana')).toBeUndefined()
  })
})

describe('leaving voice', () => {
  it('shows you as gone at once, while the connection is still closing', async () => {
    const closing = deferred()
    const { room, micTrack } = fakeRoom(closing.promise)
    const session = connectedSession(room)
    expect(session.getSnapshot().participants.map((p) => p.identity)).toEqual(['me', 'ana'])

    const left = session.leave()
    // Nothing awaited yet: the UI already sees the session as left.
    expect(session.getSnapshot()).toMatchObject({
      status: 'idle',
      channelId: null,
      participants: []
    })

    // Events from the closing room can't bring the old roster back.
    await Promise.resolve()
    refresh(session)
    expect(session.getSnapshot().participants).toEqual([])

    // The connection is closed (tracks stopped) in the background.
    await vi.waitFor(() => expect(room.disconnect).toHaveBeenCalledWith(true))
    expect(micTrack.stop).not.toHaveBeenCalled()
    closing.resolve()
    await left
    expect(room.removeAllListeners).toHaveBeenCalled()
    expect(micTrack.stop).toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ status: 'idle', participants: [] })
  })

  it('joining another channel during the teardown is not undone when it finishes', async () => {
    const closing = deferred()
    const { room } = fakeRoom(closing.promise)
    const session = connectedSession(room)
    // The next connection stays at "connecting" (the token never arrives in this test).
    session.setTokenSource(() => new Promise(() => undefined))

    const left = session.leave()
    void session.join('games')
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({ status: 'connecting', channelId: 'games' })
    )
    closing.resolve()
    await left
    expect(session.getSnapshot()).toMatchObject({ status: 'connecting', channelId: 'games' })
  })
})
