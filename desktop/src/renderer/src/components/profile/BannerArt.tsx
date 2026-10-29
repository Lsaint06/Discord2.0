/**
 * Milestone 14: the 8 original animated banners (pure CSS layers, see profile-style.css). Used
 * when a profile has a banner preset and no banner picture. They move only while `animate`.
 */
import type { BannerPresetId } from '../../net/protocol'

function BannerArt({ id, animate }: { id: BannerPresetId; animate: boolean }): React.JSX.Element {
  return (
    <div className={`banner-art banner-${id}${animate ? ' animate' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}

export default BannerArt
