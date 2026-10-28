import { memo, useState } from 'react'
import type { ApiAttachment } from '../../net/protocol'
import type { AttachmentCache } from '../../chat/attachmentCache'
import { formatBytes } from '../../chat/uploads'
import { fitBox } from '../../chat/layout'
import { downloadAttachment, useAttachmentUrl } from '../../hooks/useAttachmentUrl'
import { attachmentExpired, expiryLabel } from '../../chat/largeUpload'
import { DISK_DOWNLOAD_MIN_BYTES, useDiskDownload } from '../../chat/diskDownloads'

interface AttachmentListProps {
  attachments: ApiAttachment[]
  cache: AttachmentCache
  onOpenImage: (attachment: ApiAttachment) => void
}

const MAX_W = 400
const MAX_H = 300

function ImageTile({
  attachment,
  cache,
  onOpen,
  multi
}: {
  attachment: ApiAttachment
  cache: AttachmentCache
  onOpen: () => void
  multi: boolean
}): React.JSX.Element {
  const { url, error } = useAttachmentUrl(cache, attachment.id)
  const box = fitBox(attachment.width, attachment.height, multi ? 260 : MAX_W, multi ? 200 : MAX_H)
  return (
    <button
      type="button"
      className={`attachment-image${error ? ' failed' : ''}`}
      style={{ width: box.width, height: box.height }}
      onClick={onOpen}
      disabled={!url}
      aria-label={`Open image ${attachment.filename}`}
      title={attachment.filename}
    >
      {url ? (
        <img src={url} alt={attachment.filename} draggable={false} />
      ) : error ? (
        <span className="attachment-image-status">Couldn&rsquo;t load image</span>
      ) : (
        <span className="attachment-image-status loading" aria-label="Loading image" />
      )}
    </button>
  )
}

function FileCard({
  attachment,
  cache
}: {
  attachment: ApiAttachment
  cache: AttachmentCache
}): React.JSX.Element {
  const ext = attachment.filename.split('.').pop()?.toUpperCase() ?? 'FILE'
  const disk = useDiskDownload(attachment.id)
  const [error, setError] = useState<string | null>(null)
  const expired = attachmentExpired(attachment)
  const expires = expiryLabel(attachment.expiresAt)
  const progress = disk.progress
  const download = (): void => {
    setError(null)
    const inMemory = (): void => {
      downloadAttachment(cache, attachment.id, attachment.filename).catch(() =>
        setError('Couldn’t download this file.')
      )
    }
    // Big files go straight to disk (Save dialog); small ones through the in-memory cache.
    if (disk.supported && attachment.size > DISK_DOWNLOAD_MIN_BYTES) {
      void disk.start().then((ok) => {
        if (!ok) inMemory()
      })
      return
    }
    inMemory()
  }
  if (expired) {
    return (
      <div className="attachment-file expired" aria-label={`${attachment.filename}, expired`}>
        <span className="attachment-file-icon" aria-hidden="true">
          {ext.slice(0, 4)}
        </span>
        <span className="attachment-file-info">
          <span className="attachment-file-name" title={attachment.filename}>
            {attachment.filename}
          </span>
          <span className="attachment-file-size">
            File expired · large files are kept for a limited time
          </span>
        </span>
      </div>
    )
  }
  return (
    <div className="attachment-file">
      <span className="attachment-file-icon" aria-hidden="true">
        {ext.slice(0, 4)}
      </span>
      <span className="attachment-file-info">
        <span className="attachment-file-name" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="attachment-file-size">
          {formatBytes(attachment.size)}
          {expires && <span className="attachment-expiry"> · {expires}</span>}
          {progress?.state === 'progressing' && progress.total > 0 && (
            <span role="status">
              {' '}
              · Downloading {Math.floor((progress.received / progress.total) * 100)}%
            </span>
          )}
          {progress?.state === 'completed' && <span role="status"> · Saved</span>}
          {progress?.state === 'interrupted' && <span role="status"> · Download interrupted</span>}
          {error && <span role="alert"> · {error}</span>}
        </span>
      </span>
      <button
        type="button"
        className="link-button"
        onClick={download}
        aria-label={`Download ${attachment.filename}`}
      >
        Download
      </button>
    </div>
  )
}

function AttachmentList({
  attachments,
  cache,
  onOpenImage
}: AttachmentListProps): React.JSX.Element {
  const images = attachments.filter((a) => a.kind === 'image')
  const files = attachments.filter((a) => a.kind !== 'image')
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={`attachment-images count-${Math.min(images.length, 4)}`}>
          {images.map((a) => (
            <ImageTile
              key={a.id}
              attachment={a}
              cache={cache}
              multi={images.length > 1}
              onOpen={() => onOpenImage(a)}
            />
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileCard key={a.id} attachment={a} cache={cache} />
      ))}
    </div>
  )
}

export default memo(AttachmentList)
