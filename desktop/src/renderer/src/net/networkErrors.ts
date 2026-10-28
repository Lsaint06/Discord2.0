/**
 * Plain-language explanations for connection failures on the sign-in screen. The error code comes
 * from the main process (Chromium's net::ERR_* code for the last failed request to the server);
 * without it, a generic message is shown.
 */

export type NetworkProblem = 'certificate' | 'dns' | 'offline' | 'refused' | 'timeout' | 'unknown'

export function classifyNetError(code: string | null | undefined): NetworkProblem {
  if (!code) return 'unknown'
  if (/^ERR_(CERT_|SSL_|BAD_SSL_|CERTIFICATE_)/.test(code) || code === 'ERR_INSECURE_RESPONSE')
    return 'certificate'
  if (code === 'ERR_NAME_NOT_RESOLVED' || code === 'ERR_NAME_RESOLUTION_FAILED') return 'dns'
  if (code === 'ERR_INTERNET_DISCONNECTED') return 'offline'
  if (
    [
      'ERR_CONNECTION_REFUSED',
      'ERR_CONNECTION_RESET',
      'ERR_CONNECTION_CLOSED',
      'ERR_CONNECTION_FAILED',
      'ERR_EMPTY_RESPONSE'
    ].includes(code)
  )
    return 'refused'
  if (
    [
      'ERR_CONNECTION_TIMED_OUT',
      'ERR_TIMED_OUT',
      'ERR_ADDRESS_UNREACHABLE',
      'ERR_NETWORK_CHANGED'
    ].includes(code)
  )
    return 'timeout'
  return 'unknown'
}

export interface ServerOption {
  id: string
  label: string
  insecure: boolean
}

/**
 * The message for a server that couldn't be reached. Plain language: no addresses (those are in
 * Connection settings for anyone who needs them).
 * @param serverUrl the selected server ("https://host" or "http://192.168.x.x:3001")
 * @param servers all servers built into the app (used to suggest the other option)
 */
export function describeConnectionFailure(
  code: string | null | undefined,
  serverUrl: string,
  servers: ServerOption[]
): string {
  const current = servers.find((s) => s.id === serverUrl)
  const homeOnly = current ? current.insecure : serverUrl.startsWith('http:')
  const internet = servers.find((s) => !s.insecure && s.id !== serverUrl)

  const problem = classifyNetError(code)
  if (problem === 'certificate') {
    return (
      `The server's security certificate could not be verified (${code}), so the app did not ` +
      `connect, to protect your account. Check that this PC's date and time are correct; if they ` +
      `are, tell the server owner.`
    )
  }
  const base: Record<Exclude<NetworkProblem, 'certificate'>, string> = {
    dns: "Can't find the Discord 2.0 server. Check your internet connection.",
    offline: "You're offline. Check your internet connection.",
    refused:
      "The Discord 2.0 server isn't accepting connections right now. It may be restarting; try again in a minute.",
    timeout: "The Discord 2.0 server didn't respond. It may be offline, or this network blocks it.",
    unknown: "Can't reach the Discord 2.0 server."
  }
  let text = base[problem]
  if (homeOnly && problem !== 'offline') {
    text +=
      ` ${current ? `"${current.label}"` : 'This connection'} only works on your home network.` +
      (internet ? ` Away from home, choose "${internet.label}" in Connection settings.` : '')
  }
  return text
}
