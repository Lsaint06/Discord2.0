import { useContext, useState, type ReactNode } from 'react'
import type { GifRef } from '../../chat/gifs'
import { useGifMedia } from '../../lib/profileMedia'
import { GifContext, ReducedMotionContext } from '../../chat/gifContext'

/**
 * A GIF message: the GIF itself (through the server's proxy) when this server's GIF provider
 * knows it, otherwise `fallback` (the link). Under reduced motion it shows the first frame with
 * a play button.
 */
function GifEmbed({ gif, fallback }: { gif: GifRef; fallback: ReactNode }): React.JSX.Element {
  const support = useContext(GifContext)
  const reduced = useContext(ReducedMotionContext)
  const [playing, setPlaying] = useState(false)
  const usable = support?.provider === gif.provider
  const { url, failed } = useGifMedia(
    usable ? gif.id : null,
    reduced && !playing ? 'still' : 'full'
  )
  if (!usable || failed) return <>{fallback}</>
  return (
    <div className="gif-embed">
      {url ? (
        <img src={url} alt="GIF" draggable={false} />
      ) : (
        <div className="gif-embed-loading" aria-label="Loading GIF" />
      )}
      {reduced && (
        <button
          type="button"
          className="gif-play"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
          aria-label={playing ? 'Show the still frame' : 'Play GIF'}
        >
          {playing ? 'Ⅱ' : 'GIF ▶'}
        </button>
      )}
    </div>
  )
}

export default GifEmbed
