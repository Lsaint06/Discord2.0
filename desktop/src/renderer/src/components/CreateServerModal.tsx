import { useEffect, useState } from 'react'
import { accentChoices } from '../data/defaults'
import { initials } from '../lib/format'
import { CloseIcon } from './Icons'

interface CreateServerModalProps {
  /** Resolves to an error message, or null on success. */
  onCreate: (name: string, color: string) => Promise<string | null>
  onClose: () => void
}

function CreateServerModal({ onCreate, onClose }: CreateServerModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState(accentChoices[0])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmed = name.trim()

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
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
        <h2 id="create-server-title">Create a server</h2>
        <p>Give your new server a name and a color. You can always change these later.</p>

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
