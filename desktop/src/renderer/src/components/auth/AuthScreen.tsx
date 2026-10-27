import { useEffect, useId, useState } from 'react'
import { ApiClient, ApiError, type InviteInfo, type ServerMeta } from '../../net/api'
import { LIMITS, type ApiAuthResult } from '../../net/protocol'
import { storageInfo } from '../../net/session'
import { LogoIcon } from '../Icons'
import PasswordInput from './PasswordInput'

export interface AuthSuccess {
  token: string
  username: string
}

interface AuthScreenProps {
  serverUrl: string
  /** Why the user is here (e.g. session expired). */
  notice?: string | null
  onAuthenticated: (result: AuthSuccess) => void
}

type View = 'login' | 'register' | 'recover' | 'dev' | 'codes'

type ServerCheck =
  { state: 'checking' } | { state: 'ok'; meta: ServerMeta } | { state: 'down'; error: string }

const message = (err: unknown, fallback: string): string =>
  err instanceof ApiError
    ? err.code === 'rate_limited' && err.retryAfterMs
      ? `Too many attempts. Try again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`
      : err.message
    : fallback

function RecoveryCodes({
  codes,
  onDone
}: {
  codes: string[]
  onDone: () => void
}): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="auth-form">
      <h1>Save your recovery codes</h1>
      <p className="login-sub">
        If you forget your password, each code lets you set a new one once. They are shown only now
        — store them in a password manager or print them.
      </p>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="button secondary"
        onClick={() =>
          void navigator.clipboard.writeText(codes.join('\n')).then(() => setCopied(true))
        }
      >
        {copied ? 'Copied' : 'Copy all'}
      </button>
      <label className="checkbox-row">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I&rsquo;ve saved my recovery codes somewhere safe
      </label>
      <button
        type="button"
        className="button primary login-button"
        disabled={!saved}
        onClick={onDone}
      >
        Continue to Discord 2.0
      </button>
    </div>
  )
}

