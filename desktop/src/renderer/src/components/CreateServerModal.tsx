import { useEffect, useState } from 'react'
import { accentChoices } from '../data/mockData'
import { initials } from '../lib/format'
import { CloseIcon } from './Icons'

interface CreateServerModalProps {
  onCreate: (name: string, color: string) => void
  onClose: () => void
}

function CreateServerModal({ onCreate, onClose }: CreateServerModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState(accentChoices[0])

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
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) onCreate(trimmed, color)
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

        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!trimmed}>
            Create
          </button>
        </div>
      </form>
    </div>
  )
}

export default CreateServerModal
