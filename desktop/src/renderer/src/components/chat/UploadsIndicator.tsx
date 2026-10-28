import type { ActiveUpload } from '../../chat/uploadManager'
import { CloseIcon } from '../Icons'

interface UploadsIndicatorProps {
  /** Uploads running or failed in channels other than the one on screen. */
  uploads: ActiveUpload[]
  /** "#general", "@Ana", or null if the channel can't be opened any more. */
  labelFor: (channelId: string) => string | null
  onOpen: (channelId: string) => void
  onCancel: (upload: ActiveUpload) => void
}

/** Uploads keep going while you read other channels; this shows where they stand. */
function UploadsIndicator({
  uploads,
  labelFor,
  onOpen,
  onCancel
}: UploadsIndicatorProps): React.JSX.Element | null {
  if (uploads.length === 0) return null
  return (
    <section className="uploads-indicator" aria-label="Uploads in other channels">
      <ul>
        {uploads.map((u) => {
          const label = labelFor(u.channelId)
          const state = u.status === 'error' ? 'failed' : `${Math.round(u.progress * 100)}%`
          return (
            <li key={u.key} className={u.status === 'error' ? 'failed' : undefined}>
              <button
                type="button"
                className="uploads-indicator-open"
                disabled={!label}
                onClick={() => onOpen(u.channelId)}
                title={label ? `Go to ${label}` : undefined}
              >
                <span className="uploads-indicator-name">{u.name}</span>
                <span className="uploads-indicator-meta">
                  {label ? `${label} · ` : ''}
                  {state}
                </span>
                {u.status === 'uploading' && (
                  <progress max={1} value={u.progress} aria-label={`Uploading ${u.name}`} />
                )}
              </button>
              <button
                type="button"
                className="icon-button small"
                onClick={() => onCancel(u)}
                aria-label={
                  u.status === 'uploading' ? `Cancel upload of ${u.name}` : `Remove ${u.name}`
                }
                title={u.status === 'uploading' ? 'Cancel upload' : 'Remove'}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default UploadsIndicator
