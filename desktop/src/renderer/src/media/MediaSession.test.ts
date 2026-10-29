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
  inputSensitivityDb: null
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
