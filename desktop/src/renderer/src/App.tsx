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

function Splash(): React.JSX.Element {
  return (
    <div className="app splash">
      <div className="splash-card">
        <div className="spinner" aria-hidden="true" />
      </div>
    </div>
  )
}

type GateState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; notice: string | null }
  | { phase: 'signed-in'; session: StoredSession }

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

  useEffect(() => {
    let cancelled = false
    // A saved token is used only with the server it was issued by.
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

  if (state.phase === 'loading') return <Splash />

  if (state.phase === 'signed-out') {
    return (
      <AuthScreen
        key={httpUrl}
        serverUrl={httpUrl}
        servers={endpoints}
        onSelectServer={onSelectEndpoint}
        notice={state.notice}
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
      onSignOut={signOut}
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
