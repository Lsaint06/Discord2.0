import { useId, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { LIMITS } from '../../net/protocol'
import { CloseIcon, LogoIcon } from '../Icons'

export interface WelcomeProgress {
  hasAvatar: boolean
  friendCount: number
  serverCount: number
}

interface WelcomeModalProps {
  displayName: string
  progress: WelcomeProgress
  /** Resolves to an error message, or null when saved. */
  onSaveDisplayName: (name: string) => Promise<string | null>
  onChoosePicture: () => void
  onAddFriends: () => void
  onJoinServer: () => void
  /** Done or skipped: never shown again for this account on this PC. */
  onClose: () => void
}

/**
 * A short, skippable introduction for brand-new accounts: confirm your name, optionally add a
 * picture, then add friends or join a server. Every step can be done later from the app.
 */
function WelcomeModal({
  displayName,
  progress,
  onSaveDisplayName,
  onChoosePicture,
  onAddFriends,
  onJoinServer,
  onClose
}: WelcomeModalProps): React.JSX.Element {
  const dialogRef = useDialog<HTMLDivElement>({ onClose })
  const ids = useId()
  const [name, setName] = useState(displayName)
  const [saving, setSaving] = useState(false)
  const [nameState, setNameState] = useState<{ ok: boolean; text: string } | null>(null)
  const trimmed = name.trim()

  const saveName = async (): Promise<void> => {
    if (!trimmed || saving) return
    if (trimmed === displayName) {
      setNameState({ ok: true, text: 'Saved.' })
      return
    }
    setSaving(true)
    const failure = await onSaveDisplayName(trimmed)
    setSaving(false)
    setNameState(failure ? { ok: false, text: failure } : { ok: true, text: 'Saved.' })
  }

  const step = (
    done: boolean | 'info',
    title: string,
    text: string,
    action: React.ReactNode
  ): React.JSX.Element => (
    <li className={`welcome-step${done === true ? ' done' : done === 'info' ? ' info' : ''}`}>
      <span className="welcome-step-mark" aria-hidden="true">
        {done === true ? '✓' : done === 'info' ? 'i' : ''}
      </span>
      <div className="welcome-step-body">
        <span className="welcome-step-title">
          {title}
          {done === true && <span className="sr-only"> (done)</span>}
        </span>
        <span className="welcome-step-text">{text}</span>
      </div>
      <div className="welcome-step-action">{action}</div>
    </li>
  )

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal welcome-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-sub`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <div className="welcome-hero" aria-hidden="true">
          <LogoIcon size={44} />
        </div>
        <h2 id={`${ids}-title`}>Welcome to Discord 2.0!</h2>
        <p id={`${ids}-sub`} className="welcome-sub">
          Your account is ready. A few optional steps to get started — you can do all of them later
          too.
        </p>

        <form
          className="welcome-name"
          onSubmit={(e) => {
            e.preventDefault()
            void saveName()
          }}
        >
          <label className="setting-field-label" htmlFor={`${ids}-name`}>
            Your display name
          </label>
          <div className="welcome-name-row">
            <input
              id={`${ids}-name`}
              className="text-input"
              type="text"
              value={name}
              maxLength={LIMITS.displayNameMaxLength}
              autoComplete="nickname"
              aria-describedby={nameState ? `${ids}-name-state` : undefined}
              onChange={(e) => {
                setName(e.target.value)
                setNameState(null)
              }}
            />
            <button type="submit" className="button secondary" disabled={!trimmed || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {nameState && (
            <span
              id={`${ids}-name-state`}
              className={`field-hint ${nameState.ok ? 'success' : 'error'}`}
              role={nameState.ok ? 'status' : 'alert'}
            >
              {nameState.text}
            </span>
          )}
        </form>

        <ol className="welcome-steps">
          {step(
            progress.hasAvatar,
            'Add a profile picture',
            'Help friends recognize you.',
            <button type="button" className="button secondary small" onClick={onChoosePicture}>
              {progress.hasAvatar ? 'Change' : 'Choose picture'}
            </button>
          )}
          {step(
            progress.friendCount > 0,
            'Add friends',
            'Send a request with their username.',
            <button type="button" className="button secondary small" onClick={onAddFriends}>
              Add friends
            </button>
          )}
          {step(
            progress.serverCount > 0,
            'Join a server',
            progress.serverCount > 0
              ? `You’re in ${progress.serverCount} server${progress.serverCount === 1 ? '' : 's'}.`
              : 'Got an invite code from a friend? Paste it here.',
            <button type="button" className="button secondary small" onClick={onJoinServer}>
              Join a server
            </button>
          )}
          {step(
            'info',
            'Find your conversations',
            'Direct messages and groups are under the Home button at the top left.',
            null
          )}
        </ol>

        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Skip for now
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            Start chatting
          </button>
        </div>
      </div>
    </div>
  )
}

export default WelcomeModal
