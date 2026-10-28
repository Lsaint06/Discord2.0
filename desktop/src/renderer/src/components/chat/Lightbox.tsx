import { useEffect, useRef, useState } from 'react'
import type { ApiAttachment } from '../../net/protocol'
import type { AttachmentCache } from '../../chat/attachmentCache'
import { formatBytes } from '../../chat/uploads'
import { downloadAttachment, useAttachmentUrl } from '../../hooks/useAttachmentUrl'
import { useDialog } from '../../hooks/useDialog'
import { CloseIcon } from '../Icons'

interface LightboxProps {
  attachment: ApiAttachment
  /** Every image in the conversation, oldest first (for previous / next). */
  gallery?: ApiAttachment[]
  cache: AttachmentCache
  onNavigate?: (attachment: ApiAttachment) => void
  onClose: () => void
}

/** Copies a decoded image as PNG (the image format Chromium's clipboard accepts). */
async function copyImage(img: HTMLImageElement): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no canvas')
  context.drawImage(img, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('encode failed')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/**
 * Full-window image viewer: fit or 100% (actual pixels), zoom, previous/next image in the
 * conversation, copy, download. Keys: ← → browse, + − 0 zoom, Esc closes.
 */
function Lightbox({
  attachment,
  gallery = [],
  cache,
  onNavigate,
  onClose
}: LightboxProps): React.JSX.Element {
  const { url, error } = useAttachmentUrl(cache, attachment.id)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [status, setStatus] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const position = gallery.findIndex((a) => a.id === attachment.id)
  const previous = position > 0 ? gallery[position - 1] : undefined
  const next = position >= 0 && position < gallery.length - 1 ? gallery[position + 1] : undefined
  const go = (target: ApiAttachment | undefined): void => {
    if (!target || !onNavigate) return
    setZoom('fit')
    setStatus(null)
    onNavigate(target)
  }
  const goRef = useRef(go)
  useEffect(() => {
    goRef.current = go
  })
  const neighbours = useRef({ previous, next })
  useEffect(() => {
    neighbours.current = { previous, next }
  }, [previous, next])

  useEffect(() => {
    // Escape, the focus trap and returning focus are handled by useDialog (below).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goRef.current(neighbours.current.previous)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goRef.current(neighbours.current.next)
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(4, (z === 'fit' ? 1 : z) * 1.25))
      } else if (e.key === '-') {
        setZoom((z) => Math.max(0.25, (z === 'fit' ? 1 : z) / 1.25))
      } else if (e.key === '0') {
        setZoom('fit')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const dialogRef = useDialog<HTMLDivElement>({ onClose })

  // Preload the neighbours so browsing feels instant (the cache bounds total memory).
  useEffect(() => {
    for (const a of [previous, next]) if (a) void cache.get(a.id).catch(() => undefined)
  }, [cache, previous, next])

  const copy = (): void => {
    const img = imgRef.current
    if (!img || !img.complete || img.naturalWidth === 0) {
      setStatus('Wait for the image to load, then try again')
      return
    }
    copyImage(img)
      .then(() => setStatus('Image copied'))
      .catch(() => setStatus('Couldn’t copy this image'))
  }

  const scale = zoom === 'fit' ? undefined : zoom
  return (
    <div
      ref={dialogRef}
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
            {gallery.length > 1 && position >= 0 ? `${position + 1} of ${gallery.length} · ` : ''}
            {attachment.width && attachment.height
              ? `${attachment.width}×${attachment.height} · `
              : ''}
            {formatBytes(attachment.size)}
          </small>
        </span>
        <span className="lightbox-status" role="status" aria-live="polite">
          {status}
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
        <button type="button" className="button secondary small" disabled={!url} onClick={copy}>
          Copy
        </button>
        <button
          type="button"
          className="button primary small"
          onClick={() => void downloadAttachment(cache, attachment.id, attachment.filename)}
        >
          Download
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close image"
          data-autofocus
        >
          <CloseIcon size={20} />
        </button>
      </div>
      <div className={`lightbox-stage${zoom === 'fit' ? ' fit' : ''}`}>
        {url ? (
          <img
            ref={imgRef}
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
      {onNavigate && previous && (
        <button
          type="button"
          className="lightbox-nav previous"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => go(previous)}
          aria-label="Previous image"
          title="Previous image (←)"
        >
          ‹
        </button>
      )}
      {onNavigate && next && (
        <button
          type="button"
          className="lightbox-nav next"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => go(next)}
          aria-label="Next image"
          title="Next image (→)"
        >
          ›
        </button>
      )}
    </div>
  )
}

export default Lightbox
