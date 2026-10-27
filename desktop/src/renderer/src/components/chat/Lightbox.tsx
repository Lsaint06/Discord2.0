import { useEffect, useRef, useState } from 'react'
import type { ApiAttachment } from '../../net/protocol'
import type { AttachmentCache } from '../../chat/attachmentCache'
import { formatBytes } from '../../chat/uploads'
import { downloadAttachment, useAttachmentUrl } from '../../hooks/useAttachmentUrl'
import { CloseIcon } from '../Icons'

interface LightboxProps {
  attachment: ApiAttachment
  cache: AttachmentCache
  onClose: () => void
}

/** Full-window image viewer: fit or 100% (actual pixels), zoom, download, Esc to close. */
function Lightbox({ attachment, cache, onClose }: LightboxProps): React.JSX.Element {
  const { url, error } = useAttachmentUrl(cache, attachment.id)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(4, (z === 'fit' ? 1 : z) * 1.25))
      } else if (e.key === '-') {
        setZoom((z) => Math.max(0.25, (z === 'fit' ? 1 : z) / 1.25))
      } else if (e.key === '0') {
        setZoom('fit')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [onClose])

  const scale = zoom === 'fit' ? undefined : zoom
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      onMouseDown={onClose}
    >
      <div className="lightbox-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <span className="lightbox-title" title={attachment.filename}>
          {attachment.filename}
          <small>
            {attachment.width && attachment.height
              ? `${attachment.width}×${attachment.height} · `
              : ''}
            {formatBytes(attachment.size)}
          </small>
        </span>
        <button
          type="button"
          className="button secondary small"
          onClick={() => setZoom('fit')}
          aria-pressed={zoom === 'fit'}
        >
          Fit
        </button>
        <button
          type="button"
          className="button secondary small"
          onClick={() => setZoom(1)}
          aria-pressed={zoom === 1}
        >
          100%
        </button>
        <button
          type="button"
          className="button secondary small"
          onClick={() => setZoom((z) => Math.max(0.25, (z === 'fit' ? 1 : z) / 1.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="button secondary small"
          onClick={() => setZoom((z) => Math.min(4, (z === 'fit' ? 1 : z) * 1.25))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="button primary small"
          onClick={() => void downloadAttachment(cache, attachment.id, attachment.filename)}
        >
          Download
        </button>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close image"
        >
          <CloseIcon size={20} />
        </button>
      </div>
      <div className={`lightbox-stage${zoom === 'fit' ? ' fit' : ''}`}>
        {url ? (
          <img
            src={url}
            alt={attachment.filename}
            onMouseDown={(e) => e.stopPropagation()}
            style={
              scale && attachment.width && attachment.height
                ? { width: attachment.width * scale, height: attachment.height * scale }
                : undefined
            }
          />
        ) : (
          <span className="lightbox-status">
            {error ? 'Couldn’t load this image.' : 'Loading…'}
          </span>
        )}
      </div>
    </div>
  )
}

export default Lightbox
