import { useCallback, useEffect, useState } from 'react'
import { ApiError, type ApiClient } from '../../net/api'
import type {
  ApiAccount,
  ApiAuditEvent,
  ApiLegacyIdentity,
  ApiMe,
  ApiRegistrationInvite,
  ApiServer,
  ApiSession
} from '../../net/protocol'
import { LIMITS } from '../../net/protocol'
import { storageInfo, type SessionStorageKind } from '../../net/session'
import { formatTimestamp } from '../../lib/format'
import { emailCodeComplete, formatEmailCode } from '../../lib/accountForms'
import PasswordInput from '../auth/PasswordInput'
import { Field } from '../SettingsControls'

const errorText = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Something went wrong.'

function CodeReveal({ code, label }: { code: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-box" aria-label={label}>
      <code>{code}</code>
      <button
        type="button"
        className="button primary small"
        onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Milestone 13: the account's email address (for password reset by email). Adding or changing
 * it needs the current password and a code sent to the new address.
 */
function EmailSection({ api, me }: { api: ApiClient; me: ApiMe }): React.JSX.Element {
  const [mailAvailable, setMailAvailable] = useState<boolean | null>(null)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    api
      .meta()
      .then((m) => alive && setMailAvailable(m.email === true))
      .catch(() => alive && setMailAvailable(false))
    return () => {
      alive = false
    }
  }, [api])

  const act = (fn: () => Promise<void>): void => {
    setBusy(true)
    setMessage(null)
    fn()
      .catch((err: unknown) => setMessage({ error: true, text: errorText(err) }))
      .finally(() => setBusy(false))
  }

  const reset = (): void => {
    setEditing(false)
    setSentTo(null)
    setAddress('')
    setPassword('')
    setCode('')
  }

  return (
    <>
      <h3>Email address</h3>
      <p className="setting-description">
        {me.email
          ? me.emailVerified
            ? `${me.email} — confirmed. You can reset your password by email.`
            : `${me.email} — not confirmed yet.`
          : 'No email address. Add one so you can reset your password if you forget it.'}
      </p>
      {mailAvailable === false && !me.email && (
        <p className="setting-description">Email isn’t set up on this server yet.</p>
      )}
      {mailAvailable && !editing && !sentTo && (
        <div className="inline-actions">
          <button type="button" className="button secondary" onClick={() => setEditing(true)}>
            {me.email ? 'Change email' : 'Add email'}
          </button>
          {me.email && (
            <button
              type="button"
              className="button secondary danger-text"
              onClick={() => setEditing(true)}
            >
              Remove…
            </button>
          )}
        </div>
      )}
      {editing && !sentTo && (
        <form
          className="stacked-form"
          onSubmit={(e) => {
            e.preventDefault()
            act(async () => {
              await api.requestEmailChange(address.trim(), password)
              setSentTo(address.trim())
              setPassword('')
              setMessage({
                error: false,
                text: `We sent a code to ${address.trim()}. It can take a minute to arrive.`
              })
            })
          }}
        >
          <Field label="New email address">
            <input
              className="text-input"
              type="email"
              autoComplete="email"
              value={address}
              maxLength={LIMITS.emailMaxLength}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <PasswordInput
            id="email-current-password"
            label="Current password"
            value={password}
            autoComplete="current-password"
            onChange={setPassword}
          />
          {message && (
            <p className={message.error ? 'form-error' : 'form-notice'} role="status">
              {message.text}
            </p>
          )}
          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !address.trim() || !password}
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
            {me.email && (
              <button
                type="button"
                className="button secondary danger-text"
                disabled={busy || !password}
                onClick={() =>
                  act(async () => {
                    await api.removeEmail(password)
                    reset()
                    setMessage({ error: false, text: 'Email address removed.' })
                  })
                }
              >
                Remove email
              </button>
            )}
            <button type="button" className="button secondary" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {sentTo && (
        <form
          className="stacked-form"
          onSubmit={(e) => {
            e.preventDefault()
            act(async () => {
              await api.confirmEmailChange(code)
              reset()
              setMessage({ error: false, text: 'Email address confirmed.' })
            })
          }}
        >
          <Field label={`Code sent to ${sentTo}`}>
            <input
              className="text-input code-input"
              type="text"
              autoComplete="one-time-code"
              value={code}
              maxLength={9}
              placeholder="XXXX-XXXX"
              onChange={(e) => setCode(formatEmailCode(e.target.value))}
            />
          </Field>
          {message && (
            <p className={message.error ? 'form-error' : 'form-notice'} role="status">
              {message.text}
            </p>
          )}
          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !emailCodeComplete(code)}
            >
              {busy ? 'Checking…' : 'Confirm'}
            </button>
            <button type="button" className="button secondary" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!editing && !sentTo && message && (
        <p className={message.error ? 'form-error' : 'form-notice'} role="status">
          {message.text}
        </p>
      )}
    </>
  )
}

export function SecuritySection({
  api,
  me,
  onSignedOutEverywhere
}: {
  api: ApiClient
  me: ApiMe | null
  onSignedOutEverywhere: () => void
}): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [codesPassword, setCodesPassword] = useState('')
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [codesError, setCodesError] = useState<string | null>(null)
  const [storage, setStorage] = useState<SessionStorageKind | null>(null)

  useEffect(() => {
    void storageInfo().then((s) => setStorage(s.storage))
    if (me?.hasPassword) {
      api
        .recoveryCodeCount()
        .then((r) => setRemaining(r.remaining))
        .catch(() => undefined)
    }
  }, [api, me?.hasPassword])

  if (!me?.hasPassword) {
    return (
      <>
        <h2>Security</h2>
        <div className="dev-notice">
          <strong>Development identity</strong>
          <span>
            @{me?.username} has no password. Ask an administrator for a <em>claim code</em>, sign
            out, then choose “Create an account” and enter it — you keep this identity&rsquo;s
            messages, files and reactions.
          </span>
        </div>
      </>
    )
  }

  const matches = next === confirm
  return (
    <>
      <h2>Security</h2>
      <p className="setting-description">
        {storage === 'encrypted'
          ? 'This device keeps your sign-in encrypted by Windows (DPAPI) for this Windows user.'
          : 'This device can’t store your sign-in securely, so you’ll sign in again after restarting the app.'}
      </p>

      {me.email !== undefined && <EmailSection api={api} me={me} />}

      <h3>Change password</h3>
      <form
        className="stacked-form"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          setMessage(null)
          api
            .changePassword(current, next)
            .then((r) => {
              setMessage({
                error: false,
                text:
                  r.otherSessionsRevoked > 0
                    ? `Password changed. ${r.otherSessionsRevoked} other device(s) were signed out.`
                    : 'Password changed.'
              })
              setCurrent('')
              setNext('')
              setConfirm('')
            })
            .catch((err: unknown) => setMessage({ error: true, text: errorText(err) }))
            .finally(() => setBusy(false))
        }}
      >
        <PasswordInput
          id="sec-current"
          label="Current password"
          value={current}
          autoComplete="current-password"
          onChange={setCurrent}
        />
        <PasswordInput
          id="sec-new"
          label="New password"
          value={next}
          autoComplete="new-password"
          hint={`At least ${LIMITS.passwordMinLength} characters. Your other devices will be signed out.`}
          onChange={setNext}
        />
        <PasswordInput
          id="sec-confirm"
          label="Confirm new password"
          value={confirm}
          autoComplete="new-password"
          invalid={confirm.length > 0 && !matches}
          onChange={setConfirm}
        />
        {message && (
          <p className={message.error ? 'form-error' : 'form-notice'} role="status">
            {message.text}
          </p>
        )}
        <button
          type="submit"
          className="button primary"
          disabled={busy || !current || [...next].length < LIMITS.passwordMinLength || !matches}
        >
          {busy ? 'Saving…' : 'Change Password'}
        </button>
      </form>

      <h3>Recovery codes</h3>
      <p className="setting-description">
        {remaining === null
          ? '…'
          : `${remaining} unused recovery code${remaining === 1 ? '' : 's'}.`}{' '}
        Each lets you reset your password once if you forget it. Generating new codes invalidates
        the old ones.
      </p>
      {newCodes ? (
        <>
          <ol className="recovery-codes">
            {newCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <div className="manage-toolbar">
            <button
              type="button"
              className="button secondary"
              onClick={() => void navigator.clipboard.writeText(newCodes.join('\n'))}
            >
              Copy all
            </button>
            <button type="button" className="button primary" onClick={() => setNewCodes(null)}>
              I&rsquo;ve saved them
            </button>
          </div>
        </>
      ) : (
        <form
          className="stacked-form"
          onSubmit={(e) => {
            e.preventDefault()
            setCodesError(null)
            api
              .regenerateRecoveryCodes(codesPassword)
              .then((r) => {
                setNewCodes(r.codes)
                setRemaining(r.codes.length)
                setCodesPassword('')
              })
              .catch((err: unknown) => setCodesError(errorText(err)))
          }}
        >
          <PasswordInput
            id="codes-pw"
            label="Your password"
            value={codesPassword}
            autoComplete="current-password"
            onChange={setCodesPassword}
          />
          {codesError && <p className="form-error">{codesError}</p>}
          <button type="submit" className="button secondary" disabled={!codesPassword}>
            Generate New Recovery Codes
          </button>
        </form>
      )}

      <h3>Sign out everywhere</h3>
      <p className="setting-description">
        Ends every session, including this one, and disconnects you from voice. Use this if you
        think someone else has access to your account.
      </p>
      <button
        type="button"
        className="button danger"
        onClick={() => {
          if (window.confirm('Sign out on every device, including this one?')) {
            void api
              .logoutAll(false)
              .catch(() => undefined)
              .finally(onSignedOutEverywhere)
          }
        }}
      >
        Sign Out Everywhere
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------

export function DevicesSection({ api }: { api: ApiClient }): React.JSX.Element {
  const [sessions, setSessions] = useState<ApiSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    api
      .sessions()
      .then(setSessions)
      .catch((err: unknown) => setError(errorText(err)))
  }, [api])
  useEffect(load, [load])

  return (
    <>
      <h2>Devices</h2>
      <p className="setting-description">
        Everywhere you&rsquo;re signed in. Sessions end after 30 days without use, or 90 days after
        signing in.
      </p>
      {error && <p className="form-error">{error}</p>}
      {sessions === null ? (
        <p className="setting-description">Loading…</p>
      ) : (
        <>
          <ul className="manage-list">
            {sessions.map((s) => (
              <li key={s.id} className="manage-row">
                <div className="manage-row-main">
                  <span className="manage-row-title">
                    {s.device ?? 'Unknown device'}
                    {s.current && <span className="manage-tag">this device</span>}
                    {s.kind === 'dev' && <span className="manage-tag warn">development</span>}
                  </span>
                  <span className="manage-row-sub">
                    Signed in {formatTimestamp(s.createdAt)} · last active{' '}
                    {formatTimestamp(s.lastUsedAt)}
                    {s.ip ? ` · ${s.ip}` : ''}
                  </span>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() =>
                      void api
                        .revokeSession(s.id)
                        .then(load)
                        .catch((err: unknown) => setError(errorText(err)))
                    }
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void api
                  .logoutAll(true)
                  .then(load)
                  .catch((err: unknown) => setError(errorText(err)))
              }
            >
              Sign out all other devices
            </button>
          )}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

/** Re-enter your password before handing out access (shared by admin actions). */
function usePasswordGate(): {
  password: string
  field: React.JSX.Element
  clear: () => void
} {
  const [password, setPassword] = useState('')
  return {
    password,
    clear: () => setPassword(''),
    field: (
      <PasswordInput
        id="admin-pw"
        label="Your password (required for administrator actions)"
        value={password}
        autoComplete="current-password"
        onChange={setPassword}
      />
    )
  }
}

export function AdminSection({
  api,
  servers,
  meId
}: {
  api: ApiClient
  servers: ApiServer[]
  meId: string
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<ApiAccount[] | null>(null)
  const [invites, setInvites] = useState<ApiRegistrationInvite[] | null>(null)
  const [legacy, setLegacy] = useState<ApiLegacyIdentity[] | null>(null)
  const [audit, setAudit] = useState<(ApiAuditEvent & { ip: string | null })[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(0)
  const [issued, setIssued] = useState<{ label: string; code: string } | null>(null)
  const [serverId, setServerId] = useState('')
  const [note, setNote] = useState('')
  const gate = usePasswordGate()

  const load = useCallback(() => {
    Promise.all([
      api.adminAccounts(),
      api.adminRegistrationInvites(),
      api.adminLegacy(),
      api.adminAudit()
    ])
      .then(([a, i, l, e]) => {
        setAccounts(a)
        setInvites(i)
        setLegacy(l)
        setAudit(e)
        setNow(Date.now())
      })
      .catch((err: unknown) => setError(errorText(err)))
  }, [api])
  useEffect(load, [load])

  const act = (fn: () => Promise<{ label: string; code: string } | void>): void => {
    setError(null)
    fn()
      .then((result) => {
        if (result) setIssued(result)
        load()
      })
      .catch((err: unknown) => setError(errorText(err)))
  }
  const nameOf = (id: string | null): string =>
    id ? (accounts?.find((a) => a.id === id)?.username ?? 'unknown') : 'local CLI'

  return (
    <>
      <h2>Administration</h2>
      <p className="setting-description">
        Instance administrator tools. Codes are shown once — send them privately (in person or a
        direct message).
      </p>
      {gate.field}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {issued && (
        <div className="issued-code">
          <strong>{issued.label}</strong>
          <CodeReveal code={issued.code} label={issued.label} />
          <button type="button" className="link-button" onClick={() => setIssued(null)}>
            Dismiss
          </button>
        </div>
      )}

      <h3>Invite someone new</h3>
      <div className="manage-toolbar">
        <select
          className="text-input compact"
          aria-label="Also join server"
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
        >
          <option value="">No server</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              Join {s.name}
            </option>
          ))}
        </select>
        <input
          className="text-input"
          placeholder="Note (e.g. who it's for)"
          value={note}
          maxLength={100}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="button primary"
          disabled={!gate.password}
          onClick={() =>
            act(async () => {
              const invite = await api.adminCreateRegistrationInvite({
                password: gate.password,
                serverId: serverId || null,
                note: note.trim() || undefined,
                expiresInHours: 72
              })
              setNote('')
              return { label: 'Registration code (single use, 3 days)', code: invite.code ?? '' }
            })
          }
        >
          Create Registration Code
        </button>
      </div>
      {invites && invites.length > 0 && (
        <ul className="manage-list">
          {invites.slice(0, 20).map((i) => {
            const state = i.usedAt
              ? `used by ${nameOf(i.usedBy)}`
              : i.revoked
                ? 'revoked'
                : i.expiresAt <= now
                  ? 'expired'
                  : 'open'
            return (
              <li key={i.id} className={`manage-row${state !== 'open' ? ' inactive' : ''}`}>
                <div className="manage-row-main">
                  <span className="manage-row-title">
                    {i.kind === 'claim' ? `Claim @${i.claimUsername ?? '?'}` : 'Registration'} —{' '}
                    {state}
                  </span>
                  <span className="manage-row-sub">
                    {i.note ? `${i.note} · ` : ''}by {nameOf(i.createdBy)} ·{' '}
                    {formatTimestamp(i.createdAt)} · expires {formatTimestamp(i.expiresAt)}
                  </span>
                </div>
                {state === 'open' && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => act(() => api.adminRevokeRegistrationInvite(i.id))}
                  >
                    Revoke
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <h3>Development identities to migrate</h3>
      <p className="setting-description">
        These identities have history but no password. Give a claim code{' '}
        <strong>only to the person who used it</strong>; redeeming it keeps the same account
        (messages, files, reactions, unread state).
      </p>
      {legacy === null ? (
        <p className="setting-description">Loading…</p>
      ) : legacy.length === 0 ? (
        <p className="setting-description">None — everyone has an account.</p>
      ) : (
        <ul className="manage-list">
          {legacy.map((l) => (
            <li key={l.id} className="manage-row">
              <div className="manage-row-main">
                <span className="manage-row-title">
                  @{l.username} ({l.displayName})
                  {l.openClaimCode && <span className="manage-tag">code issued</span>}
                </span>
                <span className="manage-row-sub">
                  {l.messages} messages · {l.attachments} files · last seen{' '}
                  {l.lastSeenAt ? formatTimestamp(l.lastSeenAt) : 'never'}
                </span>
              </div>
              <button
                type="button"
                className="button secondary small"
                disabled={!gate.password}
                onClick={() =>
                  act(async () => {
                    const invite = await api.adminClaimCode(l.id, gate.password)
                    return {
                      label: `Claim code for @${l.username} (single use, 3 days)`,
                      code: invite.code ?? ''
                    }
                  })
                }
              >
                {l.openClaimCode ? 'New claim code' : 'Claim code'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Accounts</h3>
      {accounts && (
        <ul className="manage-list">
          {accounts
            .filter((a) => !a.bot)
            .map((a) => (
              <li key={a.id} className={`manage-row${a.disabled ? ' inactive' : ''}`}>
                <div className="manage-row-main">
                  <span className="manage-row-title">
                    @{a.username}
                    {a.instanceAdmin && <span className="manage-tag">admin</span>}
                    {!a.hasPassword && <span className="manage-tag warn">no password</span>}
                    {a.disabled && <span className="manage-tag warn">disabled</span>}
                  </span>
                  <span className="manage-row-sub">
                    {a.displayName} · since {formatTimestamp(a.createdAt)}
                  </span>
                </div>
                {a.hasPassword && (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={!gate.password}
                    onClick={() =>
                      act(async () => {
                        const r = await api.adminResetCode(a.id, gate.password)
                        return {
                          label: `Password reset code for @${a.username} (24 hours)`,
                          code: r.code
                        }
                      })
                    }
                  >
                    Reset code
                  </button>
                )}
                {a.id !== meId && (
                  <button
                    type="button"
                    className={`button small ${a.disabled ? 'secondary' : 'danger'}`}
                    disabled={!gate.password}
                    onClick={() => {
                      if (
                        a.disabled ||
                        window.confirm(
                          `Disable @${a.username}? They are signed out everywhere immediately.`
                        )
                      ) {
                        act(() =>
                          api
                            .adminSetDisabled(a.id, !a.disabled, gate.password)
                            .then(() => undefined)
                        )
                      }
                    }}
                  >
                    {a.disabled ? 'Enable' : 'Disable'}
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}

      <h3>Security log</h3>
      {audit && (
        <ul className="manage-list audit-list">
          {audit.slice(0, 50).map((e) => (
            <li key={e.id} className="manage-row">
              <div className="manage-row-main">
                <span className="manage-row-title">
                  {e.action}
                  {e.actorId ? ` · ${nameOf(e.actorId)}` : ''}
                  {e.targetUserId && e.targetUserId !== e.actorId
                    ? ` → ${nameOf(e.targetUserId)}`
                    : ''}
                </span>
                <span className="manage-row-sub">
                  {formatTimestamp(e.at)}
                  {e.ip ? ` · ${e.ip}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Field label="Command-line tools">
        <span className="setting-description">
          On the server: <code>npm run admin -- help</code> (Docker:{' '}
          <code>docker compose exec server node dist/cli/admin.js help</code>).
        </span>
      </Field>
    </>
  )
}
