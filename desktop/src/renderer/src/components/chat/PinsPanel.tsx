import { useEffect, useRef, useState } from 'react'
import type { Message, User } from '../../types'
import { formatTimestamp } from '../../lib/format'
import Avatar from '../Avatar'
import { CloseIcon } from '../Icons'
import Markdown from './Markdown'

interface PinsPanelProps {
  /** Where the pins are, as shown to the user ("#general", "@Ana", a group name). */
  label: string
  revision: number
  load: () => Promise<Message[]>
  resolveUser: (id: string) => User
  describeError: (err: unknown) => string
  onJump: (message: Message) => void
  onUnpin: (message: Message) => void
  onClose: () => void
}

/** The channel's pinned messages; refreshes when a pin_update arrives (revision). */
function PinsPanel(props: PinsPanelProps): React.JSX.Element {
  const [pins, setPins] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { load, describeError, onClose } = props

  useEffect(() => {
    let cancelled = false
    load().then(
      (list) => {
        if (!cancelled) {
          setPins(list)
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
    <div ref={ref} className="pins-panel" role="dialog" aria-label="Pinned messages">
      <header>
        <h3>Pinned in {props.label}</h3>
        <button
          type="button"
          className="icon-button small"
          onClick={onClose}
          aria-label="Close pinned messages"
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="pins-list">
        {error && <div className="search-status error">{error}</div>}
        {!error && pins === null && <div className="search-status">Loading…</div>}
        {pins?.length === 0 && (
          <div className="search-status">No pinned messages yet. Right-click a message → Pin.</div>
        )}
        {pins?.map((m) => {
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
                <button type="button" className="link-button" onClick={() => props.onUnpin(m)}>
                  Unpin
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default PinsPanel
