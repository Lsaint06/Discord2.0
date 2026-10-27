/**
 * Turns voice snapshots into sound events (pure, unit-tested):
 * - "connect" when a join or channel switch completes; nothing after an automatic reconnect;
 * - "disconnect" when a session that was connected ends (left, kicked, gave up reconnecting);
 * - "voiceJoin" / "voiceLeave" for *other* people, only after the initial participant list has
 *   settled, so entering a channel or reconnecting never plays a burst of join sounds.
 */
import type { VoiceStatus } from '../media/voiceLogic'
import type { SoundEvent } from './sounds'

/** Participants that appear this soon after (re)connecting are the existing roster, not joins. */
export const ROSTER_GRACE_MS = 1500

export interface VoiceSoundState {
  status: VoiceStatus
  /** A connection in this voice session has completed (until it fully ends). */
  sessionConnected: boolean
  remotes: ReadonlySet<string>
  absorbUntil: number
}

export const INITIAL_VOICE_SOUND_STATE: VoiceSoundState = {
  status: 'idle',
  sessionConnected: false,
  remotes: new Set(),
  absorbUntil: 0
}

export interface VoiceSnapshotLike {
  status: VoiceStatus
  /** Identities of the *other* participants. */
  remoteIds: readonly string[]
}

export function trackVoiceSounds(
  prev: VoiceSoundState,
  snap: VoiceSnapshotLike,
  now: number
): { state: VoiceSoundState; events: SoundEvent[] } {
  const events: SoundEvent[] = []
  const ids = new Set(snap.remoteIds)

  switch (snap.status) {
    case 'connected': {
      if (prev.status !== 'connected') {
        // Fresh join or channel switch: chime. Automatic reconnect of a live session: silent.
        const reconnected = prev.status === 'reconnecting' && prev.sessionConnected
        if (!reconnected) events.push('connect')
        return {
          state: {
            status: 'connected',
            sessionConnected: true,
            remotes: ids,
            absorbUntil: now + ROSTER_GRACE_MS
          },
          events
        }
      }
      if (now >= prev.absorbUntil) {
        const joined = [...ids].some((id) => !prev.remotes.has(id))
        const left = [...prev.remotes].some((id) => !ids.has(id))
        // One sound per change, however many people moved at once.
        if (joined) events.push('voiceJoin')
        if (left) events.push('voiceLeave')
      }
      return { state: { ...prev, remotes: ids }, events }
    }
    case 'reconnecting':
      // Keep the roster; the snapshot is empty while reconnecting.
      return { state: { ...prev, status: 'reconnecting' }, events }
    case 'connecting':
      return { state: { ...prev, status: 'connecting', remotes: new Set() }, events }
    case 'idle':
    case 'disconnected':
    case 'error':
      if (prev.sessionConnected) events.push('disconnect')
      return {
        state: { status: snap.status, sessionConnected: false, remotes: new Set(), absorbUntil: 0 },
        events
      }
  }
}
