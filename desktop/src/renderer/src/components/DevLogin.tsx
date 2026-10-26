import { useEffect, useState } from 'react'
import { ApiClient, ApiError } from '../net/api'
import { LogoIcon } from './Icons'

interface DevLoginProps {
  serverUrl: string
  notice?: string | null
  onLoggedIn: (token: string, username: string) => void
}

type ServerCheck =
  { state: 'checking' } | { state: 'ok'; devAuth: boolean } | { state: 'down'; error: string }

function DevLogin({ serverUrl, notice, onLoggedIn }: DevLoginProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<ServerCheck>({ state: 'checking' })
  const [checkAttempt, setCheckAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    new ApiClient(serverUrl)
      .meta()
      .then((meta) => !cancelled && setCheck({ state: 'ok', devAuth: meta.devAuth }))
      .catch((err: unknown) => {
        if (cancelled) return
        setCheck({
          state: 'down',
          error: err instanceof ApiError ? err.message : 'Cannot reach the server.'
        })
      })
    return () => {
      cancelled = true
    }
  }, [serverUrl, checkAttempt])

  const recheck = (): void => {
    setCheck({ state: 'checking' })
    setCheckAttempt((n) => n + 1)
  }

  const submit = async (): Promise<void> => {
    const name = username.trim()
    if (!name || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await new ApiClient(serverUrl).devLogin(name)
      onLoggedIn(result.token, result.user.username)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed.')
      setSubmitting(false)
    }
  }

  const canSubmit = check.state === 'ok' && check.devAuth && username.trim().length >= 2

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="login-logo">
          <LogoIcon size={40} />
        </div>
        <h1>Welcome to Discord 2.0</h1>
        <p className="login-sub">Pick a development identity to join your server.</p>

        {notice && <p className="form-notice">{notice}</p>}

        <div className={`server-check ${check.state}`}>
          <span className="server-check-dot" />
          <span className="server-check-url">{serverUrl}</span>
          <span className="server-check-state">
            {check.state === 'checking' && 'Checking…'}
            {check.state === 'ok' && (check.devAuth ? 'Online' : 'Dev sign-in disabled')}
            {check.state === 'down' && 'Unreachable'}
          </span>
          {check.state === 'down' && (
            <button type="button" className="link-button" onClick={recheck}>
              Retry
            </button>
          )}
        </div>
        {check.state === 'down' && (
          <p className="form-error">
            {check.error} Is the backend running (<code>npm run dev</code> in <code>server/</code>)?
          </p>
        )}
        {check.state === 'ok' && !check.devAuth && (
          <p className="form-error">
            This server has development identities turned off. Real sign-in isn&rsquo;t implemented
            yet.
          </p>
        )}

        <label className="setting-field">
          <span className="setting-field-label">Username</span>
          <input
            className="text-input"
            type="text"
            autoFocus
            value={username}
            maxLength={32}
            placeholder="e.g. alice"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="button primary login-button"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Signing in…' : 'Continue'}
        </button>

        <p className="dev-warning">
          Development only: identities have no password, so anyone who can reach this server can
          sign in as any username. Keep the server on your own PC or a trusted network.
        </p>
      </form>
    </div>
  )
}

export default DevLogin
