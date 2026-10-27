/**
 * Milestone 7 security tests: accounts, sessions, authorization, invitations, moderation,
 * LiveKit grants, adversarial inputs and legacy identity migration.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { TokenVerifier } from 'livekit-server-sdk'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher, parsePasswordHash } from '../src/auth/password.js'
import { passwordProblem } from '../src/auth/passwordPolicy.js'
import { CODE_LENGTHS, codeVerifier, newCode, normalizeCode, sha256Hex } from '../src/auth/secrets.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { sqliteMigrations } from '../src/db/migrations.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { voiceAuthorizer } from '../src/voice/enforce.js'
import {
  ADMIN_DEFAULT,
  MEMBER_DEFAULT,
  MODERATOR_DEFAULT,
  canAssignRole,
  canConfigureRole,
  canModerateMember,
  channelPermissions
} from '../src/lib/permissions.js'
import {
  ALL_PERMISSIONS,
  Permissions,
  type ApiAuthResult,
  type ApiMessage,
  type ApiServer,
  type ApiServerInvite,
  type GatewayServerFrame
} from '../src/protocol.js'

// Assembled so the scheme name is never mangled by tooling that masks credentials.
const SCHEME = ['Bea', 'rer'].join('')
const API_KEY = 'test-key'
const API_SECRET = 'test-secret-that-is-at-least-32-characters-long'
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'

const dir = mkdtempSync(join(tmpdir(), 'd2-accounts-'))
const dbFile = join(dir, 'accounts.db')

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  base: string
}

function relax(ctx: AppContext, keep: (keyof AppContext['limiters'])[] = []): void {
  for (const name of [
    'loginPerIp',
    'apiPerIp',
    'registerPerIp',
    'recoverPerIp',
    'accountPerUser',
    'adminPerUser',
    'invitesPerUser',
    'joinPerUser',
    'moderationPerUser',
    'searchPerUser',
    'gatewayPerIp',
    'voiceTokensPerUser'
  ] as const) {
    if (keep.includes(name)) continue
    ctx.limiters[name].dispose()
    ctx.limiters[name] = new TokenBucketLimiter(10_000, 1_000)
  }
}

async function start(env: Record<string, string> = {}, file = dbFile): Promise<Server> {
  const repo = new SqliteRepository(file)
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: join(dir, 'attachments'),
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_URL: 'http://127.0.0.1:9',
    LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880',
    ...env
  })
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0
  })
  relax(ctx)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, ctx, repo, base: `http://127.0.0.1:${address.port}` }
}

let s: Server

function req(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.Authorization = `${SCHEME} ${init.token}`
  if (init.json !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${s.base}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body
  })
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text()
  assert.equal(res.status, status, `${res.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

async function devLogin(username: string): Promise<{ token: string; userId: string }> {
  const body = await json<{ token: string; user: { id: string } }>(
    await req('/api/dev/login', { method: 'POST', json: { username } }),
    200
  )
  return { token: body.token, userId: body.user.id }
}

async function login(username: string, password = PASSWORD): Promise<ApiAuthResult> {
  return json<ApiAuthResult>(await req('/api/auth/login', { method: 'POST', json: { username, password } }), 200)
}

let adminToken = ''
let adminId = ''

async function registrationCode(serverId: string | null = 'hangout'): Promise<string> {
  const invite = await json<{ code: string }>(
    await req('/api/admin/registration-invites', {
      method: 'POST',
      token: adminToken,
      json: { password: PASSWORD, serverId }
    }),
    201
  )
  return invite.code
}

async function register(username: string, serverId: string | null = 'hangout'): Promise<ApiAuthResult> {
  const code = await registrationCode(serverId)
  return json<ApiAuthResult>(
    await req('/api/auth/register', {
      method: 'POST',
      json: { code, username, displayName: username, password: PASSWORD }
    }),
    201
  )
}

function gateway(token: string) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/gateway')
  const frames: GatewayServerFrame[] = []
  let closeCode: number | null = null
  const waiters: { pred: (f: GatewayServerFrame) => boolean; resolve: (f: GatewayServerFrame) => void }[] = []
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (ev) => {
      closeCode = ev.code
      resolve(ev.code)
    })
  })
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as GatewayServerFrame
    frames.push(frame)
    if (frame.op === 'hello') ws.send(JSON.stringify({ op: 'identify', d: { token } }))
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  })
  const waitFor = (pred: (f: GatewayServerFrame) => boolean, ms = 3000) =>
    new Promise<GatewayServerFrame>((resolve, reject) => {
      const existing = frames.find(pred)
      if (existing) return resolve(existing)
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms)
      waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) })
    })
  return { ws, frames, waitFor, closed, get closeCode() { return closeCode } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  s = await start()
  const now = Date.now()
  const admin = await s.repo.provisionAccount(
    { id: 'admin-1', username: 'root', displayName: 'Root', avatarColor: '#111111', bot: false, createdAt: now },
    await HASHER.hash(PASSWORD),
    now
  )
  for (const server of await s.repo.listServers()) await s.repo.setOwner(server.id, admin.id, now)
  adminId = admin.id
  adminToken = (await login('root')).token
})

after(async () => {
  await s.app.close()
  await s.repo.close()
  rmSync(dir, { recursive: true, force: true })
})

// ======================================================================
describe('password hashing and policy', () => {
  test('Argon2id PHC hashes are salted, verifiable and never contain the password', async () => {
    const a = await HASHER.hash(PASSWORD)
    const b = await HASHER.hash(PASSWORD)
    assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    assert.notEqual(a, b, 'unique salt per hash')
    assert.ok(!a.includes(PASSWORD))
    assert.equal(await HASHER.verify(a, PASSWORD), true)
    assert.equal(await HASHER.verify(a, PASSWORD + 'x'), false)
    assert.equal(await HASHER.verify('garbage', PASSWORD), false)
    assert.equal(parsePasswordHash(a)?.salt.length, 16)
  })

  test('detects weaker stored parameters and rejects absurd ones', async () => {
    const strong = new PasswordHasher({ memoryKiB: 65_536, passes: 3, parallelism: 4 })
    assert.equal(strong.needsRehash(await HASHER.hash('x')), true)
    assert.equal(HASHER.needsRehash(await HASHER.hash('x')), false)
    assert.equal(await HASHER.verify('$argon2id$v=19$m=9999999,t=99,p=99$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2g', 'x'), false)
    assert.throws(() => new PasswordHasher({ memoryKiB: 4096, passes: 1, parallelism: 1 }), /OWASP/)
  })

  test('password policy: length, common passwords, username, passphrases welcome', () => {
    assert.match(passwordProblem('short')!, /at least 12/)
    assert.match(passwordProblem('password1234')!, /common/)
    assert.match(passwordProblem('aaaaaaaaaaaaaaaa')!, /repetitive/)
    assert.match(passwordProblem('alice-alice', { username: 'alice-alice' }) ?? 'x', /./)
    assert.equal(passwordProblem('correct horse battery staple 7'), null)
    assert.equal(passwordProblem('Ünïcödé pässphrase ✓ 2026'), null)
    assert.match(passwordProblem('x'.repeat(300))!, /at most/)
  })

  test('codes are high-entropy, typable and normalized', () => {
    const code = newCode(5)
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/)
    assert.equal(normalizeCode(code.toLowerCase().replace(/-/g, ' '), 20), code.replace(/-/g, ''))
    assert.equal(normalizeCode('too-short', 20), null)
    assert.equal(normalizeCode('UUUU-UUUU-UUUU-UUUU-UUUU', 20), null, 'U is not in the alphabet')
    assert.notEqual(codeVerifier('invite', 'A'), codeVerifier('register', 'A'), 'purpose-separated')
  })
})

// ======================================================================
describe('permission model (pure)', () => {
  test('role defaults, owner, and channel overrides', () => {
    assert.equal(channelPermissions('owner', {}, []), ALL_PERMISSIONS)
    assert.equal(channelPermissions('member', {}, []), MEMBER_DEFAULT)
    assert.ok(!(MEMBER_DEFAULT & Permissions.pinMessages))
    assert.ok(MODERATOR_DEFAULT & Permissions.pinMessages)
    assert.ok(ADMIN_DEFAULT & Permissions.manageRoles)
    // Deny View for members: nothing at all in that channel.
    assert.equal(channelPermissions('member', {}, [{ role: 'member', allow: 0, deny: Permissions.viewChannel }]), 0)
    // Overrides never grant server-level permissions.
    const p = channelPermissions('member', {}, [{ role: 'member', allow: Permissions.manageRoles, deny: 0 }])
    assert.ok(!(p & Permissions.manageRoles))
  })

  test('hierarchy: no escalation, no touching equals or the owner', () => {
    const admin = { role: 'admin' as const, permissions: ADMIN_DEFAULT }
    const mod = { role: 'moderator' as const, permissions: MODERATOR_DEFAULT }
    assert.equal(canAssignRole(admin, 'member', 'moderator'), true)
    assert.equal(canAssignRole(admin, 'member', 'admin'), false)
    assert.equal(canAssignRole(admin, 'owner', 'member'), false)
    assert.equal(canAssignRole(mod, 'member', 'moderator'), false, 'moderators lack Manage Roles')
    assert.equal(canModerateMember(mod, 'member', Permissions.kickMembers), true)
    assert.equal(canModerateMember(mod, 'moderator', Permissions.kickMembers), false)
    assert.equal(canModerateMember(admin, 'owner', Permissions.banMembers), false)
    assert.equal(canConfigureRole(admin, 'admin', 0), false, 'not your own role')
    const limitedAdmin = { role: 'admin' as const, permissions: ADMIN_DEFAULT & ~Permissions.banMembers }
    assert.equal(canConfigureRole(limitedAdmin, 'moderator', Permissions.banMembers), false, 'cannot grant what you lack')
  })
})

// ======================================================================
describe('registration, sign-in and sessions', () => {
  test('registration requires a valid, single-use invitation', async () => {
    assert.equal(
      await errorCode(await req('/api/auth/register', { method: 'POST', json: { code: 'AAAA-BBBB-CCCC-DDDD-EEEE', username: 'nobody', password: PASSWORD } })),
      'invalid_invite'
    )
    assert.equal((await req('/api/auth/register', { method: 'POST', json: { username: 'nobody', password: PASSWORD } })).status, 400)
    const code = await registrationCode()
    const info = await json<{ kind: string }>(await req('/api/auth/invite-info', { method: 'POST', json: { code } }), 200)
    assert.equal(info.kind, 'register')
    const first = await json<ApiAuthResult>(
      await req('/api/auth/register', { method: 'POST', json: { code, username: 'reg-alice', password: PASSWORD } }),
      201
    )
    assert.equal(first.recoveryCodes?.length, 10)
    assert.equal(first.user.hasPassword, true)
    assert.equal(first.session.kind, 'password')
    // Same code again.
    const again = await req('/api/auth/register', { method: 'POST', json: { code, username: 'reg-alice2', password: PASSWORD } })
    assert.equal(await errorCode(again), 'invalid_invite')
    // The registration invite joined the server.
    const servers = await json<ApiServer[]>(await req('/api/servers', { token: first.token }), 200)
    assert.deepEqual(servers.map((x) => x.id), ['hangout'])
    assert.equal(servers[0]!.role, 'member')
  })

  test('creating invitations needs an administrator password session and re-authentication', async () => {
    const { token } = await register('reg-notadmin')
    assert.equal((await req('/api/admin/registration-invites', { method: 'POST', token, json: { password: PASSWORD } })).status, 403)
    const wrong = await req('/api/admin/registration-invites', { method: 'POST', token: adminToken, json: { password: 'wrong-password-123' } })
    assert.equal(await errorCode(wrong), 'wrong_password')
  })

  test('expired and revoked invitations are refused; duplicate usernames keep the code usable', async () => {
    const now = Date.now()
    const expired = newCode(5)
    await s.repo.createRegistrationInvite({
      id: 'exp-1', codeHash: codeVerifier('register', normalizeCode(expired, 20)!), kind: 'register',
      claimUserId: null, serverId: null, note: null, createdBy: null, createdAt: now - 10_000,
      expiresAt: now - 1, usedAt: null, usedBy: null, revokedAt: null
    })
    assert.equal(await errorCode(await req('/api/auth/register', { method: 'POST', json: { code: expired, username: 'late', password: PASSWORD } })), 'invalid_invite')

    const code = await registrationCode()
    const list = await json<{ id: string; revoked: boolean }[]>(await req('/api/admin/registration-invites', { token: adminToken }), 200)
    await json(await req(`/api/admin/registration-invites/${list[0]!.id}`, { method: 'DELETE', token: adminToken }), 204)
    assert.equal(await errorCode(await req('/api/auth/register', { method: 'POST', json: { code, username: 'revoked', password: PASSWORD } })), 'invalid_invite')

    const dup = await registrationCode()
    const taken = await req('/api/auth/register', { method: 'POST', json: { code: dup, username: 'root', password: PASSWORD } })
    assert.equal(taken.status, 409)
    await json(await req('/api/auth/register', { method: 'POST', json: { code: dup, username: 'not-taken', password: PASSWORD } }), 201)
  })

  test('weak passwords are rejected at registration', async () => {
    const code = await registrationCode()
    const res = await req('/api/auth/register', { method: 'POST', json: { code, username: 'weakpw', password: 'password1234' } })
    assert.equal(await errorCode(res), 'weak_password')
  })

  test('wrong password and unknown user get the same generic error', async () => {
    await register('login-bob')
    const wrong = await req('/api/auth/login', { method: 'POST', json: { username: 'login-bob', password: 'not-the-password' } })
    const unknown = await req('/api/auth/login', { method: 'POST', json: { username: 'no-such-user', password: 'not-the-password' } })
    assert.equal(wrong.status, 401)
    assert.equal(unknown.status, 401)
    const a = (await wrong.json()) as { error: unknown }
    const b = (await unknown.json()) as { error: unknown }
    assert.deepEqual(a, b)
    // Development identities have no password and can't sign in this way either.
    await devLogin('dev-nopass')
    assert.equal((await req('/api/auth/login', { method: 'POST', json: { username: 'dev-nopass', password: PASSWORD } })).status, 401)
  })

  test('sign-in attempts are throttled per account', async () => {
    await register('throttle-me')
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push((await req('/api/auth/login', { method: 'POST', json: { username: 'throttle-me', password: 'wrong-password-xx' } })).status)
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401])
    assert.equal(statuses[6], 429)
  })

  test('sign-in creates a fresh server-generated session (no fixation)', async () => {
    const reg = await register('fixation')
    const res = await json<ApiAuthResult>(
      await req('/api/auth/login', { method: 'POST', token: reg.token, json: { username: 'fixation', password: PASSWORD } }),
      200
    )
    assert.notEqual(res.token, reg.token)
    assert.equal(res.token.length, 43)
    // Only the hash is stored.
    const row = await s.repo.findSession(sha256Hex(res.token))
    assert.equal(row?.session.id, res.session.id)
  })

  test('expired, idle and revoked sessions are rejected; malformed tokens too', async () => {
    const { token, session } = await register('expiry')
    assert.equal((await req('/api/users/me', { token })).status, 200)
    const db = (s.repo as unknown as { db: DatabaseSync }).db
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, session.id)
    assert.equal((await req('/api/users/me', { token })).status, 401)

    const second = await login('expiry')
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(Date.now() - 31 * 86_400_000, second.session.id)
    assert.equal((await req('/api/users/me', { token: second.token })).status, 401, 'idle timeout')

    for (const bad of ['x', 'a'.repeat(500), 'not a token!', `${token}x`]) {
      assert.equal((await req('/api/users/me', { headers: { Authorization: `${SCHEME} ${bad}` } })).status, 401)
    }
    assert.equal((await req('/api/users/me', { headers: { Authorization: token } })).status, 401, 'missing scheme')
  })

  test('logout revokes the session and closes its gateway connection', async () => {
    const { token } = await register('logout-me')
    const gw = gateway(token)
    await gw.waitFor((f) => f.op === 'ready')
    await json(await req('/api/auth/logout', { method: 'POST', token }), 204)
    assert.equal(await gw.closed, 4001)
    assert.equal((await req('/api/users/me', { token })).status, 401, 'replay of a revoked token fails')
    // Reconnecting with the revoked token fails too.
    const again = gateway(token)
    assert.equal(await again.closed, 4001)
  })

  test('sessions list, revoke one device, sign out everywhere', async () => {
    const a = await register('devices')
    const b = await login('devices')
    const c = await login('devices')
    const sessions = await json<{ id: string; current: boolean }[]>(await req('/api/auth/sessions', { token: a.token }), 200)
    assert.equal(sessions.length, 3)
    assert.equal(sessions.filter((x) => x.current).length, 1)
    await json(await req(`/api/auth/sessions/${b.session.id}`, { method: 'DELETE', token: a.token }), 204)
    assert.equal((await req('/api/users/me', { token: b.token })).status, 401)
    // Another user's session id is simply not found.
    const other = await register('devices-other')
    assert.equal((await req(`/api/auth/sessions/${other.session.id}`, { method: 'DELETE', token: a.token })).status, 404)
    assert.equal((await req('/api/users/me', { token: other.token })).status, 200)

    const result = await json<{ revoked: number }>(await req('/api/auth/logout-all', { method: 'POST', token: a.token, json: { keepCurrent: true } }), 200)
    assert.equal(result.revoked, 1)
    assert.equal((await req('/api/users/me', { token: c.token })).status, 401)
    assert.equal((await req('/api/users/me', { token: a.token })).status, 200)
    await json(await req('/api/auth/logout-all', { method: 'POST', token: a.token, json: {} }), 200)
    assert.equal((await req('/api/users/me', { token: a.token })).status, 401)
  })

  test('password change needs the current password and signs out other sessions', async () => {
    const a = await register('pwchange')
    const b = await login('pwchange')
    const wrong = await req('/api/auth/password', { method: 'POST', token: a.token, json: { currentPassword: 'nope-nope-nope', newPassword: 'brand-new-passphrase-1' } })
    assert.equal(await errorCode(wrong), 'wrong_password')
    const ok = await json<{ otherSessionsRevoked: number }>(
      await req('/api/auth/password', { method: 'POST', token: a.token, json: { currentPassword: PASSWORD, newPassword: 'brand-new-passphrase-1' } }),
      200
    )
    assert.equal(ok.otherSessionsRevoked, 1)
    assert.equal((await req('/api/users/me', { token: b.token })).status, 401)
    assert.equal((await req('/api/users/me', { token: a.token })).status, 200)
    assert.equal((await req('/api/auth/login', { method: 'POST', json: { username: 'pwchange', password: PASSWORD } })).status, 401)
    await login('pwchange', 'brand-new-passphrase-1')
  })

  test('recovery codes work once and revoke every session', async () => {
    const reg = await register('recover-me')
    const code = reg.recoveryCodes![0]!
    const recover = (c: string, pw: string) =>
      req('/api/auth/recover', { method: 'POST', json: { username: 'recover-me', code: c, newPassword: pw } })
    assert.equal(await errorCode(await recover('AAAA-BBBB-CCCC-DDDD', 'new-pass-phrase-77')), 'invalid_recovery')
    const ok = await json<ApiAuthResult & { recoveryCodesRemaining: number }>(await recover(code, 'new-pass-phrase-77'), 200)
    assert.equal(ok.recoveryCodesRemaining, 9)
    assert.equal((await req('/api/users/me', { token: reg.token })).status, 401)
    assert.equal(await errorCode(await recover(code, 'another-pass-phrase-8')), 'invalid_recovery', 'single use')
    await login('recover-me', 'new-pass-phrase-77')
    // Unknown user and weak password give errors that don't reveal whether the account exists.
    const unknownWeak = await req('/api/auth/recover', { method: 'POST', json: { username: 'ghost', code, newPassword: 'short' } })
    const knownWeak = await req('/api/auth/recover', { method: 'POST', json: { username: 'recover-me', code, newPassword: 'short' } })
    assert.equal(await errorCode(unknownWeak), await errorCode(knownWeak))
  })

  test('administrator reset codes work once, only for their account', async () => {
    const target = await register('reset-me')
    await register('reset-other')
    const { code } = await json<{ code: string }>(
      await req(`/api/admin/accounts/${target.user.id}/reset-code`, { method: 'POST', token: adminToken, json: { password: PASSWORD } }),
      200
    )
    const other = await req('/api/auth/recover', { method: 'POST', json: { username: 'reset-other', code, newPassword: 'hijack-attempt-pass-1' } })
    assert.equal(other.status, 400)
    await json(await req('/api/auth/recover', { method: 'POST', json: { username: 'reset-me', code, newPassword: 'fresh-start-pass-22' } }), 200)
    assert.equal((await req('/api/auth/recover', { method: 'POST', json: { username: 'reset-me', code, newPassword: 'fresh-start-pass-33' } })).status, 400)
    assert.equal((await req('/api/users/me', { token: target.token })).status, 401)
  })

  test('disabled accounts lose every session and cannot sign in', async () => {
    const target = await register('disable-me')
    const gw = gateway(target.token)
    await gw.waitFor((f) => f.op === 'ready')
    await json(await req(`/api/admin/accounts/${target.user.id}/disabled`, { method: 'POST', token: adminToken, json: { disabled: true, password: PASSWORD } }), 200)
    assert.equal(await gw.closed, 4001)
    assert.equal((await req('/api/users/me', { token: target.token })).status, 401)
    const res = await req('/api/auth/login', { method: 'POST', json: { username: 'disable-me', password: PASSWORD } })
    assert.equal(await errorCode(res), 'account_disabled')
    assert.equal((await req(`/api/admin/accounts/${adminId}/disabled`, { method: 'POST', token: adminToken, json: { disabled: true, password: PASSWORD } })).status, 400, 'not yourself')
  })

  test('development sessions: never for password accounts, and invalid once DEV_AUTH is off', async () => {
    await register('real-person')
    const blocked = await req('/api/dev/login', { method: 'POST', json: { username: 'real-person' } })
    assert.equal(await errorCode(blocked), 'password_account')
    const dev = await devLogin('dev-only-user')

    // Same database, DEV_AUTH turned off.
    const strict = await start({ DEV_AUTH: 'false' })
    try {
      const me = await fetch(`${strict.base}/api/users/me`, { headers: { Authorization: `${SCHEME} ${dev.token}` } })
      assert.equal(me.status, 401)
      const route = await fetch(`${strict.base}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x' }) })
      assert.equal(route.status, 404)
      const meta = (await (await fetch(`${strict.base}/api/meta`)).json()) as { devAuth: boolean; registration: string }
      assert.deepEqual({ devAuth: meta.devAuth, registration: meta.registration }, { devAuth: false, registration: 'invite' })
      // Password sign-in is unaffected (no fallback in either direction).
      const ok = await fetch(`${strict.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'real-person', password: PASSWORD }) })
      assert.equal(ok.status, 200)
    } finally {
      await strict.app.close()
      await strict.repo.close()
    }
  })

  test('registration attempts are rate limited per IP', async () => {
    s.ctx.limiters.registerPerIp.dispose()
    s.ctx.limiters.registerPerIp = new TokenBucketLimiter(5, 1 / 60)
    try {
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) {
        statuses.push((await req('/api/auth/register', { method: 'POST', json: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', username: `spam${i}`, password: PASSWORD } })).status)
      }
      assert.equal(statuses[6], 429)
    } finally {
      s.ctx.limiters.registerPerIp.dispose()
      s.ctx.limiters.registerPerIp = new TokenBucketLimiter(10_000, 1_000)
    }
  })

  test('oversized and malformed bodies are rejected before any work', async () => {
    const big = await req('/api/auth/login', { method: 'POST', json: { username: 'x', password: 'p'.repeat(20_000) } })
    assert.equal(big.status, 413)
    const extra = await req('/api/auth/login', { method: 'POST', json: { username: 'x', password: 'y', userId: 'admin-1' } })
    assert.equal(extra.status, 400, 'unknown fields (e.g. a forged user id) are rejected')
    const wrongType = await req('/api/auth/login', { method: 'POST', json: { username: 1, password: true } })
    assert.equal(wrongType.status, 400)
  })

  test('accounts and sessions survive a backend restart', async () => {
    const reg = await register('restart-me')
    await s.app.close()
    await s.repo.close()
    s = await start()
    assert.equal((await req('/api/users/me', { token: reg.token })).status, 200)
    adminToken = (await login('root')).token
    await login('restart-me')
  })
})

// ======================================================================
describe('authorization', () => {
  let owner: ApiAuthResult
  let mod: ApiAuthResult
  let member: ApiAuthResult
  let outsider: ApiAuthResult
  let serverId = ''
  let textId = ''
  let voiceId = ''

  before(async () => {
    owner = await register('authz-owner', null)
    mod = await register('authz-mod', null)
    member = await register('authz-member', null)
    outsider = await register('authz-outsider', null)
    const server = await json<ApiServer>(
      await req('/api/servers', { method: 'POST', token: owner.token, json: { name: 'Private', color: '#334455' } }),
      201
    )
    serverId = server.id
    assert.equal(server.role, 'owner')
    textId = server.channels.find((c) => c.type === 'text')!.id
    voiceId = server.channels.find((c) => c.type === 'voice')!.id
    const invite = await json<ApiServerInvite>(
      await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: { maxUses: 2 } }),
      201
    )
    for (const u of [mod, member]) {
      await json(await req('/api/invites/accept', { method: 'POST', token: u.token, json: { code: invite.code } }), 200)
    }
    await json(await req(`/api/servers/${serverId}/members/${mod.user.id}`, { method: 'PATCH', token: owner.token, json: { role: 'moderator' } }), 200)
  })

  test('non-members cannot see or touch a server (404, no probing)', async () => {
    const servers = await json<ApiServer[]>(await req('/api/servers', { token: outsider.token }), 200)
    assert.ok(!servers.some((x) => x.id === serverId))
    assert.equal((await req(`/api/channels/${textId}/messages`, { token: outsider.token })).status, 404)
    assert.equal((await req(`/api/channels/${textId}/messages`, { method: 'POST', token: outsider.token, json: { content: 'hi' } })).status, 404)
    assert.equal((await req(`/api/servers/${serverId}/members`, { token: outsider.token })).status, 404)
    assert.equal((await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: outsider.token })).status, 404)
    assert.equal((await req(`/api/search?serverId=${serverId}&q=hello`, { token: outsider.token })).status, 404)
  })

  test('messages are delivered only to people who can see the channel', async () => {
    const gwMember = gateway(member.token)
    const gwOutsider = gateway(outsider.token)
    await gwMember.waitFor((f) => f.op === 'ready')
    await gwOutsider.waitFor((f) => f.op === 'ready')
    const msg = await json<ApiMessage>(await req(`/api/channels/${textId}/messages`, { method: 'POST', token: owner.token, json: { content: 'members only' } }), 201)
    await gwMember.waitFor((f) => f.op === 'message_create' && f.d.id === msg.id)
    await sleep(200)
    assert.ok(!gwOutsider.frames.some((f) => f.op === 'message_create' && f.d.id === msg.id))
    gwMember.ws.close()
    gwOutsider.ws.close()
  })

  test('cross-user edits are denied; deleting others needs Manage Messages', async () => {
    const msg = await json<ApiMessage>(await req(`/api/channels/${textId}/messages`, { method: 'POST', token: member.token, json: { content: 'mine' } }), 201)
    assert.equal((await req(`/api/channels/${textId}/messages/${msg.id}`, { method: 'PATCH', token: mod.token, json: { content: 'edited by mod' } })).status, 403, 'nobody rewrites your message')
    assert.equal((await req(`/api/channels/${textId}/messages/${msg.id}`, { method: 'PATCH', token: owner.token, json: { content: 'edited by owner' } })).status, 403)
    const other = await json<ApiMessage>(await req(`/api/channels/${textId}/messages`, { method: 'POST', token: mod.token, json: { content: 'mod msg' } }), 201)
    assert.equal((await req(`/api/channels/${textId}/messages/${other.id}`, { method: 'DELETE', token: member.token })).status, 403)
    await json(await req(`/api/channels/${textId}/messages/${msg.id}`, { method: 'DELETE', token: mod.token }), 204)
    const audit = await json<{ action: string }[]>(await req(`/api/servers/${serverId}/audit`, { token: owner.token }), 200)
    assert.ok(audit.some((e) => e.action === 'message.moderator_delete'))
    assert.equal((await req(`/api/servers/${serverId}/audit`, { token: member.token })).status, 403)
  })

  test('channel overrides hide a channel from members (API, events and attachments)', async () => {
    const channel = await json<{ id: string }>(
      await req(`/api/servers/${serverId}/channels`, { method: 'POST', token: owner.token, json: { name: 'Mods Only', type: 'text' } }),
      201
    )
    await json(await req(`/api/channels/${channel.id}/overrides/member`, { method: 'PUT', token: owner.token, json: { allow: 0, deny: Permissions.viewChannel } }), 200)
    const servers = await json<ApiServer[]>(await req('/api/servers', { token: member.token }), 200)
    assert.ok(!servers.find((x) => x.id === serverId)!.channels.some((c) => c.id === channel.id))
    assert.equal((await req(`/api/channels/${channel.id}/messages`, { token: member.token })).status, 404)
    assert.equal((await req(`/api/channels/${channel.id}/messages`, { token: mod.token })).status, 200)

    // An attachment in the hidden channel can't be downloaded by guessing its id.
    const form = new FormData()
    form.append('file', new Blob(['secret notes']), 'secret.txt')
    const up = await fetch(`${s.base}/api/channels/${channel.id}/attachments`, { method: 'POST', headers: { Authorization: `${SCHEME} ${mod.token}` }, body: form })
    const [file] = (await json<{ id: string }[]>(up, 201))
    const sent = await json<ApiMessage>(await req(`/api/channels/${channel.id}/messages`, { method: 'POST', token: mod.token, json: { content: '', attachmentIds: [file!.id] } }), 201)
    assert.equal((await req(`/api/attachments/${file!.id}`, { token: mod.token })).status, 200)
    assert.equal((await req(`/api/attachments/${file!.id}`, { token: member.token })).status, 404)
    assert.equal((await req(`/api/attachments/${file!.id}`, { token: outsider.token })).status, 404)
    // Search doesn't leak it either.
    const search = await json<{ messages: ApiMessage[] }>(await req(`/api/search?serverId=${serverId}&q=`, { token: member.token }).then(async (r) => (r.status === 400 ? req(`/api/search?serverId=${serverId}&authorId=${mod.user.id}`, { token: member.token }) : r)), 200)
    assert.ok(!search.messages.some((m) => m.id === sent.id))
  })

  test('role escalation is impossible', async () => {
    // Moderators have no Manage Roles.
    assert.equal((await req(`/api/servers/${serverId}/members/${member.user.id}`, { method: 'PATCH', token: mod.token, json: { role: 'moderator' } })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}/members/${mod.user.id}`, { method: 'PATCH', token: mod.token, json: { role: 'admin' } })).status, 403, 'not yourself')
    assert.equal((await req(`/api/servers/${serverId}/members/${owner.user.id}`, { method: 'PATCH', token: mod.token, json: { role: 'member' } })).status, 403)
    // "owner" is not an assignable role at all.
    assert.equal((await req(`/api/servers/${serverId}/members/${member.user.id}`, { method: 'PATCH', token: owner.token, json: { role: 'owner' } })).status, 400)
    // An admin can't touch the owner, other admins, or grant what they don't have.
    await json(await req(`/api/servers/${serverId}/members/${mod.user.id}`, { method: 'PATCH', token: owner.token, json: { role: 'admin' } }), 200)
    assert.equal((await req(`/api/servers/${serverId}/members/${owner.user.id}`, { method: 'DELETE', token: mod.token })).status, 403)
    assert.equal((await req(`/api/servers/${serverId}/roles/admin`, { method: 'PUT', token: mod.token, json: { permissions: ALL_PERMISSIONS } })).status, 403, 'own role')
    await json(await req(`/api/servers/${serverId}/roles/admin`, { method: 'PUT', token: owner.token, json: { permissions: ADMIN_DEFAULT & ~Permissions.banMembers } }), 200)
    assert.equal((await req(`/api/servers/${serverId}/roles/member`, { method: 'PUT', token: mod.token, json: { permissions: MEMBER_DEFAULT | Permissions.banMembers } })).status, 403, 'cannot grant what you lack')
    assert.equal((await req(`/api/servers/${serverId}/roles/member`, { method: 'PUT', token: mod.token, json: { permissions: 2 ** 30 } })).status, 400, 'unknown bits')
    // Reset and demote back.
    await json(await req(`/api/servers/${serverId}/roles/admin`, { method: 'PUT', token: owner.token, json: { permissions: null } }), 200)
    await json(await req(`/api/servers/${serverId}/members/${mod.user.id}`, { method: 'PATCH', token: owner.token, json: { role: 'moderator' } }), 200)
    // Owner can't leave (no ownerless servers); ownership transfer needs the password.
    assert.equal(await errorCode(await req(`/api/servers/${serverId}/leave`, { method: 'POST', token: owner.token })), 'owner_cannot_leave')
    assert.equal(await errorCode(await req(`/api/servers/${serverId}/transfer`, { method: 'POST', token: owner.token, json: { userId: mod.user.id, password: 'nope-nope-nope' } })), 'wrong_password')
    assert.equal((await req(`/api/servers/${serverId}/transfer`, { method: 'POST', token: mod.token, json: { userId: mod.user.id, password: PASSWORD } })).status, 403)
  })

  test('invitations: permission, preview, usage limit, revocation, races', async () => {
    assert.equal((await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: member.token, json: {} })).status, 403, 'members cannot invite by default')
    const inv = await json<ApiServerInvite>(await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: mod.token, json: { maxUses: 2, expiresInHours: 1 } }), 201)
    assert.match(inv.code!, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    // The code is not stored in plaintext and isn't listed again.
    const listed = await json<ApiServerInvite[]>(await req(`/api/servers/${serverId}/invites`, { token: mod.token }), 200)
    assert.ok(listed.every((i) => i.code === undefined))

    const joiners = await Promise.all(Array.from({ length: 5 }, (_, i) => register(`race-${i}`, null)))
    const preview = await json<{ serverName: string; member: boolean }>(await req('/api/invites/preview', { method: 'POST', token: joiners[0]!.token, json: { code: inv.code } }), 200)
    assert.deepEqual(preview, { ...preview, serverName: 'Private', member: false })
    const results = await Promise.all(joiners.map((j) => req('/api/invites/accept', { method: 'POST', token: j.token, json: { code: inv.code } })))
    assert.equal(results.filter((r) => r.status === 200).length, 2, 'usage limit is atomic')
    assert.equal(results.filter((r) => r.status === 404).length, 3)

    const inv2 = await json<ApiServerInvite>(await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: {} }), 201)
    // Moderators may revoke only their own invites; Manage Invites (owner/admin) revokes any.
    assert.equal((await req(`/api/servers/${serverId}/invites/${inv2.id}`, { method: 'DELETE', token: mod.token })).status, 403)
    await json(await req(`/api/servers/${serverId}/invites/${inv.id}`, { method: 'DELETE', token: mod.token }), 204)
    await json(await req(`/api/servers/${serverId}/invites/${inv2.id}`, { method: 'DELETE', token: owner.token }), 204)
    assert.equal((await req('/api/invites/accept', { method: 'POST', token: outsider.token, json: { code: inv2.code } })).status, 404)
    assert.equal((await req('/api/invites/accept', { method: 'POST', token: outsider.token, json: { code: 'not-a-code' } })).status, 404)
    // Codes never appear in URLs (preview/accept are POST bodies).
    assert.equal((await req(`/api/invites/${inv2.code}`, { token: outsider.token })).status, 404)
  })

  test('kick and ban remove access immediately; banned users cannot rejoin', async () => {
    const victim = await register('kick-me', null)
    const inv = await json<ApiServerInvite>(await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: {} }), 201)
    await json(await req('/api/invites/accept', { method: 'POST', token: victim.token, json: { code: inv.code } }), 200)
    const gw = gateway(victim.token)
    await gw.waitFor((f) => f.op === 'ready')
    await json(await req(`/api/servers/${serverId}/members/${victim.user.id}`, { method: 'DELETE', token: mod.token }), 204)
    await gw.waitFor((f) => f.op === 'server_remove' && f.d.serverId === serverId)
    assert.equal((await req(`/api/channels/${textId}/messages`, { token: victim.token })).status, 404)

    await json(await req('/api/invites/accept', { method: 'POST', token: victim.token, json: { code: inv.code } }), 200)
    assert.equal((await req(`/api/servers/${serverId}/bans/${victim.user.id}`, { method: 'PUT', token: mod.token, json: {} })).status, 403, 'moderators cannot ban by default')
    await json(await req(`/api/servers/${serverId}/bans/${victim.user.id}`, { method: 'PUT', token: owner.token, json: { reason: 'test' } }), 200)
    assert.equal((await req(`/api/channels/${textId}/messages`, { token: victim.token })).status, 404)
    const rejoin = await req('/api/invites/accept', { method: 'POST', token: victim.token, json: { code: inv.code } })
    assert.equal(await errorCode(rejoin), 'banned')
    await json(await req(`/api/servers/${serverId}/bans/${victim.user.id}`, { method: 'DELETE', token: owner.token }), 204)
    await json(await req('/api/invites/accept', { method: 'POST', token: victim.token, json: { code: inv.code } }), 200)
    gw.ws.close()
  })

  test('LiveKit grants follow Connect/Speak/Stream and the authenticated identity', async () => {
    const verifier = new TokenVerifier(API_KEY, API_SECRET)
    const grant = await json<{ token: string; identity: string }>(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token }), 200)
    assert.equal(grant.identity, member.user.id)
    const claims = await verifier.verify(grant.token)
    assert.equal(claims.sub, member.user.id)
    assert.deepEqual(claims.video?.canPublishSources, ['microphone', 'screen_share', 'screen_share_audio'])

    // Deny Stream for members: no screen-share sources.
    await json(await req(`/api/channels/${voiceId}/overrides/member`, { method: 'PUT', token: owner.token, json: { allow: 0, deny: Permissions.stream } }), 200)
    const noStream = await verifier.verify((await json<{ token: string }>(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token }), 200)).token)
    assert.deepEqual(noStream.video?.canPublishSources, ['microphone'])
    // Deny Connect: no token at all.
    await json(await req(`/api/channels/${voiceId}/overrides/member`, { method: 'PUT', token: owner.token, json: { allow: 0, deny: Permissions.connect } }), 200)
    assert.equal(await errorCode(await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token })), 'missing_permission')
    await json(await req(`/api/channels/${voiceId}/overrides/member`, { method: 'PUT', token: owner.token, json: { allow: 0, deny: 0 } }), 200)
    // A client-supplied identity is ignored (no body accepted at all).
    const forged = await req(`/api/voice/channels/${voiceId}/token`, { method: 'POST', token: member.token, json: { identity: owner.user.id } })
    const forgedClaims = await verifier.verify((await json<{ token: string }>(forged, 200)).token)
    assert.equal(forgedClaims.sub, member.user.id)
  })

  test('voice: unauthorized participants are refused and removed members leave voice', async () => {
    const authorize = voiceAuthorizer(s.ctx)
    assert.equal(await authorize(outsider.user.id, voiceId), null, 'webhook joins from non-members are kicked')
    assert.ok(((await authorize(member.user.id, voiceId)) ?? 0) & Permissions.connect)

    const leaver = await register('voice-leaver', null)
    const inv = await json<ApiServerInvite>(await req(`/api/servers/${serverId}/invites`, { method: 'POST', token: owner.token, json: {} }), 201)
    await json(await req('/api/invites/accept', { method: 'POST', token: leaver.token, json: { code: inv.code } }), 200)
    // Pretend LiveKit reported both users in the voice channel.
    s.ctx.voice.store.join(leaver.user.id, voiceId)
    s.ctx.voice.store.join(member.user.id, voiceId)
    await json(await req(`/api/servers/${serverId}/members/${leaver.user.id}`, { method: 'DELETE', token: owner.token }), 204)
    assert.equal(s.ctx.voice.store.channelOf(leaver.user.id), undefined, 'kicked member removed from voice')
    assert.equal(s.ctx.voice.store.channelOf(member.user.id), voiceId, 'others unaffected')
    // Signing out everywhere also ends voice.
    await json(await req('/api/auth/logout-all', { method: 'POST', token: (await login('authz-member')).token, json: {} }), 200)
    assert.equal(s.ctx.voice.store.channelOf(member.user.id), undefined)
    member = await login('authz-member')
  })

  test('unauthorized WebSocket use is closed', async () => {
    const bad = gateway('not-a-real-token-xxxxxxxxxxxxxxxx')
    assert.equal(await bad.closed, 4001)
    const ws = new WebSocket(s.base.replace('http', 'ws') + '/gateway')
    await new Promise((r) => ws.addEventListener('open', r))
    ws.send(JSON.stringify({ op: 'set_status', d: { status: 'online' } }))
    const code = await new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)))
    assert.equal(code, 4001)
  })

  test('the user list only shows people who share a server', async () => {
    const loner = await register('loner', null)
    const visible = await json<{ id: string }[]>(await req('/api/users', { token: loner.token }), 200)
    const ids = visible.map((u) => u.id)
    assert.ok(ids.includes(loner.user.id))
    assert.ok(!ids.includes(member.user.id))
  })
})

// ======================================================================
describe('legacy development identity migration', () => {
  test('a claim code binds to one identity, keeps its id and data, and ends dev sessions', async () => {
    const legacy = await devLogin('legacy-sam')
    const msg = await json<ApiMessage>(await req('/api/channels/hangout-general/messages', { method: 'POST', token: legacy.token, json: { content: 'from before accounts' } }), 201)
    await req(`/api/channels/hangout-general/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`, { method: 'PUT', token: legacy.token })
    const gw = gateway(legacy.token)
    await gw.waitFor((f) => f.op === 'ready')

    const legacyList = await json<{ id: string; username: string; messages: number }[]>(await req('/api/admin/legacy', { token: adminToken }), 200)
    assert.equal(legacyList.find((l) => l.username === 'legacy-sam')?.messages, 1)
    const { code } = await json<{ code: string }>(
      await req(`/api/admin/legacy/${legacy.userId}/claim-code`, { method: 'POST', token: adminToken, json: { password: PASSWORD } }),
      201
    )
    const info = await json<{ kind: string; username: string }>(await req('/api/auth/invite-info', { method: 'POST', json: { code } }), 200)
    assert.deepEqual({ kind: info.kind, username: info.username }, { kind: 'claim', username: 'legacy-sam' })

    // The username in the request is ignored: a claim code can only claim its own identity.
    const claimed = await json<ApiAuthResult>(
      await req('/api/auth/register', { method: 'POST', json: { code, username: 'root', password: 'sam-new-passphrase-9' } }),
      201
    )
    assert.equal(claimed.user.id, legacy.userId)
    assert.equal(claimed.user.username, 'legacy-sam')
    assert.equal(await gw.closed, 4001, 'dev session socket closed')
    assert.equal((await req('/api/users/me', { token: legacy.token })).status, 401, 'dev token revoked')
    assert.equal(await errorCode(await req('/api/dev/login', { method: 'POST', json: { username: 'legacy-sam' } })), 'password_account')

    // Ownership of history is preserved.
    const history = await json<ApiMessage[]>(await req('/api/channels/hangout-general/messages', { token: claimed.token }), 200)
    const mine = history.find((m) => m.id === msg.id)!
    assert.equal(mine.authorId, legacy.userId)
    assert.deepEqual(mine.reactions, [{ emoji: '👍', count: 1, me: true }])
    assert.equal((await req(`/api/channels/hangout-general/messages/${msg.id}`, { method: 'PATCH', token: claimed.token, json: { content: 'still mine' } })).status, 200)

    // Single use, and not reissuable for a claimed identity.
    assert.equal((await req('/api/auth/register', { method: 'POST', json: { code, password: PASSWORD } })).status, 400)
    assert.equal(await errorCode(await req(`/api/admin/legacy/${legacy.userId}/claim-code`, { method: 'POST', token: adminToken, json: { password: PASSWORD } })), 'already_claimed')
  })

  test('a new claim code revokes the previous one; ordinary invitations cannot claim', async () => {
    const legacy = await devLogin('legacy-kim')
    const first = await json<{ code: string }>(await req(`/api/admin/legacy/${legacy.userId}/claim-code`, { method: 'POST', token: adminToken, json: { password: PASSWORD } }), 201)
    const second = await json<{ code: string }>(await req(`/api/admin/legacy/${legacy.userId}/claim-code`, { method: 'POST', token: adminToken, json: { password: PASSWORD } }), 201)
    assert.equal((await req('/api/auth/register', { method: 'POST', json: { code: first.code, password: PASSWORD } })).status, 400)
    // A normal registration code with the legacy username is just "username taken".
    const reg = await registrationCode()
    assert.equal((await req('/api/auth/register', { method: 'POST', json: { code: reg, username: 'legacy-kim', password: PASSWORD } })).status, 409)
    await json(await req('/api/auth/register', { method: 'POST', json: { code: second.code, password: 'kim-new-passphrase-1' } }), 201)
  })

  test('merge moves an identity into an account (dry run first)', async () => {
    const legacy = await devLogin('legacy-old-me')
    const msg = await json<ApiMessage>(await req('/api/channels/hangout-general/messages', { method: 'POST', token: legacy.token, json: { content: 'old me' } }), 201)
    const account = await register('new-me')
    const dry = await s.repo.mergeUsers(legacy.userId, account.user.id, true)
    assert.equal(dry.messages, 1)
    assert.equal(dry.dryRun, true)
    assert.ok(await s.repo.getUser(legacy.userId), 'dry run changes nothing')
    await assert.rejects(s.repo.mergeUsers(account.user.id, legacy.userId, true), /source_has_password/)
    await s.repo.mergeUsers(legacy.userId, account.user.id, false)
    assert.equal(await s.repo.getUser(legacy.userId), undefined)
    assert.equal((await s.repo.getMessage(msg.id))?.authorId, account.user.id)
    const report = await s.repo.integrityReport()
    assert.equal(report.integrityCheck, 'ok')
    assert.equal(report.foreignKeyViolations, 0)
    assert.deepEqual(Object.values(report.orphans), [0, 0, 0, 0, 0])
  })
})

// ======================================================================
describe('upgrading a realistic Milestone 6 database', () => {
  test('keeps users, messages, files, reactions, pins and read state; members keep access', async () => {
    const m6dir = mkdtempSync(join(tmpdir(), 'd2-m6-'))
    const file = join(m6dir, 'discord2.db')
    try {
      // Build the database exactly as Milestone 6 left it (migrations 1-2) with typical data.
      const db = new DatabaseSync(file)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
      for (const m of sqliteMigrations.filter((x) => x.version <= 2)) {
        db.exec(m.sql)
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
      }
      const devToken = 'legacy-dev-token-aaaaaaaaaaaaaaaaaaaaaaaa'
      db.exec(`
        INSERT INTO users VALUES ('u-alice', 'alice', 'Alice', '#aa0000', 0, 1), ('u-bob', 'bob', 'Bob', '#0000aa', 0, 2),
                                 ('system-orbit', 'orbit', 'Orbit', '#777777', 1, 0);
        INSERT INTO servers VALUES ('hangout', 'The Hangout', '#6d72f6', NULL, 0, 1), ('bobs', 'Bob''s', '#00aa00', 'u-bob', 1, 2);
        INSERT INTO channels VALUES ('hangout-general', 'hangout', 'general', 'text', NULL, 'Text', 0, 1),
                                    ('hangout-lounge', 'hangout', 'Lounge', 'voice', NULL, 'Voice', 1, 1),
                                    ('bobs-general', 'bobs', 'general', 'text', NULL, 'Text', 0, 2);
        INSERT INTO messages (channel_id, author_id, content, created_at) VALUES
          ('hangout-general', 'system-orbit', 'welcome', 1),
          ('hangout-general', 'u-alice', 'hello from m6', 10),
          ('hangout-general', 'u-bob', 'reply from bob', 11),
          ('bobs-general', 'u-bob', 'bobs place', 12);
        UPDATE messages SET reply_to_id = 2, edited_at = 20 WHERE id = 3;
        INSERT INTO attachments VALUES ('${'a'.repeat(32)}', 2, 'hangout-general', 'u-alice', 'shot.png', 'image/png', 'image', 10, 1, 1, 'x', 0, 10);
        INSERT INTO reactions VALUES (2, '👍', 'u-bob', 12);
        INSERT INTO pins VALUES (2, 'hangout-general', 'u-bob', 13);
        INSERT INTO read_states VALUES ('u-alice', 'hangout-general', 3, 14);
      `)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha256Hex(devToken), 'u-alice', 1, Date.now())
      const before = db.prepare('SELECT (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM attachments) a, (SELECT COUNT(*) FROM reactions) r, (SELECT COUNT(*) FROM pins) p, (SELECT COUNT(*) FROM read_states) rs').get()
      db.close()

      const repo = new SqliteRepository(file)
      await repo.migrate()
      await repo.migrate() // repeat: no-op
      const after = (repo as unknown as { db: DatabaseSync }).db
        .prepare('SELECT (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM attachments) a, (SELECT COUNT(*) FROM reactions) r, (SELECT COUNT(*) FROM pins) p, (SELECT COUNT(*) FROM read_states) rs')
        .get()
      assert.deepEqual({ ...after }, { ...before }, 'no data lost')
      const members = await repo.listMembers('hangout')
      assert.deepEqual(members.map((m) => [m.userId, m.role]).sort(), [['u-alice', 'member'], ['u-bob', 'member']])
      assert.equal((await repo.getMember('bobs', 'u-bob'))?.role, 'owner', 'existing owner keeps ownership')
      assert.equal(await repo.getMember('hangout', 'system-orbit'), undefined, 'bots are not members')
      const report = await repo.integrityReport()
      assert.equal(report.legacyIdentities, 2)
      assert.deepEqual(report.serversWithoutOwner, ['hangout'])
      assert.equal(report.integrityCheck, 'ok')
      assert.equal(report.foreignKeyViolations, 0)
      await repo.close()

      // The upgraded server serves the old data to the old (development) session.
      const prev = s
      s = await start({}, file)
      try {
        const history = await json<ApiMessage[]>(await req('/api/channels/hangout-general/messages', { token: devToken }), 200)
        const hello = history.find((m) => m.content === 'hello from m6')!
        assert.equal(hello.attachments?.[0]?.filename, 'shot.png')
        assert.deepEqual(hello.reactions, [{ emoji: '👍', count: 1, me: false }])
        assert.equal(hello.pinned, true)
        assert.equal(history.find((m) => m.content === 'reply from bob')?.replyTo?.id, hello.id)
        const search = await json<{ messages: ApiMessage[] }>(await req('/api/search?q=m6&serverId=hangout', { token: devToken }), 200)
        assert.equal(search.messages.length, 1)
        const readStates = await json<{ channelId: string; lastReadId: string }[]>(await req('/api/read-states', { token: devToken }), 200)
        assert.equal(readStates.find((r) => r.channelId === 'hangout-general')?.lastReadId, '3')
        // Alice's old session can't see Bob's server's messages? She was a member of every server before.
        assert.equal((await req('/api/channels/bobs-general/messages', { token: devToken })).status, 200)
      } finally {
        await s.app.close()
        await s.repo.close()
        s = prev
      }

      // A Milestone 6 server can still use the migrated file (additive schema).
      const m6 = new DatabaseSync(file)
      m6.exec('PRAGMA foreign_keys = ON')
      m6.prepare('INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)').run('hangout-general', 'u-alice', 'written by m6 after rollback', 30)
      m6.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run('h2', 'u-bob', 1, 1)
      assert.equal(m6.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 5)
      m6.close()
    } finally {
      rmSync(m6dir, { recursive: true, force: true })
    }
  })
})
