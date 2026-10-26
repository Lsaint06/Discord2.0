import type { GatewayStatus } from '../net/gateway'

interface ConnectionBannerProps {
  status: GatewayStatus
  retryInMs?: number
}

function ConnectionBanner({ status, retryInMs }: ConnectionBannerProps): React.JSX.Element | null {
  if (status === 'connected' || status === 'closed') return null

  let text = 'Connecting to server…'
  if (status === 'reconnecting') {
    text =
      retryInMs !== undefined
        ? `Connection lost. Reconnecting in ${Math.max(1, Math.round(retryInMs / 1000))}s…`
        : 'Reconnecting…'
  } else if (status === 'auth_failed') {
    text = 'Your session is no longer valid.'
  }

  return (
    <div className={`connection-banner ${status}`} role="status" aria-live="polite">
      <span className="connection-dot" />
      {text}
    </div>
  )
}

export default ConnectionBanner
