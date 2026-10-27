import { useEffect, useRef } from 'react'
import type { MediaSnapshot } from '../media/MediaSession'
import type { SoundService } from './SoundService'
import { INITIAL_VOICE_SOUND_STATE, trackVoiceSounds } from './voiceSoundTracker'

/** Plays connect/disconnect and other people's join/leave sounds from voice snapshots. */
export function useVoiceSounds(service: SoundService, snapshot: MediaSnapshot): void {
  const state = useRef(INITIAL_VOICE_SOUND_STATE)
  const { status, participants } = snapshot
  useEffect(() => {
    const { state: next, events } = trackVoiceSounds(
      state.current,
      { status, remoteIds: participants.filter((p) => !p.isLocal).map((p) => p.identity) },
      performance.now()
    )
    state.current = next
    for (const event of events) service.play(event)
  }, [service, status, participants])
}
