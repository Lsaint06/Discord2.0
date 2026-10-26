import type { MediaSession } from '../media/MediaSession'
import { SCREEN_PROFILES, type ScreenProfileId } from '../media/screenProfiles'
import { shareHealth } from '../media/statsFormat'
import { useTrackStats } from '../hooks/useTrackStats'

interface ShareHealthNoteProps {
  session: MediaSession
  profileId: ScreenProfileId
}

/** Tells the sharer, in the voice panel, when CPU or bandwidth holds the stream back. */
function ShareHealthNote({ session, profileId }: ShareHealthNoteProps): React.JSX.Element | null {
  const stats = useTrackStats(session.getStatsTargets().localScreen, 'outbound', 2000)
  const { warning } = shareHealth(stats?.rtc, SCREEN_PROFILES[profileId])
  if (!warning) return null
  return (
    <div className="voice-panel-message warn" role="status">
      {warning}
    </div>
  )
}

export default ShareHealthNote
