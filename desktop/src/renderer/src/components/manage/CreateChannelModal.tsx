import { useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { CloseIcon, HashIcon, SpeakerIcon } from '../Icons'

export type NewChannelType = 'text' | 'voice'

interface CreateChannelModalProps {
  /** The category the channel goes into (shown, and sent to the server). */
  categoryName: string
  initialType: NewChannelType
  /** Resolves to an error message, or null on success (the parent then closes this). */
  onCreate: (name: string, type: NewChannelType) => Promise<string | null>
  onClose: () => void
}

/** Quick "create channel" from the + next to a category in the channel list. */
function CreateChannelModal({
  categoryName,
  initialType,
  onCreate,
  onClose
}: CreateChannelModalProps): React.JSX.Element {
  const [type, setType] = useState<NewChannelType>(initialType)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialog<HTMLFormElement>({ onClose: submitting ? undefined : onClose })
  const trimmed = name.trim()

  const option = (value: NewChannelType, label: string, hint: string): React.JSX.Element => (
    <label className={`channel-type-option${type === value ? ' selected' : ''}`}>
      <input
        type="radio"
        name="channel-type"
        value={value}
        checked={type === value}
        onChange={() => setType(value)}
      />
      {value === 'text' ? <HashIcon size={20} /> : <SpeakerIcon size={20} />}
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </label>
  )

  return (
    <div className="modal-backdrop" onMouseDown={() => !submitting && onClose()}>
      <form
        ref={dialogRef}
        className="modal create-channel-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!trimmed || submitting) return
          setSubmitting(true)
          setError(null)
          const failure = await onCreate(trimmed, type)
          if (failure) {
            setError(failure)
            setSubmitting(false)
          }
        }}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <h2 id="create-channel-title">Create Channel</h2>
        <p>in {categoryName}</p>

        <fieldset className="channel-type-options">
          <legend className="setting-field-label">Channel Type</legend>
          {option('text', 'Text', 'Messages, images, GIFs and files')}
          {option('voice', 'Voice', 'Talk and share your screen')}
        </fieldset>

        <label className="setting-field">
          <span className="setting-field-label">Channel Name</span>
          <input
            className="text-input"
            type="text"
            autoFocus
            value={name}
            maxLength={40}
            placeholder={type === 'text' ? 'new-channel' : 'Hangout'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!trimmed || submitting}>
            {submitting ? 'Creating…' : 'Create Channel'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default CreateChannelModal
