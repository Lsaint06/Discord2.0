import { useEffect, useId, useRef, useState } from 'react'
import { USER_NOTE_MAX_LENGTH } from '../../net/protocol'

export interface UserNoteSupport {
  /** The note as loaded so far (undefined = not loaded yet). */
  value: string | undefined
  load: (userId: string) => Promise<string>
  /** Resolves to an error message, or null when saved. */
  save: (userId: string, note: string) => Promise<string | null>
}

interface UserNoteFieldProps extends UserNoteSupport {
  userId: string
  name: string
}

/**
 * Milestone 14: your private note about someone. Saved when you leave the field (or press
 * Ctrl+Enter), and when the popout closes with unsaved text. Nobody else can read it.
 */
function UserNoteField({ userId, name, value, load, save }: UserNoteFieldProps): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const shown = draft ?? value ?? ''
  const pending = useRef<{ draft: string | null; value: string | undefined }>({ draft, value })
  useEffect(() => {
    pending.current = { draft, value }
  })

  useEffect(() => {
    if (value === undefined) void load(userId).catch(() => undefined)
    // Only when another person's popout opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Closing the popout must not lose what you typed.
  useEffect(
    () => () => {
      const { draft: unsaved, value: saved } = pending.current
      if (unsaved !== null && unsaved.trim() !== (saved ?? '')) void save(userId, unsaved)
    },
    [save, userId]
  )

  const commit = async (): Promise<void> => {
    if (draft === null || draft.trim() === (value ?? '')) {
      setDraft(null)
      return
    }
    setStatus({ text: 'Saving…', error: false })
    const failure = await save(userId, draft)
    if (failure) {
      setStatus({ text: `Couldn’t save: ${failure}`, error: true })
      return
    }
    setDraft(null)
    setStatus({ text: 'Saved', error: false })
  }

  return (
    <div className="user-note">
      <label htmlFor={id} className="user-note-label">
        Note <span className="user-note-private">only you can see this</span>
      </label>
      <textarea
        id={id}
        className="user-note-input"
        rows={2}
        maxLength={USER_NOTE_MAX_LENGTH}
        placeholder={value === undefined ? 'Loading…' : `Click to add a note about ${name}`}
        disabled={value === undefined && draft === null}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value)
          setStatus(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void commit()
          }
        }}
      />
      {status && (
        <span className={`user-note-status${status.error ? ' error' : ''}`} role="status">
          {status.text}
        </span>
      )}
    </div>
  )
}

export default UserNoteField
