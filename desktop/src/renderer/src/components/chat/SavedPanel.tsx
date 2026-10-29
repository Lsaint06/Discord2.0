import { useEffect, useRef, useState } from 'react'
import type { Message, User } from '../../types'
import type { SavedItem } from '../../hooks/useBackend'
import { formatTimestamp } from '../../lib/format'
import Avatar from '../Avatar'
import { CloseIcon } from '../Icons'
import Markdown from './Markdown'

interface SavedPanelProps {
  /** Changes whenever your saved messages change (here or on another device). */
  revision: string
  load: () => Promise<SavedItem[]>
  resolveUser: (id: string) => User
  /** Where a message is, as shown to the user ("#general · Lab", "Direct message"). */
  placeOf: (item: SavedItem) => string
  describeError: (err: unknown) => string
  onJump: (message: Message) => void
  onRemove: (message: Message) => void
  onClose: () => void
}

/** Milestone 14: your saved messages across every server and conversation (only you see them). */
function SavedPanel(props: SavedPanelProps): React.JSX.Element {
  const [items, setItems] = useState<SavedItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { load, describeError, onClose } = props

  useEffect(() => {
    let cancelled = false
    load().then(
      (list) => {
        if (!cancelled) {
          setItems(list)
          setError(null)
        }
      },
      (err: unknown) => {
        if (!cancelled) setError(describeError(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [load, describeError, props.revision])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  return (
    <div ref={ref} className="pins-panel saved-panel" role="dialog" aria-label="Saved messages">
      <header>
        <h3>Saved messages</h3>
        <button
          type="button"
          className="icon-button small"
          onClick={onClose}
          aria-label="Close saved messages"
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <p className="saved-panel-hint">Only you can see what you save.</p>
      <div className="pins-list">
        {error && <div className="search-status error">{error}</div>}
        {!error && items === null && <div className="search-status">Loading…</div>}
        {items?.length === 0 && (
          <div className="search-status">
            Nothing saved yet. Hover a message and press the bookmark to keep it here.
          </div>
        )}
        {items?.map((item) => {
          const m = item.message
          const author = props.resolveUser(m.authorId)
          return (
            <div key={m.id} className="pin-item">
              <div className="search-result-meta">
                <Avatar
                  name={author.name}
                  color={author.avatarColor}
                  imageId={author.avatarId}
                  size={20}
                />
                <span className="search-result-author">{author.name}</span>
                <span className="saved-place">{props.placeOf(item)}</span>
                <time>{formatTimestamp(m.timestamp)}</time>
              </div>
              <div className="search-result-content">
                {m.content ? (
                  <Markdown content={m.content} />
                ) : (
                  <em>{m.attachments?.length ?? 0} attachment(s)</em>
                )}
              </div>
              <div className="pin-actions">
                <button type="button" className="link-button" onClick={() => props.onJump(m)}>
                  Jump
                </button>
                <button type="button" className="link-button" onClick={() => props.onRemove(m)}>
                  Remove
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SavedPanel