function AuthScreen({ serverUrl, notice, onAuthenticated }: AuthScreenProps): React.JSX.Element {
  const [view, setView] = useState<View>('login')
  const [check, setCheck] = useState<ServerCheck>({ state: 'checking' })
  const [checkAttempt, setCheckAttempt] = useState(0)
  const [device, setDevice] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [pending, setPending] = useState<{ result: ApiAuthResult; codes: string[] } | null>(null)
  const ids = useId()

  useEffect(() => {
    let cancelled = false
    new ApiClient(serverUrl)
      .meta()
      .then((meta) => !cancelled && setCheck({ state: 'ok', meta }))
      .catch((err: unknown) => {
        if (!cancelled) setCheck({ state: 'down', error: message(err, 'Cannot reach the server.') })
      })
    void storageInfo().then((s) => !cancelled && setDevice(s.device))
    return () => {
      cancelled = true
    }
  }, [serverUrl, checkAttempt])

  const go = (next: View): void => {
    setView(next)
    setError(null)
    setPassword('')
    setConfirm('')
    if (next !== 'register') {
      setInvite(null)
      setCode('')
    }
  }

  const client = new ApiClient(serverUrl)
  const run = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(message(err, fallback))
    } finally {
      setSubmitting(false)
    }
  }

  // Milestone 8 needs profile/presence support on the server too.
  const accountsSupported =
    check.state === 'ok' && check.meta.accounts === true && check.meta.profiles === true
  const devAllowed = check.state === 'ok' && check.meta.devAuth
  const passwordsMatch = password === confirm
  const longEnough = [...password].length >= LIMITS.passwordMinLength

  const finish = (result: ApiAuthResult): void =>
    onAuthenticated({ token: result.token, username: result.user.username })

  const login = (): Promise<void> =>
    run(async () => {
      finish(await client.login(username.trim(), password, device))
    }, 'Sign in failed.')

  const checkInvite = (): Promise<void> =>
    run(async () => {
      const found = await client.inviteInfo(code.trim())
      setInvite(found)
      if (found.kind === 'claim') setDisplayName(found.displayName)
    }, 'That code didn’t work.')

  const register = (): Promise<void> =>
    run(async () => {
      const result = await client.register({
        code: code.trim(),
        ...(invite?.kind === 'register' ? { username: username.trim() } : {}),
        displayName: displayName.trim() || undefined,
        password,
        device
      })
      setPending({ result, codes: result.recoveryCodes ?? [] })
      setView('codes')
    }, 'Could not create the account.')

  const recover = (): Promise<void> =>
    run(async () => {
      finish(
        await client.recover({
          username: username.trim(),
          code: code.trim(),
          newPassword: password,
          device
        })
      )
    }, 'Recovery failed.')

  const devLogin = (): Promise<void> =>
    run(async () => {
      finish(await client.devLogin(username.trim(), device))
    }, 'Sign in failed.')

  const errorBox = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  )

  if (view === 'codes' && pending) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <RecoveryCodes codes={pending.codes} onDone={() => finish(pending.result)} />
        </div>
      </div>
    )
  }

  return (
    <div className="login-screen">
      <form
        className="login-card"
        noValidate
        aria-busy={submitting}
        onSubmit={(e) => {
          e.preventDefault()
          if (view === 'login') void login()
          else if (view === 'register') void (invite ? register() : checkInvite())
          else if (view === 'recover') void recover()
          else if (view === 'dev') void devLogin()
        }}
      >
        <div className="login-logo">
          <LogoIcon size={40} />
        </div>

        {view === 'login' && (
          <>
            <h1>Welcome back!</h1>
            <p className="login-sub">Sign in to your Discord 2.0 account.</p>
          </>
        )}
        {view === 'register' && (
          <>
            <h1>{invite?.kind === 'claim' ? 'Claim your account' : 'Create an account'}</h1>
            <p className="login-sub">
              {invite
                ? invite.kind === 'claim'
                  ? `This code claims @${invite.username}. Your messages, files and reactions stay yours.`
                  : invite.serverName
                    ? `You'll join ${invite.serverName}.`
                    : 'Pick a username and a password.'
                : 'Accounts are invite-only. Enter the code an administrator gave you.'}
            </p>
          </>
        )}
        {view === 'recover' && (
          <>
            <h1>Reset your password</h1>
            <p className="login-sub">
              Use one of your recovery codes, or a reset code from an administrator.
            </p>
          </>
        )}
        {view === 'dev' && (
          <>
            <h1>Development sign-in</h1>
            <p className="login-sub">
              No password. Only for identities that haven&rsquo;t been claimed yet, and only while
              the server allows it.
            </p>
          </>
        )}

        {notice && <p className="form-notice">{notice}</p>}
        <div className={`server-check ${check.state}`}>
          <span className="server-check-dot" />
          <span className="server-check-url">{serverUrl}</span>
          <span className="server-check-state">
            {check.state === 'checking' && 'Checking…'}
            {check.state === 'ok' && 'Online'}
            {check.state === 'down' && 'Unreachable'}
          </span>
          {check.state === 'down' && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setCheck({ state: 'checking' })
                setCheckAttempt((n) => n + 1)
              }}
            >
              Retry
            </button>
          )}
        </div>
        {check.state === 'down' && (
          <p className="form-error">
            {check.error} Is the backend running (<code>npm run dev</code> in <code>server/</code>)?
          </p>
        )}
        {check.state === 'ok' && !accountsSupported && (
          <p className="form-error">
            This server is older than the app. Update the backend to use this version.
          </p>
        )}

        {view === 'login' && (
          <>
            <label className="setting-field" htmlFor={`${ids}-user`}>
              <span className="setting-field-label">Username</span>
              <input
                id={`${ids}-user`}
                className="text-input"
                type="text"
                autoFocus
                autoComplete="username"
                spellCheck={false}
                value={username}
                maxLength={LIMITS.usernameMaxLength}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <PasswordInput
              id={`${ids}-pw`}
              label="Password"
              value={password}
              autoComplete="current-password"
              onChange={setPassword}
            />
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={!accountsSupported || submitting || !username.trim() || !password}
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => go('recover')}>
                Forgot your password?
              </button>
              <button type="button" className="link-button" onClick={() => go('register')}>
                Have an invitation? Create an account
              </button>
            </div>
          </>
        )}

        {view === 'register' && !invite && (
          <>
            <label className="setting-field" htmlFor={`${ids}-code`}>
              <span className="setting-field-label">Invitation code</span>
              <input
                id={`${ids}-code`}
                className="text-input code-input"
                type="text"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                value={code}
                maxLength={40}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={!accountsSupported || submitting || code.trim().length < 20}
            >
              {submitting ? 'Checking…' : 'Continue'}
            </button>
          </>
        )}

        {view === 'register' && invite && (
          <>
            {invite.kind === 'register' ? (
              <div className="setting-field">
                <label className="setting-field-label" htmlFor={`${ids}-newuser`}>
                  Username
                </label>
                <input
                  id={`${ids}-newuser`}
                  className="text-input"
                  type="text"
                  autoFocus
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  maxLength={LIMITS.usernameMaxLength}
                  aria-describedby={`${ids}-userhint`}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <span id={`${ids}-userhint`} className="field-hint muted">
                  2–32 characters: letters, numbers, “.”, “_” or “-”. You sign in with it.
                </span>
              </div>
            ) : (
              <div className="setting-field">
                <span className="setting-field-label">Username</span>
                <span className="claim-username">@{invite.username}</span>
              </div>
            )}
            <label className="setting-field" htmlFor={`${ids}-display`}>
              <span className="setting-field-label">Display name</span>
              <input
                id={`${ids}-display`}
                className="text-input"
                type="text"
                autoComplete="nickname"
                value={displayName}
                maxLength={LIMITS.displayNameMaxLength}
                placeholder={invite.kind === 'register' ? username || 'How others see you' : ''}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <PasswordInput
              id={`${ids}-newpw`}
              label="Password"
              value={password}
              autoComplete="new-password"
              hint={`At least ${LIMITS.passwordMinLength} characters. A few random words make a great password; a password manager works too.`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-confirm`}
              label="Confirm password"
              value={confirm}
              autoComplete="new-password"
              invalid={confirm.length > 0 && !passwordsMatch}
              hint={confirm.length > 0 && !passwordsMatch ? 'Passwords don’t match.' : undefined}
              onChange={setConfirm}
            />
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={
                submitting ||
                !longEnough ||
                !passwordsMatch ||
                (invite.kind === 'register' && username.trim().length < 2)
              }
            >
              {submitting
                ? 'Creating…'
                : invite.kind === 'claim'
                  ? 'Claim account'
                  : 'Create account'}
            </button>
          </>
        )}

        {view === 'recover' && (
          <>
            <label className="setting-field" htmlFor={`${ids}-ruser`}>
              <span className="setting-field-label">Username</span>
              <input
                id={`${ids}-ruser`}
                className="text-input"
                type="text"
                autoFocus
                autoComplete="username"
                spellCheck={false}
                value={username}
                maxLength={LIMITS.usernameMaxLength}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="setting-field" htmlFor={`${ids}-rcode`}>
              <span className="setting-field-label">Recovery or reset code</span>
              <input
                id={`${ids}-rcode`}
                className="text-input code-input"
                type="text"
                autoComplete="one-time-code"
                spellCheck={false}
                value={code}
                maxLength={40}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <PasswordInput
              id={`${ids}-rpw`}
              label="New password"
              value={password}
              autoComplete="new-password"
              hint={`At least ${LIMITS.passwordMinLength} characters. All your devices will be signed out.`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-rconfirm`}
              label="Confirm new password"
              value={confirm}
              autoComplete="new-password"
              invalid={confirm.length > 0 && !passwordsMatch}
              onChange={setConfirm}
            />
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={
                !accountsSupported ||
                submitting ||
                !username.trim() ||
                code.trim().length < 16 ||
                !longEnough ||
                !passwordsMatch
              }
            >
              {submitting ? 'Resetting…' : 'Reset password and sign in'}
            </button>
          </>
        )}

        {view === 'dev' && (
          <>
            <label className="setting-field" htmlFor={`${ids}-dev`}>
              <span className="setting-field-label">Development username</span>
              <input
                id={`${ids}-dev`}
                className="text-input"
                type="text"
                autoFocus
                value={username}
                maxLength={LIMITS.usernameMaxLength}
                placeholder="e.g. alice"
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={!devAllowed || submitting || username.trim().length < 2}
            >
              {submitting ? 'Signing in…' : 'Continue without a password'}
            </button>
            <p className="dev-warning">
              Development only: anyone who can reach this server can use any unclaimed identity.
            </p>
          </>
        )}

        {view !== 'login' && (
          <div className="auth-links">
            <button type="button" className="link-button" onClick={() => go('login')}>
              Back to sign in
            </button>
          </div>
        )}
        {view === 'login' && devAllowed && (
          <div className="auth-links dev">
            <button type="button" className="link-button muted" onClick={() => go('dev')}>
              Use a development identity (no password)
            </button>
          </div>
        )}
      </form>
    </div>
  )
}

export default AuthScreen
