import { useCallback, useEffect, useState } from 'react'
import AuthScreen, { type AuthSuccess } from './components/auth/AuthScreen'
import { serverConfig } from './net/config'
import { clearSession, loadSession, saveSession, type StoredSession } from './net/session'
import Workspace from './Workspace'

function ConfigError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>Server not configured</h1>
        <p className="form-error">{message}</p>
        <p className="login-sub">
          See <code>desktop/.env.example</code> for the available settings.
        </p>
      </div>
    </div>
  )
}

type GateState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; notice: string | null }
  | { phase: 'signed-in'; session: StoredSession }

function SessionGate({
  httpUrl,
  gatewayUrl
}: {
  httpUrl: string
  gatewayUrl: string
}): React.JSX.Element {
  const [state, setState] = useState<GateState>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadSession(httpUrl)
      .then((session) => {
        if (cancelled) return
        setState(session ? { phase: 'signed-in', session } : { phase: 'signed-out', notice: null })
      })
      .catch(() => !cancelled && setState({ phase: 'signed-out', notice: null }))
    return () => {
      cancelled = true
    }
  }, [httpUrl])

  // Clears the stored token first, so a crash right after can't resurrect the session.
  const signOut = useCallback((notice?: string) => {
    void clearSession().finally(() => setState({ phase: 'signed-out', notice: notice ?? null }))
  }, [])

  const signedIn = useCallback(
    (result: AuthSuccess) => {
      const session = { token: result.token, username: result.username, serverUrl: httpUrl }
      void saveSession(session).finally(() => setState({ phase: 'signed-in', session }))
    },
    [httpUrl]
  )

  if (state.phase === 'loading') {
    return (
      <div className="app splash">
        <div className="splash-card">
          <div className="spinner" aria-hidden="true" />
        </div>
      </div>
    )
  }

  if (state.phase === 'signed-out') {
    return <AuthScreen serverUrl={httpUrl} notice={state.notice} onAuthenticated={signedIn} />
  }

  return (
    <Workspace
      // A different account (token) always gets a fresh workspace: no state leaks between users.
      key={state.session.token}
      session={{
        token: state.session.token,
        username: state.session.username,
        httpUrl,
        gatewayUrl
      }}
      onSignOut={signOut}
    />
  )
}

function App(): React.JSX.Element {
  if (!serverConfig.ok) return <ConfigError message={serverConfig.error} />
  return <SessionGate httpUrl={serverConfig.httpUrl} gatewayUrl={serverConfig.gatewayUrl} />
}

export default App
