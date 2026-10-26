import { useCallback, useState } from 'react'
import DevLogin from './components/DevLogin'
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

function SessionGate({
  httpUrl,
  gatewayUrl
}: {
  httpUrl: string
  gatewayUrl: string
}): React.JSX.Element {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession(httpUrl))
  const [notice, setNotice] = useState<string | null>(null)

  const signOut = useCallback((reason?: string) => {
    clearSession()
    setSession(null)
    setNotice(reason ?? null)
  }, [])

  if (!session) {
    return (
      <DevLogin
        serverUrl={httpUrl}
        notice={notice}
        onLoggedIn={(token, username) => {
          const next = { token, username, serverUrl: httpUrl }
          saveSession(next)
          setSession(next)
          setNotice(null)
        }}
      />
    )
  }

  return (
    <Workspace
      key={session.token}
      session={{ token: session.token, username: session.username, httpUrl, gatewayUrl }}
      onSignOut={signOut}
    />
  )
}

function App(): React.JSX.Element {
  if (!serverConfig.ok) return <ConfigError message={serverConfig.error} />
  return <SessionGate httpUrl={serverConfig.httpUrl} gatewayUrl={serverConfig.gatewayUrl} />
}

export default App
