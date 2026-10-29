// Static validation of the staging Compose file. No Docker Engine is needed (there is none on the
// development PC). Three parts:
//  1. Compose variable interpolation with sample values; missing .env.staging values must refuse.
//  2. The official compose-spec JSON schema, pinned to a commit and checked by SHA-256.
//  3. Isolation from production and two-PC LAN rules, checked against the REAL ../../docker-compose.yml.
//
// Download the schema once (it isn't stored in this repository):
//   curl -L -o compose-spec.json https://raw.githubusercontent.com/compose-spec/compose-spec/3a4a6995e4a971f6173dff9130cb3e38e6738651/schema/compose-spec.json
// Then, from server/ (uses js-yaml and ajv from desktop/node_modules):
//   node deploy/staging/validate-compose.mjs <path to compose-spec.json>
// The authoritative check on the Jetson is `./stg.sh config` (docker compose config).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const SCHEMA_SHA256 = 'd549057ebc2925f39f62799eab0db7b9e2c18b35b6c00595199116da3ed10e64'
const here = import.meta.dirname
const serverDir = join(here, '..', '..')
const req = createRequire(join(serverDir, '..', 'desktop', 'package.json'))
const yaml = req('js-yaml')
const Ajv2020 = req('ajv/dist/2020').default

const schemaPath = process.argv[2]
if (!schemaPath) throw new Error('usage: node validate-compose.mjs <compose-spec.json>')
const schemaText = readFileSync(schemaPath)
const schemaHash = createHash('sha256').update(schemaText).digest('hex')
if (schemaHash !== SCHEMA_SHA256) throw new Error(`compose-spec.json is not the pinned schema (sha256 ${schemaHash})`)

const SAMPLE = { STAGING_LAN_IP: '192.168.68.65', STAGING_LIVEKIT_API_KEY: 'APIstgSample01', STAGING_LIVEKIT_API_SECRET: 'x'.repeat(48) }
const PROD_SAMPLE = {
  LIVEKIT_API_KEY: 'prodKey',
  LIVEKIT_API_SECRET: 'p'.repeat(40),
  LIVEKIT_PUBLIC_URL: 'wss://landhoev3.duckdns.org',
  BIND_ADDRESS: '192.168.68.65',
  PUBLIC_HOSTNAME: 'landhoev3.duckdns.org'
}
const LAN = '192.168.68.0/22'

const interpolate = (text, env) =>
  text.replace(/\$\$|\$\{([A-Z0-9_]+)(?::?([-?])([^}]*))?\}/g, (m, name, op, arg) => {
    if (m === '$$') return '$'
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (op === '?') throw new Error(`required variable ${name}: ${arg}`)
    if (op === '-') return arg
    return ''
  })
const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
const cidr = (c) => {
  const [ip, bits] = c.split('/')
  const size = 2 ** (32 - Number(bits))
  const start = Math.floor(ipToInt(ip) / size) * size
  return [start, start + size - 1]
}
const overlaps = (a, b) => {
  const [a1, a2] = cidr(a)
  const [b1, b2] = cidr(b)
  return a1 <= b2 && b1 <= a2
}

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

const stagingRaw = readFileSync(join(here, 'docker-compose.yml'), 'utf8')
const staging = yaml.load(interpolate(stagingRaw, SAMPLE))
let refused = false
try {
  interpolate(stagingRaw, {})
} catch {
  refused = true
}
check('refuses to start without .env.staging values', refused)

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
const validate = ajv.compile(JSON.parse(schemaText))
check('staging file valid against the compose-spec schema', validate(staging), JSON.stringify(validate.errors || []).slice(0, 400))
const prod = yaml.load(interpolate(readFileSync(join(serverDir, 'docker-compose.yml'), 'utf8'), PROD_SAMPLE))
check('production file valid against the same schema (sanity)', validate(prod), JSON.stringify(validate.errors || []).slice(0, 200))

const lk = (doc) => yaml.load(doc.services.livekit.environment.LIVEKIT_CONFIG)
const sLk = lk(staging)
const pLk = lk(prod)
const hostPorts = (doc) => Object.values(doc.services).flatMap((s) => (s.ports || []).map((p) => Number(String(p).split(':').slice(-2)[0].split('/')[0])))
const lkPorts = (c) => [c.port, c.rtc.tcp_port, c.rtc.udp_port]
const prodPorts = [...hostPorts(prod), ...lkPorts(pLk)]
const stagingPorts = [...hostPorts(staging), ...lkPorts(sLk)]
const env = staging.services.server.environment
const port = (u) => Number(new URL(u).port)
const subnet = staging.networks?.default?.ipam?.config?.[0]?.subnet
const prodSubnet = prod.networks?.default?.ipam?.config?.[0]?.subnet

