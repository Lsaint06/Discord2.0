import { useEffect, useId, useState } from 'react'
import { ApiClient, ApiError, type InviteInfo, type ServerMeta } from '../../net/api'
import { LIMITS, type ApiAuthResult } from '../../net/protocol'
import { storageInfo } from '../../net/session'
import { describeConnectionFailure, type ServerOption } from '../../net/networkErrors'
import {
  emailCodeComplete,
  formatEmailCode,
  looksLikeEmail,
  passwordChecks,
  passwordOk,
  secondsLeft,
  usernameProblem
} from '../../lib/accountForms'
import { LogoIcon } from '../Icons'
import PasswordInput from './PasswordInput'

export interface AuthSuccess {
  token: string
  username: string
  /** The account was just created (the app shows its short introduction). */
  newAccount?: boolean
}

interface AuthScreenProps {
  serverUrl: string
  /** The approved servers built into this app (choosable in Connection settings). */
  servers?: { id: string; label: string; insecure: boolean }[]
  onSelectServer?: (id: string) => void
  /** Why the user is here (e.g. session expired). */
  notice?: string | null
  /** Start on Connection settings (opened from the workspace while the server is unreachable). */
  initialView?: 'connection'
  /** "Done" in Connection settings goes back here instead of the sign-in form. */
  onLeaveConnection?: () => void
  onAuthenticated: (result: AuthSuccess) => void
}

type View =
  | 'login'
  | 'signup'
  | 'verify'
  | 'forgot'
  | 'reset'
  | 'register'
  | 'recover'
  | 'dev'
  | 'codes'
  | 'connection'

type ServerCheck =
  { state: 'checking' } | { state: 'ok'; meta: ServerMeta } | { state: 'down'; error: string }

/** What a pending sign-up needs to be confirmed (kept in memory only, never stored). */
interface VerifyTarget {
  login: string
  password: string
  /** Shown as "we sent a code to …" when known. */
  email: string | null
}

/** Stable default, so `servers` can be an effect dependency without re-running it each render. */
const NO_SERVERS: ServerOption[] = []
const RESEND_COOLDOWN_MS = 60_000

const message = (err: unknown, fallback: string): string =>
  err instanceof ApiError
    ? err.code === 'rate_limited' && err.retryAfterMs
      ? `Too many attempts. Try again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`
      : err.code === 'internal_error' || err.code === 'http_error'
        ? fallback
        : err.message
    : fallback

/**
 * A plain-language reason when the server can't be reached at all (certificate, DNS, offline,
 * refused, timeout), using Chromium's error code from the main process when available.
 */
async function connectionMessage(
  err: unknown,
  serverUrl: string,
  servers: ServerOption[],
  fallback: string
): Promise<string> {
  if (!(err instanceof ApiError && err.isNetwork)) return message(err, fallback)
  let code: string | null = err.code === 'timeout' ? 'ERR_TIMED_OUT' : null
  const lookup = window.d2?.net?.lastError
  for (let i = 0; !code && lookup && i < 2; i++) {
    // The main process records the failure asynchronously; give it a moment the second time.
    if (i > 0) await new Promise((r) => setTimeout(r, 250))
    code = await lookup(serverUrl).catch(() => null)
  }
  return describeConnectionFailure(code, serverUrl, servers)
}

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

/** Live password requirements (announced politely to screen readers). */
function PasswordRules({
  id,
  password,
  confirm,
  username
}: {
  id: string
  password: string
  confirm: string
  username?: string
}): React.JSX.Element {
  const checks = passwordChecks(password, confirm, username)
  const rule = (ok: boolean, text: string): React.JSX.Element => (
    <li className={ok ? 'ok' : ''}>
      <span aria-hidden="true">{ok ? '✓' : '•'}</span> {text}
      <span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span>
    </li>
  )
  return (
    <ul id={id} className="password-rules" aria-live="polite">
      {rule(checks.longEnough, `At least ${LIMITS.passwordMinLength} characters`)}
      {username !== undefined &&
        rule(checks.notUsername && password.length > 0, 'Not based on your username')}
      {rule(checks.matches, 'Both passwords match')}
    </ul>
  )
}

