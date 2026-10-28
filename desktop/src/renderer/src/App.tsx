import { useCallback, useEffect, useState } from 'react'
import AuthScreen, { type AuthSuccess } from './components/auth/AuthScreen'
import { endpointsConfig, initialEndpoint, rememberEndpoint } from './net/config'
import type { Endpoint } from './net/endpoints'
import {
  clearSession,
  loadSession,
  saveSession,
  savedSessionServer,
  type StoredSession
} from './net/session'
import Workspace from './Workspace'
import { LogoIcon } from './components/Icons'

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

function Splash({ label = 'Starting Discord 2.0…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="app splash">
      <div className="splash-card" role="status" aria-live="polite">
        <div className="splash-logo" aria-hidden="true">
          <LogoIcon size={56} />
        </div>
        <div className="spinner" aria-hidden="true" />
        <p className="splash-label">{label}</p>
      </div>
    </div>
  )
}

type GateState =
  | { phase: 'loading' }
  /** `connection`: Connection settings opened from the workspace; the saved sign-in is kept. */
  | { phase: 'signed-out'; notice: string | null; connection?: boolean }
  | { phase: 'signed-in'; session: StoredSession; newAccount: boolean }

function SessionGate({
  endpoint,
  endpoints,
  onSelectEndpoint
}: {
  endpoint: Endpoint
  endpoints: Endpoint[]
  onSelectEndpoint: (id: string) => void
}): React.JSX.Element {
  const { httpUrl, gatewayUrl } = endpoint
  const [state, setState] = useState<GateState>({ phase: 'loading' })
  const [loadCount, setLoadCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    // A saved token is used only with the server it was issued by.
    loadSession(httpUrl)
      .then((session) => {
        if (cancelled) return
        setState(
          session
            ? { phase: 'signed-in', session, newAccount: false }
            : { phase: 'signed-out', notice: null }
        )
      })
      .catch(() => !cancelled && setState({ phase: 'signed-out', notice: null }))
    return () => {
      cancelled = true
    }
  }, [httpUrl, loadCount])

  /** Back from Connection settings without changing anything: reopen the saved sign-in. */
  const reloadSession = useCallback(() => {
    setState({ phase: 'loading' })
    setLoadCount((n) => n + 1)
  }, [])
  const openConnection = useCallback(
    () => setState({ phase: 'signed-out', notice: null, connection: true }),
    []
  )

  // Clears the stored token first, so a crash right after can't resurrect the session.
  const signOut = useCallback((notice?: string) => {
    void clearSession().finally(() => setState({ phase: 'signed-out', notice: notice ?? null }))
  }, [])

  const signedIn = useCallback(
    (result: AuthSuccess) => {
      const session = { token: result.token, username: result.username, serverUrl: httpUrl }
      void saveSession(session).finally(() =>
        setState({ phase: 'signed-in', session, newAccount: result.newAccount === true })
      )
    },
    [httpUrl]
  )

  if (state.phase === 'loading') return <Splash />

  if (state.phase === 'signed-out') {
    return (
      <AuthScreen
        key={httpUrl}
        serverUrl={httpUrl}
        servers={endpoints}
        onSelectServer={onSelectEndpoint}
        notice={state.notice}
        initialView={state.connection ? 'connection' : undefined}
        onLeaveConnection={state.connection ? reloadSession : undefined}
        onAuthenticated={signedIn}
      />
    )
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
      newAccount={state.newAccount}
      onSignOut={signOut}
      onOpenConnectionSettings={endpoints.length > 1 ? openConnection : undefined}
    />
  )
}

function EndpointGate({ endpoints }: { endpoints: Endpoint[] }): React.JSX.Element {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null)

  useEffect(() => {
    let cancelled = false
    savedSessionServer()
      .catch(() => null)
      .then((server) => {
        if (!cancelled) setEndpoint(initialEndpoint(endpoints, server))
      })
    return () => {
      cancelled = true
    }
  }, [endpoints])

  const select = useCallback(
    (id: string) => {
      const next = endpoints.find((e) => e.id === id)
      if (!next) return
      rememberEndpoint(next)
      setEndpoint(next)
    },
    [endpoints]
  )

  if (!endpoint) return <Splash />
  return (
    <SessionGate
      key={endpoint.id}
      endpoint={endpoint}
      endpoints={endpoints}
      onSelectEndpoint={select}
    />
  )
}

function App(): React.JSX.Element {
  if (!endpointsConfig.ok) return <ConfigError message={endpointsConfig.error} />
  return <EndpointGate endpoints={endpointsConfig.endpoints} />
}

export default App