// Isolation from production
check('own Compose project name', staging.name === 'd2staging')
check('no host port shared with production', stagingPorts.every((p) => !prodPorts.includes(p)), `staging ${stagingPorts} / production ${prodPorts}`)
check("production's volume not used", !('discord2-data' in (staging.volumes || {})) && Object.values(staging.services).every((s) => (s.volumes || []).every((v) => !String(v).startsWith('discord2-data'))))
check('own data volume (database and attachments together)', staging.services.server.volumes.join() === 'staging-data:/data' && 'staging-data' in staging.volumes)
check('no bind mounts at all', Object.values(staging.services).every((s) => (s.volumes || []).every((v) => !/^[./~]/.test(String(v)))))
check('network subnet pinned and distinct from production', subnet === '172.30.99.0/24' && prodSubnet === '172.30.0.0/24' && !overlaps(subnet, prodSubnet))
check('network subnet does not overlap the home LAN', !overlaps(subnet, LAN))
check('no fixed container addresses', Object.values(staging.services).every((s) => !s.networks))
check('server image defaults to the release image, never :dev', staging.services.server.image === 'discord2-server:1.4.0-rc1')
const rollback = yaml.load(interpolate(stagingRaw, { ...SAMPLE, STAGING_SERVER_IMAGE: 'discord2-server:m11-rollback' }))
check('rollback rehearsal swaps only the server image', rollback.services.server.image === 'discord2-server:m11-rollback' && JSON.stringify({ ...rollback.services.server, image: '' }) === JSON.stringify({ ...staging.services.server, image: '' }))
check('LiveKit image identical to production (already on the Jetson)', staging.services.livekit.image === prod.services.livekit.image)
check('no build and never pulls', Object.values(staging.services).every((s) => !s.build && s.pull_policy === 'never'))
check('does not restart by itself', Object.values(staging.services).every((s) => s.restart === 'no'))
check('resource limits set', Object.values(staging.services).every((s) => s.mem_limit && s.cpus))
check('staging LiveKit keys are the staging variables', Object.keys(sLk.keys)[0] === SAMPLE.STAGING_LIVEKIT_API_KEY && sLk.webhook.api_key === SAMPLE.STAGING_LIVEKIT_API_KEY && env.LIVEKIT_API_KEY === SAMPLE.STAGING_LIVEKIT_API_KEY)

// Never public
check('no Caddy, no 80/443', !staging.services.caddy && !stagingPorts.some((p) => p === 80 || p === 443))
check('backend port bound to the LAN address only', staging.services.server.ports.every((p) => String(p).startsWith(`${SAMPLE.STAGING_LAN_IP}:`)))
check('LiveKit: no STUN / public address; LAN candidates only', sLk.rtc.use_external_ip === false && sLk.rtc.node_ip === SAMPLE.STAGING_LAN_IP && sLk.rtc.ips.includes.join() === `${SAMPLE.STAGING_LAN_IP}/32`)
check('Milestone 13 features at release defaults, DEV_AUTH off', env.NODE_ENV === 'production' && env.DEV_AUTH === 'false' && env.REGISTRATION_MODE === 'invite' && env.MAIL_TRANSPORT === 'none' && env.GIF_PROVIDER === 'none' && env.UPLOAD_LARGE_FILES === 'false')

// Two PCs on the LAN
check('clients signal to LiveKit on the Jetson LAN address, staging port', env.LIVEKIT_PUBLIC_URL === `ws://${SAMPLE.STAGING_LAN_IP}:${sLk.port}`)
check('backend reaches the staging LiveKit API (not production 7880)', port(env.LIVEKIT_URL) === sLk.port && sLk.port !== pLk.port)
check('LiveKit webhooks go to the staging backend on the LAN address', sLk.webhook.urls.every((u) => u === `http://${SAMPLE.STAGING_LAN_IP}:3901/api/livekit/webhook`))
check('ICE: TCP 7981 and one UDP port 7982', sLk.rtc.tcp_port === 7981 && sLk.rtc.udp_port === 7982)
check('LiveKit healthcheck probes the staging port', staging.services.livekit.healthcheck.test.join(' ').includes(`:${sLk.port}/`))
check('host networking for LiveKit, as production', staging.services.livekit.network_mode === 'host')
check('codec list identical to production', JSON.stringify(sLk.room.enabled_codecs) === JSON.stringify(pLk.room.enabled_codecs))

const failed = checks.filter((c) => !c.ok)
console.log(`schema: compose-spec@3a4a699 sha256 ${schemaHash}`)
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  -> ' + c.detail}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exitCode = failed.length ? 1 : 0
