import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

// Static checks of the deployment files (docker-compose.yml, deploy/Caddyfile). They guard
// invariants that only show up on the Jetson otherwise. The authoritative check is still
// `docker compose config` in both modes (see docs/milestone-11-project-connect.md).

const root = join(import.meta.dirname, '..')
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n')
const caddyfile = readFileSync(join(root, 'deploy', 'Caddyfile'), 'utf8').replace(/\r\n/g, '\n')

/** Top-level services as name -> block text (two-space indented keys under `services:`). */
function services(): Map<string, string> {
  const lines = compose.split('\n')
  const start = lines.indexOf('services:')
  assert.ok(start >= 0, 'services: section')
  const blocks = new Map<string, string>()
  let name: string | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const key = /^ {2}([a-z0-9_-]+):\s*$/.exec(line)
    if (key) {
      if (name) blocks.set(name, body.join('\n'))
      name = key[1]!
      body = []
    } else if (name) {
      body.push(line)
    }
  }
  if (name) blocks.set(name, body.join('\n'))
  return blocks
}

const svc = services()

function service(name: string): string {
  const block = svc.get(name)
  assert.ok(block, `service ${name}`)
  return block
}

describe('docker-compose.yml', () => {
  test('has the expected services', () => {
    assert.deepEqual([...svc.keys()].sort(), ['caddy', 'livekit', 'server'])
  })

  test('profile-only services require no variables (Compose interpolates them even when off)', () => {
    const profiled = [...svc].filter(([, body]) => /^\s{4}profiles:/m.test(body))
    assert.ok(profiled.length > 0)
    for (const [name, body] of profiled) {
      const comments = /^\s*#.*$/gm
      assert.doesNotMatch(body.replace(comments, ''), /\$\{[A-Z0-9_]+:?\?/, `${name} uses a required variable`)
    }
  })

  test('the backend trusts forwarded addresses only from the Caddy container', () => {
    const trust = /TRUST_PROXY: \$\{TRUST_PROXY:-([^}]+)\}/.exec(service('server'))?.[1]
    const caddyIp = /ipv4_address: (\S+)/.exec(service('caddy'))?.[1]
    const serverIp = /ipv4_address: (\S+)/.exec(service('server'))?.[1]
    const subnet = /- subnet: (\d+\.\d+\.\d+)\.0\/24/.exec(compose)?.[1]
    assert.ok(trust && caddyIp && serverIp && subnet)
    assert.equal(trust, caddyIp)
    assert.ok(caddyIp.startsWith(`${subnet}.`) && serverIp.startsWith(`${subnet}.`))
    assert.notEqual(caddyIp, serverIp)
  })

  test('development authentication is off unless explicitly enabled', () => {
    assert.match(service('server'), /DEV_AUTH: \$\{DEV_AUTH:-false\}/)
  })

  test('only Caddy publishes public ports; the backend stays on BIND_ADDRESS', () => {
    assert.match(service('server'), /- "\$\{BIND_ADDRESS:-127\.0\.0\.1\}:\$\{PORT:-3001\}:3001"/)
    assert.doesNotMatch(service('livekit'), /^\s{4}ports:/m)
    assert.match(service('caddy'), /- "443:443\/tcp"/)
  })

  test('host-network LiveKit and the internet-facing proxy drop all capabilities', () => {
    assert.match(service('livekit'), /network_mode: host/)
    assert.match(service('livekit'), /cap_drop: \[ALL\]/)
    assert.match(service('caddy'), /cap_drop: \[ALL\]/)
    for (const name of svc.keys()) assert.match(service(name), /no-new-privileges:true/, name)
  })

  test('containers reach LiveKit through the Docker host', () => {
    assert.match(service('server'), /LIVEKIT_URL: http:\/\/host\.docker\.internal:7880/)
    for (const name of ['server', 'caddy']) {
      assert.match(service(name), /"host\.docker\.internal:host-gateway"/, name)
    }
  })

  test('the data volume keeps its name (the existing database lives in it)', () => {
    assert.match(service('server'), /- discord2-data:\/data/)
    assert.match(compose, /^volumes:\n {2}discord2-data:/m)
  })
})

describe('deploy/Caddyfile', () => {
  test('serves only the configured hostname, without HTTP/3 (UDP 443 is not forwarded)', () => {
    assert.match(caddyfile, /^\{\$PUBLIC_HOSTNAME\} \{$/m)
    assert.match(caddyfile, /protocols h1 h2$/m)
    assert.match(caddyfile, /admin localhost:2019/)
  })

  test('routes LiveKit signaling and blocks the internal webhook', () => {
    assert.match(caddyfile, /@livekit path \/rtc \/rtc\/\*/)
    assert.match(caddyfile, /reverse_proxy host\.docker\.internal:7880/)
    assert.match(caddyfile, /@internal path \/api\/livekit\/webhook\*/)
    const block = caddyfile.indexOf('handle @internal')
    assert.ok(block > 0 && block < caddyfile.indexOf('handle @livekit'))
    assert.match(caddyfile.slice(block, block + 60), /respond 404/)
  })

  test('does not trust client-supplied forwarding headers or log tokens', () => {
    const directives = caddyfile.replace(/^\s*#.*$/gm, '')
    assert.doesNotMatch(directives, /trusted_proxies/)
    assert.doesNotMatch(directives, /^\s*log\b/m)
  })
})
