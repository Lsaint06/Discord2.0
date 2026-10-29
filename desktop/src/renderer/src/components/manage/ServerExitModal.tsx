import { useEffect, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { describeError } from '../../hooks/useBackend'
import type { ApiClient } from '../../net/api'
import { ApiError } from '../../net/api'
import type { ApiMember } from '../../net/protocol'
import { ROLE_LABELS, ownerSuccessor } from '../../lib/permissions'
import type { Server, User } from '../../types'
import PasswordInput from '../auth/PasswordInput'
import { CloseIcon } from '../Icons'

export type ServerExitMode = 'leave' | 'delete'

interface ServerExitModalProps {
  api: ApiClient
  server: Pick<Server, 'id' | 'name'>
  /** 'leave' is for owners (non-owners just confirm); 'delete' removes the server for everyone. */
  mode: ServerExitMode
  meId: string
  /** The member list if already loaded (otherwise it is fetched here). */
  members?: ApiMember[]
  resolveUser: (id: string) => User
  onDone: () => void
  onClose: () => void
}

/**
 * Owner-only confirmations: leaving (ownership passes to another member) and deleting the
 * server. Both need the password, like an ownership transfer; deleting also needs the name.
 */
function ServerExitModal({
  api,
  server,
  mode,
  meId,
  members: knownMembers,
  resolveUser,
  onDone,
  onClose
}: ServerExitModalProps): React.JSX.Element {
  const [members, setMembers] = useState<ApiMember[] | undefined>(knownMembers)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newOwnerId, setNewOwnerId] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The server said we're the last member (someone left meanwhile): leaving means deleting.
  const [alone, setAlone] = useState(false)
  const dialogRef = useDialog<HTMLFormElement>({ onClose: submitting ? undefined : onClose })

  useEffect(() => {
    if (mode !== 'leave' || knownMembers) return
    let cancelled = false
    api
      .members(server.id)
      .then((list) => !cancelled && setMembers(list))
      .catch((err: unknown) => !cancelled && setLoadError(describeError(err)))
    return () => {
      cancelled = true
    }
  }, [api, server.id, mode, knownMembers])

  const isBot = (id: string): boolean => Boolean(resolveUser(id).bot)
  const candidates = (members ?? []).filter(
    (m) => m.userId !== meId && m.role !== 'owner' && !isBot(m.userId)
  )
  const suggested = members ? ownerSuccessor(members, meId, isBot) : undefined
  const target = newOwnerId || suggested?.userId || ''
  const loading = mode === 'leave' && !members && !loadError
  const deleting =
    mode === 'delete' || alone || (mode === 'leave' && members !== undefined && !suggested)
  const nameMatches = confirmName.trim() === server.name.trim()
  const ready =
    !submitting && !loading && password !== '' && (deleting ? nameMatches : target !== '')

  const title = deleting ? `Delete ‘${server.name}’` : `Leave ‘${server.name}’`

  return (
    <div className="modal-backdrop" onMouseDown={() => !submitting && onClose()}>
      <form
        ref={dialogRef}
        className="modal server-exit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-exit-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready) return
          setSubmitting(true)
          setError(null)
          try {
            if (deleting) await api.deleteServer(server.id, password)
            else await api.leaveServer(server.id, { password, newOwnerId: target })
            onDone()
          } catch (err) {
            if (err instanceof ApiError && err.code === 'last_member') setAlone(true)
            setError(describeError(err))
            setSubmitting(false)
          }
        }}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
        >
          <CloseIcon size={18} />
        </button>
        <h2 id="server-exit-title">{title}</h2>

        {loading ? (
          <p>Loading members…</p>
        ) : loadError && !deleting ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : deleting ? (
          <>
            <p>
              {mode === 'leave' ? 'You’re the only member, so leaving deletes the server. ' : ''}
              All of its channels, messages and files are deleted for everyone, and members are
              removed. <strong>This can’t be undone.</strong>
            </p>
            <label className="setting-field">
              <span className="setting-field-label">Type the server name to confirm</span>
              <input
                className="text-input"
                type="text"
                autoFocus
                value={confirmName}
                placeholder={server.name}
                spellCheck={false}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <p>
              You own this server, so someone else takes over when you leave. They get full control
              and you’ll need a new invite to come back.
            </p>
            <label className="setting-field">
              <span className="setting-field-label">New owner</span>
              <select
                className="text-input"
                value={target}
                autoFocus
                onChange={(e) => setNewOwnerId(e.target.value)}
              >
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {resolveUser(m.userId).name} ({ROLE_LABELS[m.role]})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {!loading && (deleting || !loadError) && (
          <PasswordInput
            id="server-exit-pw"
            label="Your password"
            value={password}
            autoComplete="current-password"
            onChange={setPassword}
          />
        )}

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
          <button type="submit" className="button danger" disabled={!ready}>
            {submitting
              ? deleting
                ? 'Deleting…'
                : 'Leaving…'
              : deleting
                ? 'Delete Server'
                : 'Leave Server'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default ServerExitModal
