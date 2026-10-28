import { isIP } from 'node:net'

/**
 * True for hosts that can only be reached on a private network: loopback, RFC 1918, the
 * 100.64.0.0/10 shared range (carrier-grade NAT, Tailscale), link-local, IPv6 unique-local,
 * and LAN-only names (localhost, *.local, *.home.arpa, single-label names like "jetson").
 * Plain http:// and ws:// are acceptable only for such hosts.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return false
  const family = isIP(h)
  if (family === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number]
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (family === 6) {
    if (h === '::1') return true
    const first = parseInt(h.split(':')[0] || '0', 16)
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.home.arpa')) return true
  // A name without a dot can't be resolved by public DNS.
  return !h.includes('.')
}

/** Hostname from a Host header value ("example.org:443", "[::1]:3001"); null if malformed. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}
