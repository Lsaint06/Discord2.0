import { memo } from 'react'
import type { ApiAttachment } from '../../net/protocol'
import type { AttachmentCache } from '../../chat/attachmentCache'
import { formatBytes } from '../../chat/uploads'
import { fitBox } from '../../chat/layout'
import { downloadAttachment, useAttachmentUrl } from '../../hooks/useAttachmentUrl'

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
  return (
    <div className="attachment-file">
      <span className="attachment-file-icon" aria-hidden="true">
        {ext.slice(0, 4)}
      </span>
      <span className="attachment-file-info">
        <span className="attachment-file-name" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="attachment-file-size">{formatBytes(attachment.size)}</span>
      </span>
      <button
        type="button"
        className="link-button"
        onClick={() => void downloadAttachment(cache, attachment.id, attachment.filename)}
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