/** A text field with a label and an accessible inline error. */
function Field({
  id,
  label,
  error,
  hint,
  children
}: {
  id: string
  label: string
  error?: string | null
  hint?: string
  children: (describedBy: string | undefined, invalid: boolean) => React.ReactNode
}): React.JSX.Element {
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="setting-field">
      <label className="setting-field-label" htmlFor={id}>
        {label}
      </label>
      {children(describedBy || undefined, Boolean(error))}
      {error ? (
        <span id={`${id}-error`} className="field-hint error" role="alert">
          {error}
        </span>
      ) : (
        hint && (
          <span id={`${id}-hint`} className="field-hint muted">
            {hint}
          </span>
        )
      )}
    </div>
  )
}

function AuthScreen({
  serverUrl,
  servers = NO_SERVERS,
  onSelectServer,
  notice,
  initialView,
  onLeaveConnection,
  onAuthenticated
}: AuthScreenProps): React.JSX.Element {
  const [view, setView] = useState<View>(initialView ?? 'login')
  const [check, setCheck] = useState<ServerCheck>({ state: 'checking' })
  const [checkAttempt, setCheckAttempt] = useState(0)
  const [device, setDevice] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Non-error status (e.g. "we sent a new code"). */
  const [info, setInfo] = useState<string | null>(null)
  /** Show field errors after the first submit attempt (not while someone is still typing). */
  const [attempted, setAttempted] = useState(false)

  const [login, setLogin] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [pending, setPending] = useState<{ result: ApiAuthResult; codes: string[] } | null>(null)
  const [verifyTarget, setVerifyTarget] = useState<VerifyTarget | null>(null)
  const [resetEmail, setResetEmail] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const ids = useId()

  useEffect(() => {
    let cancelled = false
    new ApiClient(serverUrl)
      .meta()
      .then((meta) => !cancelled && setCheck({ state: 'ok', meta }))
      .catch(async (err: unknown) => {
        const text = await connectionMessage(err, serverUrl, servers, 'Can’t reach the server.')
        if (!cancelled) setCheck({ state: 'down', error: text })
      })
    void storageInfo().then((s) => !cancelled && setDevice(s.device))
    return () => {
      cancelled = true
    }
  }, [serverUrl, checkAttempt, servers])

  // Resend countdown (ticks only while one is running).
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [cooldownUntil])

  const go = (next: View): void => {
    setView(next)
    setError(null)
    setInfo(null)
    setAttempted(false)
    setCode('')
    if (next !== 'verify' && next !== 'reset') {
      setPassword('')
      setConfirm('')
    }
    if (next !== 'register') setInvite(null)
  }

  const retryConnection = (): void => {
    setCheck({ state: 'checking' })
    setCheckAttempt((n) => n + 1)
  }

  const client = new ApiClient(serverUrl)
  const run = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      const text = await connectionMessage(err, serverUrl, servers, fallback)
      // Lost the server mid-way: show it in the connection status (with Retry), not as a form error.
      if (err instanceof ApiError && err.isNetwork) setCheck({ state: 'down', error: text })
      else setError(text)
    } finally {
      setSubmitting(false)
    }
  }

  const meta = check.state === 'ok' ? check.meta : null
  // Milestone 8 needs profile/presence support on the server too.
  const accountsSupported = meta?.accounts === true && meta.profiles === true
  const devAllowed = meta?.devAuth === true
  const registration = meta?.registration ?? 'invite'
  const emailAccounts = meta?.emailAccounts === true
  const emailReset = emailAccounts && meta?.email === true
  const checks = passwordChecks(password, confirm, view === 'signup' ? username : '')
  const cooldown = secondsLeft(cooldownUntil, now)

  const finish = (result: ApiAuthResult): void =>
    onAuthenticated({
      token: result.token,
      username: result.user.username,
      newAccount: result.newAccount === true
    })

  const startVerify = (target: VerifyTarget, note: string | null): void => {
    setVerifyTarget(target)
    setCode('')
    setError(null)
    setInfo(note)
    setAttempted(false)
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
    setNow(Date.now())
    setView('verify')
  }

  // ---- Actions ----

  const signIn = (): Promise<void> =>
    run(async () => {
      try {
        finish(await client.login(login.trim(), password, device))
      } catch (err) {
        // Right password, address not confirmed yet: continue with the code.
        if (err instanceof ApiError && err.code === 'email_unverified') {
          startVerify(
            {
              login: login.trim(),
              password,
              email: login.includes('@') ? login.trim() : null
            },
            err.message
          )
          return
        }
        throw err
      }
    }, 'Sign in failed.')

  const signup = (): Promise<void> => {
    setAttempted(true)
    if (!looksLikeEmail(email) || usernameProblem(username) || !passwordOk(checks)) {
      return Promise.resolve()
    }
    return run(async () => {
      await client.signup({
        email: email.trim(),
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password
      })
      startVerify({ login: email.trim(), password, email: email.trim() }, null)
    }, 'Couldn’t create the account. Try again.')
  }

  const verify = (): Promise<void> =>
    run(async () => {
      if (!verifyTarget) return
      finish(
        await client.verifyEmail({
          login: verifyTarget.login,
          password: verifyTarget.password,
          code,
          device
        })
      )
    }, 'That didn’t work. Try again.')

  const resend = (): Promise<void> =>
    run(async () => {
      if (!verifyTarget || cooldown > 0) return
      await client.resendVerification(verifyTarget.login, verifyTarget.password)
      setCode('')
      setInfo('We sent a new code. It can take a minute to arrive; check your spam folder too.')
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
      setNow(Date.now())
    }, 'Couldn’t send a new code. Try again.')

  const forgot = (): Promise<void> => {
    setAttempted(true)
    if (!looksLikeEmail(email)) return Promise.resolve()
    return run(async () => {
      await client.forgotPassword(email.trim())
      setResetEmail(email.trim())
      setCode('')
      setPassword('')
      setConfirm('')
      setAttempted(false)
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
      setNow(Date.now())
      setView('reset')
      setInfo(`If ${email.trim()} belongs to an account, we sent it a reset code.`)
    }, 'Couldn’t send a reset code. Try again.')
  }

  const reset = (): Promise<void> =>
    run(async () => {
      finish(await client.resetPassword({ email: resetEmail, code, newPassword: password, device }))
    }, 'Couldn’t reset the password. Try again.')

  const resendReset = (): Promise<void> =>
    run(async () => {
      if (cooldown > 0) return
      await client.forgotPassword(resetEmail)
      setInfo(`If ${resetEmail} belongs to an account, we sent it a new reset code.`)
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
      setNow(Date.now())
    }, 'Couldn’t send a reset code. Try again.')

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
    }, 'Couldn’t create the account.')

  const recover = (): Promise<void> =>
    run(async () => {
      finish(
        await client.recover({
          username: login.trim(),
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
  const infoBox = info && (
    <p className="form-notice" role="status">
      {info}
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

  const current = servers.find((s) => s.id === serverUrl)
  const statusLine = (
    <div className={`server-check ${check.state}`} role="status">
      <span className="server-check-dot" aria-hidden="true" />
      <span className="server-check-state">
        {check.state === 'checking' && 'Connecting…'}
        {check.state === 'ok' && 'Connected'}
        {check.state === 'down' && 'Can’t connect'}
      </span>
      {check.state === 'down' && (
        <button type="button" className="link-button" onClick={retryConnection}>
          Retry
        </button>
      )}
    </div>
  )

  // ---- Connection settings (advanced) ----
  if (view === 'connection') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-logo">
            <LogoIcon size={40} />
          </div>
          <h1>Connection settings</h1>
          <p className="login-sub">
            Discord 2.0 connects to its server automatically. Change this only if you were asked to,
            for example to connect over your home network.
          </p>
          <fieldset className="connection-options">
            <legend className="sr-only">Server</legend>
            {servers.map((s) => (
              <label
                key={s.id}
                className={`connection-option${s.id === serverUrl ? ' selected' : ''}`}
              >
                <input
                  type="radio"
                  name="server"
                  value={s.id}
                  checked={s.id === serverUrl}
                  onChange={() => onSelectServer?.(s.id)}
                />
                <span className="connection-option-text">
                  <span className="setting-label">{s.label}</span>
                  <span className="setting-description">
                    {s.insecure ? 'Only on your home network · ' : 'Works anywhere · '}
                    <code>{s.id}</code>
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {statusLine}
          {check.state === 'down' && (
            <p className="form-error" role="alert">
              {check.error}
            </p>
          )}
          <p className="field-hint muted">
            Your sign-in is kept separately for each connection: switching never moves it to another
            server.
          </p>
          <button
            type="button"
            className="button primary login-button"
            onClick={() => (onLeaveConnection ? onLeaveConnection() : go('login'))}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  const titles: Record<Exclude<View, 'codes' | 'connection'>, [string, string]> = {
    login: ['Welcome back!', 'Sign in to Discord 2.0.'],
    signup: ['Create an account', 'Join your friends on Discord 2.0. It takes a minute.'],
    verify: [
      'Check your email',
      verifyTarget?.email
        ? `We sent a code to ${verifyTarget.email}. Enter it below to finish.`
        : 'We sent a code to your email address. Enter it below to finish.'
    ],
    forgot: ['Forgot your password?', 'Enter your account’s email address and we’ll send a code.'],
    reset: ['Reset your password', 'Enter the code from the email and choose a new password.'],
    register: [
      invite?.kind === 'claim' ? 'Claim your account' : 'Create an account',
      invite
        ? invite.kind === 'claim'
          ? `This code claims @${invite.username}. Your messages, files and reactions stay yours.`
          : invite.serverName
            ? `You'll join ${invite.serverName}.`
            : 'Pick a username and a password.'
        : 'Enter the invitation code you were given.'
    ],
    recover: [
      'Use a recovery code',
      'Use one of your recovery codes, or a reset code from an administrator.'
    ],
    dev: [
      'Development sign-in',
      'No password. Only for identities that haven’t been claimed yet, and only while the server allows it.'
    ]
  }
  const [title, subtitle] = titles[view as keyof typeof titles]

  const emailError =
    attempted && !looksLikeEmail(email)
      ? 'Enter a valid email address, like name@example.com.'
      : null
  const usernameError = attempted ? usernameProblem(username) : null

  return (
    <div className="login-screen">
      <form
        className="login-card"
        noValidate
        aria-busy={submitting}
        onSubmit={(e) => {
          e.preventDefault()
          if (view === 'login') void signIn()
          else if (view === 'signup') void signup()
          else if (view === 'verify') void verify()
          else if (view === 'forgot') void forgot()
          else if (view === 'reset') void reset()
          else if (view === 'register') void (invite ? register() : checkInvite())
          else if (view === 'recover') void recover()
          else if (view === 'dev') void devLogin()
        }}
      >
        <div className="login-logo">
          <LogoIcon size={40} />
        </div>
        <h1>{title}</h1>
        <p className="login-sub">{subtitle}</p>

        {notice && view === 'login' && <p className="form-notice">{notice}</p>}
        {statusLine}
        {check.state === 'down' && (
          <p className="form-error" role="alert">
            {check.error}
            {import.meta.env.DEV && (
              <>
                {' '}
                Is the backend running (<code>npm run dev</code> in <code>server/</code>)?
              </>
            )}
          </p>
        )}
        {meta && !accountsSupported && (
          <p className="form-error">This server is older than the app and needs an update.</p>
        )}
        {infoBox}

        {view === 'login' && (
          <>
            <label className="setting-field" htmlFor={`${ids}-user`}>
              <span className="setting-field-label">
                {emailAccounts ? 'Email or username' : 'Username'}
              </span>
              <input
                id={`${ids}-user`}
                className="text-input"
                type="text"
                autoFocus
                autoComplete="username"
                spellCheck={false}
                value={login}
                maxLength={LIMITS.emailMaxLength}
                onChange={(e) => setLogin(e.target.value)}
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
              disabled={!accountsSupported || submitting || !login.trim() || !password}
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
            <div className="auth-links">
              <button
                type="button"
                className="link-button"
                onClick={() => go(emailReset ? 'forgot' : 'recover')}
              >
                Forgot your password?
              </button>
              {registration === 'open' && (
                <button type="button" className="link-button" onClick={() => go('signup')}>
                  Need an account? <strong>Register</strong>
                </button>
              )}
              {registration === 'invite' && (
                <button type="button" className="link-button" onClick={() => go('register')}>
                  Have an invitation? Create an account
                </button>
              )}
            </div>
          </>
        )}

        {view === 'signup' && (
          <>
            <Field id={`${ids}-email`} label="Email" error={emailError}>
              {(describedBy, invalid) => (
                <input
                  id={`${ids}-email`}
                  className="text-input"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  spellCheck={false}
                  value={email}
                  maxLength={LIMITS.emailMaxLength}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Field
              id={`${ids}-newuser`}
              label="Username"
              error={usernameError}
              hint="Letters, numbers, “.”, “_” or “-”. Friends add you with it."
            >
              {(describedBy, invalid) => (
                <input
                  id={`${ids}-newuser`}
                  className="text-input"
                  type="text"
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  maxLength={LIMITS.usernameMaxLength}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => setUsername(e.target.value)}
                />
              )}
            </Field>
            <Field
              id={`${ids}-display`}
              label="Display name (optional)"
              hint="How others see you. You can change it later."
            >
              {(describedBy) => (
                <input
                  id={`${ids}-display`}
                  className="text-input"
                  type="text"
                  autoComplete="nickname"
                  value={displayName}
                  maxLength={LIMITS.displayNameMaxLength}
                  placeholder={username.trim() || undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              )}
            </Field>
            <PasswordInput
              id={`${ids}-newpw`}
              label="Password"
              value={password}
              autoComplete="new-password"
              invalid={attempted && (!checks.longEnough || !checks.notUsername)}
              describedBy={`${ids}-rules`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-confirm`}
              label="Confirm password"
              value={confirm}
              autoComplete="new-password"
              invalid={(attempted || confirm.length > 0) && !checks.matches}
              describedBy={`${ids}-rules`}
              onChange={setConfirm}
            />
            <PasswordRules
              id={`${ids}-rules`}
              password={password}
              confirm={confirm}
              username={username}
            />
            <p className="field-hint muted">
              A few random words make a strong password that’s easy to remember.
            </p>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={!accountsSupported || submitting}
            >
              {submitting ? 'Creating your account…' : 'Create account'}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button" onClick={() => go('login')}>
                Already have an account? <strong>Sign in</strong>
              </button>
              <button type="button" className="link-button muted" onClick={() => go('register')}>
                Have an invitation code?
              </button>
            </div>
          </>
        )}

        {view === 'verify' && verifyTarget && (
          <>
            <Field
              id={`${ids}-vcode`}
              label="Verification code"
              hint="8 letters and numbers, like 7K3Q-9XTA."
            >
              {(describedBy) => (
                <input
                  id={`${ids}-vcode`}
                  className="text-input code-input"
                  type="text"
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="text"
                  spellCheck={false}
                  value={code}
                  maxLength={9}
                  placeholder="XXXX-XXXX"
                  aria-describedby={describedBy}
                  onChange={(e) => setCode(formatEmailCode(e.target.value))}
                />
              )}
            </Field>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={submitting || !emailCodeComplete(code)}
            >
              {submitting ? 'Checking…' : 'Verify and continue'}
            </button>
            <div className="auth-links">
              <button
                type="button"
                className="link-button"
                disabled={submitting || cooldown > 0}
                onClick={() => void resend()}
              >
                {cooldown > 0 ? `Send a new code (${cooldown}s)` : 'Didn’t get it? Send a new code'}
              </button>
              <button type="button" className="link-button muted" onClick={() => go('signup')}>
                Use a different email address
              </button>
            </div>
          </>
        )}

        {view === 'forgot' && (
          <>
            <Field id={`${ids}-femail`} label="Email" error={emailError}>
              {(describedBy, invalid) => (
                <input
                  id={`${ids}-femail`}
                  className="text-input"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  spellCheck={false}
                  value={email}
                  maxLength={LIMITS.emailMaxLength}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={!accountsSupported || submitting || !email.trim()}
            >
              {submitting ? 'Sending…' : 'Send reset code'}
            </button>
            <div className="auth-links">
              <button type="button" className="link-button muted" onClick={() => go('recover')}>
                Use a recovery code instead
              </button>
            </div>
          </>
        )}

        {view === 'reset' && (
          <>
            <Field id={`${ids}-rcode2`} label="Reset code">
              {(describedBy) => (
                <input
                  id={`${ids}-rcode2`}
                  className="text-input code-input"
                  type="text"
                  autoFocus
                  autoComplete="one-time-code"
                  spellCheck={false}
                  value={code}
                  maxLength={9}
                  placeholder="XXXX-XXXX"
                  aria-describedby={describedBy}
                  onChange={(e) => setCode(formatEmailCode(e.target.value))}
                />
              )}
            </Field>
            <PasswordInput
              id={`${ids}-rnew`}
              label="New password"
              value={password}
              autoComplete="new-password"
              describedBy={`${ids}-rrules`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-rnew2`}
              label="Confirm new password"
              value={confirm}
              autoComplete="new-password"
              invalid={confirm.length > 0 && !checks.matches}
              describedBy={`${ids}-rrules`}
              onChange={setConfirm}
            />
            <PasswordRules id={`${ids}-rrules`} password={password} confirm={confirm} />
            <p className="field-hint muted">You’ll be signed out on all your other devices.</p>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={
                submitting || !emailCodeComplete(code) || !checks.longEnough || !checks.matches
              }
            >
              {submitting ? 'Resetting…' : 'Reset password and sign in'}
            </button>
            <div className="auth-links">
              <button
                type="button"
                className="link-button"
                disabled={submitting || cooldown > 0}
                onClick={() => void resendReset()}
              >
                {cooldown > 0 ? `Send a new code (${cooldown}s)` : 'Send a new code'}
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
              <Field
                id={`${ids}-ireg`}
                label="Username"
                hint="2–32 characters: letters, numbers, “.”, “_” or “-”. You sign in with it."
              >
                {(describedBy) => (
                  <input
                    id={`${ids}-ireg`}
                    className="text-input"
                    type="text"
                    autoFocus
                    autoComplete="username"
                    spellCheck={false}
                    value={username}
                    maxLength={LIMITS.usernameMaxLength}
                    aria-describedby={describedBy}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                )}
              </Field>
            ) : (
              <div className="setting-field">
                <span className="setting-field-label">Username</span>
                <span className="claim-username">@{invite.username}</span>
              </div>
            )}
            <label className="setting-field" htmlFor={`${ids}-idisplay`}>
              <span className="setting-field-label">Display name</span>
              <input
                id={`${ids}-idisplay`}
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
              id={`${ids}-ipw`}
              label="Password"
              value={password}
              autoComplete="new-password"
              describedBy={`${ids}-irules`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-iconfirm`}
              label="Confirm password"
              value={confirm}
              autoComplete="new-password"
              invalid={confirm.length > 0 && !checks.matches}
              describedBy={`${ids}-irules`}
              onChange={setConfirm}
            />
            <PasswordRules id={`${ids}-irules`} password={password} confirm={confirm} />
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={
                submitting ||
                !checks.longEnough ||
                !checks.matches ||
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
                value={login}
                maxLength={LIMITS.usernameMaxLength}
                onChange={(e) => setLogin(e.target.value)}
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
              describedBy={`${ids}-crules`}
              onChange={setPassword}
            />
            <PasswordInput
              id={`${ids}-rconfirm`}
              label="Confirm new password"
              value={confirm}
              autoComplete="new-password"
              invalid={confirm.length > 0 && !checks.matches}
              describedBy={`${ids}-crules`}
              onChange={setConfirm}
            />
            <PasswordRules id={`${ids}-crules`} password={password} confirm={confirm} />
            <p className="field-hint muted">All your devices will be signed out.</p>
            {errorBox}
            <button
              type="submit"
              className="button primary login-button"
              disabled={
                !accountsSupported ||
                submitting ||
                !login.trim() ||
                code.trim().length < 16 ||
                !checks.longEnough ||
                !checks.matches
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

        {view !== 'login' && view !== 'signup' && (
          <div className="auth-links">
            <button type="button" className="link-button" onClick={() => go('login')}>
              Back to sign in
            </button>
          </div>
        )}
        <div className="auth-links auth-footer">
          {servers.length > 1 && onSelectServer && (
            <button
              type="button"
              className={`link-button muted${check.state === 'down' ? ' emphasized' : ''}`}
              onClick={() => go('connection')}
            >
              Connection settings{current && servers.length > 1 ? ` · ${current.label}` : ''}
            </button>
          )}
          {view === 'login' && devAllowed && (
            <button type="button" className="link-button muted" onClick={() => go('dev')}>
              Use a development identity (no password)
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

export default AuthScreen
