import { useState } from 'react'
import { useDialog } from '../hooks/useDialog'
import { accentChoices } from '../data/defaults'
import { initials } from '../lib/format'
import type { ApiClient } from '../net/api'
import type { ApiServer } from '../net/protocol'
import { CloseIcon } from './Icons'
import { JoinServerForm } from './manage/InviteModal'

interface CreateServerModalProps {
  /** Resolves to an error message, or null on success. */
  onCreate: (name: string, color: string) => Promise<string | null>
  api: ApiClient
  onJoined: (server: ApiServer) => void
  onClose: () => void
}

function CreateServerModal({
  onCreate,
  api,
  onJoined,
  onClose
}: CreateServerModalProps): React.JSX.Element {
  const [mode, setMode] = useState<'create' | 'join'>('join')
  const [name, setName] = useState('')
  const [color, setColor] = useState(accentChoices[0])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One dialog behavior for both tabs (the element changes between them).
  const dialogRef = useDialog<HTMLElement>({ onClose })
  const setDialog = (el: HTMLElement | null): void => {
    dialogRef.current = el
  }

  const trimmed = name.trim()

  const tabs = (
    <div className="modal-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'join'}
        className={mode === 'join' ? 'active' : ''}
        onClick={() => setMode('join')}
      >
        Join a server
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'create'}
        className={mode === 'create' ? 'active' : ''}
        onClick={() => setMode('create')}
      >
        Create a server
      </button>
    </div>
  )

  if (mode === 'join') {
    return (
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          ref={setDialog}
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="Join a server"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
          {tabs}
          <JoinServerForm api={api} onJoined={onJoined} onCancel={onClose} />
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        ref={setDialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-server-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!trimmed || submitting) return
          setSubmitting(true)
          setError(null)
          const failure = await onCreate(trimmed, color)
          // On success the parent unmounts this modal.
          if (failure) {
            setError(failure)
            setSubmitting(false)
          }
        }}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        {tabs}
        <h2 id="create-server-title">Create a server</h2>
        <p>Give your new server a name and a color. You become its owner.</p>

        <div className="server-preview" style={{ background: color }}>
          {trimmed ? initials(trimmed) : '?'}
        </div>

        <label className="setting-field">
          <span className="setting-field-label">Server Name</span>
          <input
            className="text-input"
            type="text"
            autoFocus
            value={name}
            maxLength={40}
            placeholder="My Awesome Server"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="setting-field">
          <span className="setting-field-label">Color</span>
          <div className="swatches">
            {accentChoices.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
              />
            ))}
          </div>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!trimmed || submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default CreateServerModal
