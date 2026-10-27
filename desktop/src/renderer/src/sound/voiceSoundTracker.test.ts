import { describe, expect, it } from 'vitest'
import type { VoiceStatus } from '../media/voiceLogic'
import type { SoundEvent } from './sounds'
import {
  INITIAL_VOICE_SOUND_STATE,
  ROSTER_GRACE_MS,
  trackVoiceSounds,
  type VoiceSoundState
} from './voiceSoundTracker'

/** Feeds a sequence of [time, status, remote ids] snapshots and collects the sounds. */
function run(steps: [number, VoiceStatus, string[]][]): SoundEvent[][] {
  let state: VoiceSoundState = INITIAL_VOICE_SOUND_STATE
  return steps.map(([t, status, remoteIds]) => {
    const result = trackVoiceSounds(state, { status, remoteIds }, t)
    state = result.state
    return result.events
  })
}

const AFTER = ROSTER_GRACE_MS + 100

describe('voice sounds', () => {
  it('joining a busy channel plays one connect sound and no join burst', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'connected', []],
      // The roster arrives right after connecting.
      [150, 'connected', ['bob', 'carol', 'dave']],
      [300, 'connected', ['bob', 'carol', 'dave']]
    ])
    expect(events.flat()).toEqual(['connect'])
  })

  it('later joins and leaves of other people play once per change', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'connected', ['bob']],
      [AFTER + 100, 'connected', ['bob', 'carol']],
      [AFTER + 200, 'connected', ['bob', 'carol', 'dave', 'erin']],
      [AFTER + 300, 'connected', ['carol', 'dave', 'erin']],
      // Speaking/mute updates re-send the same roster: silent.
      [AFTER + 400, 'connected', ['carol', 'dave', 'erin']]
    ])
    expect(events).toEqual([[], ['connect'], ['voiceJoin'], ['voiceJoin'], ['voiceLeave'], []])
  })

  it('a network reconnect is silent and does not replay join sounds', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'connected', ['bob']],
      [AFTER + 100, 'reconnecting', []],
      [AFTER + 2000, 'connected', []],
      [AFTER + 2050, 'connected', ['bob', 'carol']],
      [AFTER + 5000, 'connected', ['bob', 'carol']]
    ])
    expect(events.flat()).toEqual(['connect'])
  })

  it('a rejoin after the room dropped (reconnecting → reconnecting → connected) is silent too', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'connected', []],
      [5000, 'reconnecting', []],
      [6000, 'reconnecting', []],
      [7000, 'connected', ['bob']]
    ])
    expect(events.flat()).toEqual(['connect'])
  })

  it('switching channels plays connect for the new channel without a disconnect', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'connected', ['bob']],
      [AFTER + 100, 'connecting', []],
      [AFTER + 300, 'connected', ['carol']]
    ])
    expect(events.flat()).toEqual(['connect', 'connect'])
  })

  it('leaving, being kicked, or giving up plays disconnect once', () => {
    expect(
      run([
        [0, 'connecting', []],
        [100, 'connected', []],
        [500, 'idle', []],
        [600, 'idle', []]
      ]).flat()
    ).toEqual(['connect', 'disconnect'])
    expect(
      run([
        [0, 'connecting', []],
        [100, 'connected', []],
        [500, 'disconnected', []]
      ]).flat()
    ).toEqual(['connect', 'disconnect'])
    expect(
      run([
        [0, 'connecting', []],
        [100, 'connected', []],
        [500, 'reconnecting', []],
        [9000, 'error', []]
      ]).flat()
    ).toEqual(['connect', 'disconnect'])
  })

  it('a join that fails before connecting plays nothing', () => {
    expect(
      run([
        [0, 'connecting', []],
        [800, 'error', []]
      ]).flat()
    ).toEqual([])
  })

  it('retrying after an error plays connect again', () => {
    const events = run([
      [0, 'connecting', []],
      [100, 'error', []],
      [5000, 'connecting', []],
      [5100, 'connected', ['bob']]
    ])
    expect(events.flat()).toEqual(['connect'])
  })
})
