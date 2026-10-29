import { DisconnectReason } from 'livekit-client'
import { describe, expect, it } from 'vitest'
import {
  backoffDelay,
  codeToAccelerator,
  describeKey,
  isNonTypingKey,
  isValidPushToTalkKey,
  micShouldTransmit,
  playbackVolume,
  shouldAutoRejoin,
  withoutUser
} from './voiceLogic'

describe('reconnect policy', () => {
  it('rejoins after network-type failures', () => {
    for (const reason of [
      undefined,
      DisconnectReason.UNKNOWN_REASON,
      DisconnectReason.SERVER_SHUTDOWN,
      DisconnectReason.SIGNAL_CLOSE,
      DisconnectReason.CONNECTION_TIMEOUT,
      DisconnectReason.MEDIA_FAILURE,
      DisconnectReason.JOIN_FAILURE
    ]) {
      expect(shouldAutoRejoin(reason)).toBe(true)
    }
  })

  it('does not fight deliberate disconnects', () => {
    for (const reason of [
      DisconnectReason.CLIENT_INITIATED,
      DisconnectReason.DUPLICATE_IDENTITY,
      DisconnectReason.PARTICIPANT_REMOVED,
      DisconnectReason.ROOM_DELETED
    ]) {
      expect(shouldAutoRejoin(reason)).toBe(false)
    }
  })

  it('backs off exponentially with a cap', () => {
    const mid = (): number => 0.5 // no jitter
    expect(backoffDelay(0, mid)).toBe(1000)
    expect(backoffDelay(1, mid)).toBe(2000)
    expect(backoffDelay(4, mid)).toBe(16000)
    expect(backoffDelay(10, mid)).toBe(30000)
    expect(backoffDelay(0, () => 0)).toBe(700)
    expect(backoffDelay(0, () => 1)).toBe(1300)
  })
})

describe('microphone gating', () => {
  const base = { muted: false, deafened: false, pushToTalk: false, pushToTalkActive: false }

  it('transmits in voice-activity mode unless muted or deafened', () => {
    expect(micShouldTransmit(base)).toBe(true)
    expect(micShouldTransmit({ ...base, muted: true })).toBe(false)
    expect(micShouldTransmit({ ...base, deafened: true })).toBe(false)
  })

  it('only transmits while push-to-talk is held', () => {
    expect(micShouldTransmit({ ...base, pushToTalk: true })).toBe(false)
    expect(micShouldTransmit({ ...base, pushToTalk: true, pushToTalkActive: true })).toBe(true)
    expect(
      micShouldTransmit({ ...base, pushToTalk: true, pushToTalkActive: true, muted: true })
    ).toBe(false)
  })
})

describe('volume', () => {
  it('combines master and per-user volume and clamps to 0–200%', () => {
    expect(playbackVolume(100)).toBe(1)
    expect(playbackVolume(100, 50)).toBe(0.5)
    expect(playbackVolume(200, 200)).toBe(4)
    expect(playbackVolume(500, -10)).toBe(0)
  })
})

describe('push-to-talk keys', () => {
  it('maps keyboard codes to Electron accelerators', () => {
    expect(codeToAccelerator('KeyV')).toBe('V')
    expect(codeToAccelerator('Digit4')).toBe('4')
    expect(codeToAccelerator('F8')).toBe('F8')
    expect(codeToAccelerator('Backquote')).toBe('`')
    expect(codeToAccelerator('Numpad0')).toBe('num0')
    expect(codeToAccelerator('ShiftLeft')).toBeNull()
  })

  it('describes keys for the UI', () => {
    expect(describeKey('Backquote')).toBe('`')
    expect(describeKey('Numpad5')).toBe('Numpad 5')
    expect(describeKey('ControlLeft')).toBe('Control Left')
  })

  it('treats function and modifier keys as non-typing', () => {
    expect(isNonTypingKey('F8')).toBe(true)
    expect(isNonTypingKey('ControlRight')).toBe(true)
    expect(isNonTypingKey('KeyV')).toBe(false)
    expect(isNonTypingKey('Backquote')).toBe(false)
  })

  it('rejects keys reserved for UI navigation', () => {
    expect(isValidPushToTalkKey('Escape')).toBe(false)
    expect(isValidPushToTalkKey('Enter')).toBe(false)
    expect(isValidPushToTalkKey('F8')).toBe(true)
  })
})

describe('leaving voice: taking yourself out of the voice state', () => {
  it('removes only your entry, and only for the channel you left', () => {
    const states = { me: 'lounge', ana: 'lounge', ben: 'games' }
    expect(withoutUser(states, 'me', (c) => c === 'lounge')).toEqual({
      ana: 'lounge',
      ben: 'games'
    })
    expect(states).toEqual({ me: 'lounge', ana: 'lounge', ben: 'games' })
  })

  it('changes nothing (same object) when you are elsewhere or already gone', () => {
    const states = { me: 'games', ana: 'lounge' }
    expect(withoutUser(states, 'me', (c) => c === 'lounge')).toBe(states)
    expect(withoutUser(states, 'nobody', () => true)).toBe(states)
    // Inherited names are never treated as entries.
    expect(withoutUser(states, 'toString', () => true)).toBe(states)
  })

  it('also clears your "live" mark', () => {
    expect(withoutUser({ me: true as const, ana: true as const }, 'me', Boolean)).toEqual({
      ana: true
    })
  })
})
