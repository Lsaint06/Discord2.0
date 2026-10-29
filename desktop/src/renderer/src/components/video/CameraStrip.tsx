import type { MediaSession, MediaSnapshot, VoiceParticipant } from '../../media/MediaSession'
import { galleryOrder } from '../../lib/gallery'
import VideoTile, { type TilePerson } from './VideoTile'

interface CameraStripProps {
  session: MediaSession
  state: MediaSnapshot
  person: (p: VoiceParticipant) => TilePerson
  mirror: boolean
  hideSelf: boolean
  onOpenCalls: () => void
}

/** Camera thumbnails kept visible while you watch someone's screen share. */
function CameraStrip({
  session,
  state,
  person,
  mirror,
  hideSelf,
  onOpenCalls
}: CameraStripProps): React.JSX.Element | null {
  const order = galleryOrder(state.participants, { hideSelf })
  void state.streamRevision
  if (order.length === 0) return null
  return (
    <div className="camera-strip" role="list" aria-label="Cameras">
      {order.map((p) => (
        <div role="listitem" key={p.identity}>
          <VideoTile
            person={person(p)}
            track={session.getCameraTrack(p.identity)}
            mirror={p.isLocal && mirror}
            compact
            width={160}
            height={90}
            onFocus={onOpenCalls}
          />
        </div>
      ))}
    </div>
  )
}

export default CameraStrip
