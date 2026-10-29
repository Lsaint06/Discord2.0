import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { livekitUrlFor, loadConfig } from '../src/config.js'

// The staging deployment (server/deploy/staging): isolation from production, the configuration the
// server receives there, the synthetic-data tools' address guard and stg.sh's safety guards.
// The full schema check is deploy/staging/validate-compose.mjs; the full rehearsal dry run is
// deploy/staging/test/dry-run-local.mjs (both documented in docs/v1.4.0-staging-plan.md).

const root = join(import.meta.dirname, '..')
const stagingDir = join(root, 'deploy', 'staging')
const stagingText = readFileSync(join(stagingDir, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n')
// Configuration only: the header comment names production's resources on purpose.
const staging = stagingText.replace(/^\s*#.*\n/gm, '')
const production = readFileSync(join(root, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n').replace(/^\s*#.*\n/gm, '')
const SAMPLE: Record<string, string> = {
  STAGING_LAN_IP: '192.168.68.65',
  STAGING_LIVEKIT_API_KEY: 'APIstgSample01',
  STAGING_LIVEKIT_API_SECRET: 'x'.repeat(48)
}

/** `KEY: value` lines of the staging server's environment block, with ${...} filled in. */
function stagingServerEnv(): NodeJS.ProcessEnv {
  const block = /\n {4}environment:\n((?: {6}.*\n| *#.*\n)+)/.exec(staging.slice(staging.indexOf('\n  server:\n')))
  assert.ok(block, 'server environment block')
  const env: NodeJS.ProcessEnv = {}
  for (const line of block[1]!.split('\n')) {
    const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line)
    if (!m) continue
    env[m[1]!] = m[2]!
      .replace(/^"(.*)"$/, '$1')
      .replace(/\$\{([A-Z0-9_]+)(?::[?-][^}]*)?\}/g, (_, name: string) => SAMPLE[name] ?? '')
  }
  return env
}

describe('staging compose file', () => {
  test('own project, volume, image, ports and subnet; nothing shared with production', () => {
    assert.match(staging, /^name: d2staging$/m)
    assert.doesNotMatch(staging, /discord2-data|discord2-server:dev|caddy:/)
    assert.match(staging, /image: \$\{STAGING_SERVER_IMAGE:-discord2-server:1\.4\.0-rc1\}/)
    assert.match(staging, /- staging-data:\/data/)
    assert.match(staging, /- subnet: 172\.30\.99\.0\/24/)
    assert.match(production, /- subnet: 172\.30\.0\.0\/24/)
    for (const port of ['3901', '7980', '7981', '7982']) assert.doesNotMatch(production, new RegExp(`\\b${port}\\b`))
    for (const port of ['"80:80', '"443:443', ':${PORT:-3001}:', 'port: 7880', 'tcp_port: 7881', 'udp_port: 7882']) {
      assert.ok(production.includes(port), `production uses ${port}`)
      assert.ok(!staging.includes(port), `staging must not use ${port}`)
    }
    assert.equal(staging.match(/pull_policy: never/g)?.length, 2)
    assert.equal(staging.match(/restart: "no"/g)?.length, 2)
  })

  test('the backend is reachable on the LAN address only, and LiveKit offers only LAN candidates', () => {
    assert.match(staging, /- "\$\{STAGING_LAN_IP:\?[^}]*\}:3901:3001"/)
    assert.doesNotMatch(staging, /0\.0\.0\.0/)
    assert.match(staging, /use_external_ip: false/)
    assert.match(staging, /node_ip: \$\{STAGING_LAN_IP\}/)
    assert.match(staging, /- \$\{STAGING_LAN_IP\}\/32/)
    assert.match(staging, /- http:\/\/\$\{STAGING_LAN_IP\}:3901\/api\/livekit\/webhook/)
  })
})

describe('staging server configuration', () => {
  test('the server accepts the staging environment: production mode, voice on the LAN address', () => {
    const config = loadConfig(stagingServerEnv())
    assert.equal(config.env, 'production')
    assert.equal(config.devAuth, false)
    assert.equal(config.trustProxy, false)
    assert.equal(config.registration.mode, 'invite')
    assert.equal(config.mail.transport, 'none')
    assert.ok(config.livekit)
    assert.equal(config.livekit.apiUrl, 'http://host.docker.internal:7980')
    // Both PCs reach the backend at 192.168.68.65:3901 and get the staging LiveKit, unencrypted
    // ws:// being allowed only because the address is private.
    assert.equal(livekitUrlFor(config.livekit, '192.168.68.65'), 'ws://192.168.68.65:7980')
  })

  test('a public LiveKit address with plain ws:// would be refused (staging must stay on the LAN)', () => {
    assert.throws(() => loadConfig({ ...stagingServerEnv(), LIVEKIT_PUBLIC_URL: 'ws://203.0.113.7:7980' }), /wss:/)
  })
})

describe('synthetic-data tools', () => {
  const guard = (base: string, env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { assertAllowedBase } from ${JSON.stringify('file:///' + join(stagingDir, 'tools', 'lib.mjs').replace(/\\/g, '/'))}; assertAllowedBase(process.argv[1])`, base],
      { env: { ...process.env, D2_STAGING_TOOLS: '', ...env }, encoding: 'utf8' }
    ).status

  test('only talk to the staging service inside its network, or a local test server', () => {
    assert.equal(guard('http://server:3001', { D2_STAGING_TOOLS: '1' }), 0)
    assert.equal(guard('http://127.0.0.1:3451'), 0)
    for (const refused of [
      'https://landhoev3.duckdns.org',
      'http://192.168.68.65:3001',
      'http://192.168.68.65:3901',
      'http://127.0.0.1:3001',
      'http://server:3001'
    ]) {
      assert.notEqual(guard(refused), 0, refused)
    }
  })

  test('no real-data hints: generated media only, no production addresses', () => {
    for (const file of ['seed-api4.mjs', 'seed-api6.mjs', 'writes.mjs', 'snapshot.mjs', 'bench-animated.mjs', 'lib.mjs']) {
      const text = readFileSync(join(stagingDir, 'tools', file), 'utf8')
      assert.doesNotMatch(text, /landhoev3|readFileSync\([^)]*\.(png|jpe?g|gif|wav)/i, file)
    }
  })
})

describe('stg.sh guards', () => {
  const bash = [process.env.BASH_FOR_TESTS, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find(
    (p) => p && existsSync(p)
  )
  test('teardown, restore, image and layout guards (fake docker)', { skip: bash ? false : 'bash not found' }, () => {
    const out = execFileSync(bash!, [join(stagingDir, 'test', 'stg-guards.sh').replace(/\\/g, '/')], { encoding: 'utf8' })
    assert.match(out, /stg\.sh guard tests: \d+ passed, 0 failed/)
  })
})
