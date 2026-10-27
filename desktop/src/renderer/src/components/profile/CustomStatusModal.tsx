import { useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import type { CustomStatusInput } from '../../net/api'
import { LIMITS, type ApiCustomStatus } from '../../net/protocol'
import {
  describeStatusExpiry,
  STATUS_EXPIRY_LABELS,
  statusExpiryMs,
  type StatusExpiryOption
} from '../../lib/appearance'
import EmojiPicker from '../chat/EmojiPicker'
import { CloseIcon } from '../Icons'

interface CustomStatusModalProps {
  current: ApiCustomStatus | null
  recentEmoji: string[]
  /** Resolves to an error message or null. `null` input clears the status. */
  onSave: (input: CustomStatusInput | null) => Promise<string | null>
  onClose: () => void
}

const OPTIONS = Object.keys(STATUS_EXPIRY_LABELS) as StatusExpiryOption[]

function CustomStatusModal({
  current,
  recentEmoji,
  onSave,
  onClose
}: CustomStatusModalProps): React.JSX.Element {
  const [text, setText] = useState(current?.text ?? '')
  const [emoji, setEmoji] = useState<string | null>(current?.emoji ?? null)
  const [expiry, setExpiry] = useState<StatusExpiryOption>(current ? 'never' : 'today')
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  // The emoji picker handles (and stops) its own Escape first.
  const dialogRef = useDialog<HTMLDivElement>({ onClose: saving ? undefined : onClose })

  const save = async (clear = false): Promise<void> => {
    setSaving(true)
    setError(null)
    const trimmed = text.trim()
    const input: CustomStatusInput | null =
      clear || (!trimmed && !emoji)
        ? null
        : {
            text: trimmed || null,
            emoji,
            // Keep the current expiry when it isn't changed; otherwise compute from now.
            expiresInMs:
              current && expiry === 'never' && current.expiresAt
                ? Math.max(60_000, current.expiresAt - Date.now())
                : statusExpiryMs(expiry, new Date())
          }
    const failure = await onSave(input)
    setSaving(false)
    if (failure) setError(failure)
    else onClose()
  }

  const currentExpiry = current ? describeStatusExpiry(current.expiresAt, now) : null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal custom-status-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Set a custom status"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <h2>Set a custom status</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="field-label" htmlFor="custom-status-text">
            What’s up?
          </label>
          <div className="custom-status-input">
            <button
              type="button"
              className="custom-status-emoji-button"
              onClick={() => setPicking((v) => !v)}
              aria-label={emoji ? `Emoji ${emoji}. Change emoji` : 'Choose an emoji'}
              aria-expanded={picking}
            >
              {emoji ?? '🙂'}
            </button>
            <input
              id="custom-status-text"
              className="text-input"
              type="text"
              value={text}
              autoFocus
              maxLength={LIMITS.customStatusMaxLength}
              placeholder="Support has arrived!"
              onChange={(e) => setText(e.target.value)}
            />
            {(text || emoji) && (
              <button
                type="button"
                className="icon-button small"
                aria-label="Clear text and emoji"
                onClick={() => {
                  setText('')
                  setEmoji(null)
                }}
              >
                <CloseIcon size={14} />
              </button>
            )}
            {picking && (
              <EmojiPicker
                placement="message"
                recent={recentEmoji}
                label="Status emoji"
                onPick={(e) => {
                  setEmoji(e)
                  setPicking(false)
                }}
                onClose={() => setPicking(false)}
              />
            )}
          </div>
          <span className="field-hint muted">
            {text.length}/{LIMITS.customStatusMaxLength}
          </span>

          <label className="field-label" htmlFor="custom-status-expiry">
            Clear after
          </label>
          <select
            id="custom-status-expiry"
            className="text-input"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as StatusExpiryOption)}
          >
            {OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o === 'never' && currentExpiry
                  ? `Keep current (${currentExpiry.toLowerCase()})`
                  : STATUS_EXPIRY_LABELS[o]}
              </option>
            ))}
          </select>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            {current && (
              <button
                type="button"
                className="button danger-link"
                onClick={() => void save(true)}
                disabled={saving}
              >
                Clear status
              </button>
            )}
            <button type="button" className="button secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CustomStatusModal
