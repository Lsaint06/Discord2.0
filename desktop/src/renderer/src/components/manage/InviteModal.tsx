import { useEffect, useState } from 'react'
import { ApiError, type ApiClient } from '../../net/api'
import type { ApiInvitePreview, ApiServer } from '../../net/protocol'
import { initials } from '../../lib/format'
import { CloseIcon } from '../Icons'

const EXPIRY = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' }
]
const USES: (number | null)[] = [1, 5, 10, 25, null]

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

/** Creates a server invite and shows its code once (only a verifier is stored on the server). */
export function InviteModal({
  api,
  serverId,
  serverName,
  onClose
}: {
  api: ApiClient
  serverId: string
  serverName: string
  onClose: () => void
}): React.JSX.Element {
  const [hours, setHours] = useState(24)
  const [maxUses, setMaxUses] = useState<number | null>(1)
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEscape(onClose)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const invite = await api.createInvite(serverId, { expiresInHours: hours, maxUses })
      setCode(invite.code ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invite.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={18} />
        </button>
        <h2 id="invite-title">Invite friends to {serverName}</h2>
        {code ? (
          <>
            <p>
              Send this code privately. They use <strong>+ → Join a server</strong> in the app.
              It&rsquo;s shown only now.
            </p>
            <div className="code-box">
              <code>{code}</code>
              <button
                type="button"
                className="button primary small"
                onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="setting-description">
              Expires in {EXPIRY.find((e) => e.hours === hours)?.label}
              {maxUses
                ? `, usable ${maxUses === 1 ? 'once' : `${maxUses} times`}`
                : ', no use limit'}
              . People also need an account on this Discord 2.0 server.
            </p>
            <div className="modal-footer">
              <button type="button" className="button primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label className="setting-field">
              <span className="setting-field-label">Expire after</span>
              <select
                className="text-input"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                {EXPIRY.map((e) => (
                  <option key={e.hours} value={e.hours}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-field">
              <span className="setting-field-label">Max number of uses</span>
              <select
                className="text-input"
                value={maxUses ?? 'none'}
                onChange={(e) =>
                  setMaxUses(e.target.value === 'none' ? null : Number(e.target.value))
                }
              >
                {USES.map((u) => (
                  <option key={u ?? 'none'} value={u ?? 'none'}>
                    {u === null ? 'No limit' : u === 1 ? '1 use' : `${u} uses`}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-footer">
              <button type="button" className="button secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/** Join a server with an invite code: preview first, then join. */
export function JoinServerForm({
  api,
  onJoined,
  onCancel
}: {
  api: ApiClient
  onJoined: (server: ApiServer) => void
  onCancel: () => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<ApiInvitePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!preview) setPreview(await api.previewInvite(code.trim()))
      else onJoined(await api.acceptInvite(code.trim()))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That invite didn’t work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <p>Enter an invite code from a member of the server.</p>
      <label className="setting-field">
        <span className="setting-field-label">Invite code</span>
        <input
          className="text-input code-input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          value={code}
          maxLength={40}
          onChange={(e) => {
            setCode(e.target.value)
            setPreview(null)
            setError(null)
          }}
        />
      </label>
      {preview && (
        <div className="invite-preview">
          <div className="server-preview small" style={{ background: preview.serverColor }}>
            {initials(preview.serverName)}
          </div>
          <div>
            <strong>{preview.serverName}</strong>
            <span>
              {preview.memberCount} member{preview.memberCount === 1 ? '' : 's'}
              {preview.member ? ' · you’re already a member' : ''}
            </span>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy || code.trim().length < 16}>
          {busy
            ? 'Checking…'
            : preview
              ? preview.member
                ? 'Open server'
                : 'Join server'
              : 'Continue'}
        </button>
      </div>
    </form>
  )
}
