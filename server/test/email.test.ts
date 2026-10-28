/**
 * Milestone 13: email accounts — registration policy, self-registration with email
 * confirmation, password reset by email, adding/removing an address, account-enumeration
 * safety and cleanup of unconfirmed sign-ups. Mail goes to an in-memory sink (no real email).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { HashGate, OWASP_MINIMUM, PasswordHasher } from '../src/auth/password.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { seedIfEmpty } from '../src/db/seed.js'
import { SqliteRepository } from '../src/db/sqlite.js'
import { TokenBucketLimiter } from '../src/lib/rateLimit.js'
import { normalizeEmail } from '../src/lib/validation.js'
import { MemoryMailer, maskEmail } from '../src/mail/mailer.js'
import { EMAIL_CODE_MAX_ATTEMPTS, PENDING_SIGNUP_TTL_MS } from '../src/routes/email.js'
import type { ApiAuthResult, ApiMe } from '../src/protocol.js'

const SCHEME = ['Bea', 'rer'].join('')
const HASHER = new PasswordHasher(OWASP_MINIMUM, new HashGate(4, 64))
const PASSWORD = 'violet-anchor-sunrise-42'
const NEW_PASSWORD = 'harbor-lantern-meadow-77'

const dir = mkdtempSync(join(tmpdir(), 'd2-email-'))

interface Server {
  app: FastifyInstance
  ctx: AppContext
  repo: SqliteRepository
  mail: MemoryMailer
  base: string
  file: string
}

let counter = 0

async function start(env: Record<string, string> = {}, keepLimits: (keyof AppContext['limiters'])[] = []): Promise<Server> {
  const file = join(dir, `email-${++counter}.db`)
  const repo = new SqliteRepository(file)
  await repo.migrate()
  await seedIfEmpty(repo)
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_DIR: join(dir, `attachments-${counter}`),
    REGISTRATION_MODE: 'open',
    MAIL_TRANSPORT: 'file',
    MAIL_SINK_DIR: join(dir, `sink-${counter}`),
    ...env
  })
  const mail = new MemoryMailer()
  const { app, ctx } = await buildApp(config, repo, {
    logger: false,
    hasher: HASHER,
    // "No email" cases keep the real (absent) transport.
    mailer: config.mail.transport === 'none' ? undefined : mail,
    mailRetryDelayMs: 0,
    voiceReconcileIntervalMs: 0,
    attachmentCleanupIntervalMs: 0,
    statusExpiryIntervalMs: 0
  })
  for (const name of Object.keys(ctx.limiters) as (keyof AppContext['limiters'])[]) {
    if (keepLimits.includes(name)) continue
    ctx.limiters[name].dispose()
    ctx.limiters[name] = new TokenBucketLimiter(10_000, 1_000)
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { app, ctx, repo, mail, base: `http://127.0.0.1:${address.port}`, file }
}

async function stop(s: Server): Promise<void> {
  await s.app.close()
  await s.repo.close()
}

function client(s: Server) {
  const req = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
    if (init.token) headers.Authorization = `${SCHEME} ${init.token}`
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`${s.base}${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body
    })
  }
  const post = (path: string, json: unknown, token?: string) => req(path, { method: 'POST', json, token })
  return { req, post }
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text()
  assert.equal(res.status, status, `${res.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code

/** The code in the newest email to `address`. */
async function lastCode(s: Server, address: string): Promise<string> {
  await s.ctx.mail.drain()
  const messages = s.mail.to(address)
  assert.ok(messages.length > 0, `no email to ${address}`)
  const match = /\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(messages[messages.length - 1]!.text)
  assert.ok(match, 'email contains a code')
  return match[1]!
}

/** Direct database access (a second connection) for clock-dependent states. */
function sql(s: Server, statement: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(s.file)
  try {
    db.prepare(statement).run(...params)
  } finally {
    db.close()
  }
}

async function signUp(s: Server, email: string, username: string, password = PASSWORD): Promise<Response> {
  return client(s).post('/api/auth/signup', { email, username, password })
}

async function signUpAndVerify(s: Server, email: string, username: string): Promise<ApiAuthResult> {
  await json(await signUp(s, email, username), 202)
  const code = await lastCode(s, email)
  return json<ApiAuthResult>(
    await client(s).post('/api/auth/verify-email', { login: email, password: PASSWORD, code }),
    200
  )
}

after(() => rmSync(dir, { recursive: true, force: true }))

// ======================================================================
describe('configuration', () => {
  const base = { NODE_ENV: 'test', LOG_LEVEL: 'silent' }

  test('invite-only by default, without email', () => {
    const config = loadConfig(base)
    assert.equal(config.registration.mode, 'invite')
    assert.equal(config.mail.transport, 'none')
  })

  test('open registration needs an email transport', () => {
    assert.throws(() => loadConfig({ ...base, REGISTRATION_MODE: 'open' }), /needs email delivery/)
    assert.throws(() => loadConfig({ ...base, REGISTRATION_MODE: 'public' }), /REGISTRATION_MODE/)
    assert.equal(loadConfig({ ...base, REGISTRATION_MODE: 'closed' }).registration.mode, 'closed')
  })

  test('the file mail sink is refused in production; SMTP is validated', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', DEV_AUTH: 'false', MAIL_TRANSPORT: 'file' }),
      /refused in production/
    )
    assert.throws(() => loadConfig({ ...base, MAIL_TRANSPORT: 'smtp' }), /SMTP_HOST/)
    assert.throws(
      () => loadConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' }),
      /MAIL_FROM/
    )
    const smtp = loadConfig({
      ...base,
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'apikey',
      SMTP_PASSWORD: 'not-a-real-secret',
      MAIL_FROM: 'Discord 2.0 <no-reply@example.com>'
    }).mail
    assert.equal(smtp.transport, 'smtp')
    assert.ok(smtp.transport === 'smtp' && smtp.secure && smtp.port === 465 && !smtp.allowInsecure)
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          DEV_AUTH: 'false',
          MAIL_TRANSPORT: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          SMTP_ALLOW_INSECURE: 'true',
          MAIL_FROM: 'no-reply@example.com'
        }),
      /private network/
    )
    // A relay login without a password would fail on every email, silently: refused at start-up.
    const relay = { ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' }
    assert.throws(() => loadConfig({ ...relay, SMTP_USER: 'apikey' }), /SMTP_PASSWORD/)
    assert.throws(() => loadConfig({ ...relay, SMTP_USER: 'apikey', SMTP_PASSWORD: '' }), /SMTP_PASSWORD/)
    // Docker Compose passes unset variables as empty strings: an empty one beside a file is fine.
    const secretFile = join(dir, 'smtp-password')
    writeFileSync(secretFile, 'not-a-real-secret\n')
    const fromFile = loadConfig({ ...relay, SMTP_USER: 'apikey', SMTP_PASSWORD: '', SMTP_PASSWORD_FILE: secretFile }).mail
    assert.ok(fromFile.transport === 'smtp' && fromFile.password === 'not-a-real-secret')
    assert.equal(loadConfig(relay).mail.transport, 'smtp', 'a relay without login needs no password')
  })
})

describe('email address validation', () => {
  test('accepts real-world addresses and normalizes case', () => {
    assert.equal(normalizeEmail('  Alice.Smith+chat@Example.COM '), 'alice.smith+chat@example.com')
    assert.equal(normalizeEmail('o\'brien@mail.example.co.uk'), "o'brien@mail.example.co.uk")
    assert.equal(normalizeEmail('x@xn--bcher-kva.example'), 'x@xn--bcher-kva.example')
  })

  test('rejects malformed addresses', () => {
    for (const bad of [
      '',
      'alice',
      'alice@',
      '@example.com',
      'alice@example',
      'alice@@example.com',
      'alice@exa mple.com',
      'alice@-example.com',
      'alice@example.c',
      'alice@example.123',
      'alice..smith@example.com',
      '.alice@example.com',
      'alice.@example.com',
      'alice@[127.0.0.1]',
      '"quoted"@example.com',
      `${'a'.repeat(65)}@example.com`,
      `a@${'b'.repeat(250)}.com`,
      42
    ]) {
      assert.throws(() => normalizeEmail(bad), /valid email/, String(bad))
    }
  })

  test('masks addresses for logs and messages', () => {
    assert.equal(maskEmail('alice@example.com'), 'al***@example.com')
    assert.equal(maskEmail('a@example.com'), 'a***@example.com')
  })
})

// ======================================================================
describe('registration policy', () => {
  test('invite mode: sign-up refused, meta reports the mode', async () => {
    const s = await start({ REGISTRATION_MODE: 'invite', MAIL_TRANSPORT: 'none' })
    try {
      const meta = await json<{ registration: string; email: boolean; emailAccounts: boolean }>(
        await client(s).req('/api/meta'),
        200
      )
      assert.deepEqual([meta.registration, meta.email, meta.emailAccounts], ['invite', false, true])
      const res = await signUp(s, 'new@example.com', 'newbie')
      assert.equal(res.status, 403)
      assert.equal(await errorCode(res), 'invite_required')
      // Without email, address-based recovery is unavailable (and says so).
      const forgot = await client(s).post('/api/auth/forgot-password', { email: 'x@example.com' })
      assert.equal(forgot.status, 503)
      assert.equal(await errorCode(forgot), 'email_unavailable')
    } finally {
      await stop(s)
    }
  })

  test('closed mode: no sign-up and no new accounts from registration invitations', async () => {
    const s = await start({ REGISTRATION_MODE: 'closed' })
    try {
      const res = await signUp(s, 'new@example.com', 'newbie')
      assert.equal(res.status, 403)
      assert.equal(await errorCode(res), 'registration_closed')
      const now = Date.now()
      await s.repo.provisionAccount(
        { id: 'adm', username: 'root', displayName: 'Root', avatarColor: '#111111', bot: false, createdAt: now },
        await HASHER.hash(PASSWORD),
        now
      )
      const { token } = await json<ApiAuthResult>(
        await client(s).post('/api/auth/login', { username: 'root', password: PASSWORD }),
        200
      )
      const invite = await json<{ code: string }>(
        await client(s).post('/api/admin/registration-invites', { password: PASSWORD, serverId: null }, token),
        201
      )
      const info = await client(s).post('/api/auth/invite-info', { code: invite.code })
      assert.equal(info.status, 403)
      assert.equal(await errorCode(info), 'registration_closed')
      const reg = await client(s).post('/api/auth/register', {
        code: invite.code,
        username: 'viainvite',
        password: PASSWORD
      })
      assert.equal(reg.status, 403)
      assert.equal(await errorCode(reg), 'registration_closed')
    } finally {
      await stop(s)
    }
  })

  test('open mode: invitations keep working alongside email sign-up', async () => {
    const s = await start()
    try {
      const meta = await json<{ registration: string; email: boolean }>(await client(s).req('/api/meta'), 200)
      assert.deepEqual([meta.registration, meta.email], ['open', true])
    } finally {
      await stop(s)
    }
  })
})

// ======================================================================
describe('sign-up and email confirmation', () => {
  let s: Server
  before(async () => {
    s = await start({ REGISTRATION_AUTO_JOIN_SERVER: 'hangout' })
  })
  after(() => stop(s))

  test('valid sign-up sends a code; the account cannot sign in until confirmed', async () => {
    const res = await signUp(s, 'Alice@Example.com', 'alice_m13')
    const body = await json<{ status: string; expiresInMinutes: number }>(res, 202)
    assert.deepEqual(body, { status: 'email_sent', expiresInMinutes: 30 })
    const code = await lastCode(s, 'alice@example.com')
    const mail = s.mail.to('alice@example.com').at(-1)!
    assert.match(mail.subject, new RegExp(code))
    assert.ok(mail.html?.includes(code))
    assert.ok(!mail.text.includes(PASSWORD))

    const early = await client(s).post('/api/auth/login', { username: 'alice_m13', password: PASSWORD })
    assert.equal(early.status, 403)
    const err = (await early.json()) as { error: { code: string; message: string } }
    assert.equal(err.error.code, 'email_unverified')
    assert.match(err.error.message, /al\*\*\*@example\.com/)
    // Wrong password: the usual answer (nothing about the pending account).
    const wrong = await client(s).post('/api/auth/login', { username: 'alice_m13', password: 'nope-nope-nope-1' })
    assert.equal(wrong.status, 401)
    assert.equal(await errorCode(wrong), 'invalid_credentials')
  })

  test('a pending account is invisible: no friend requests, no development sign-in', async () => {
    const { token } = await json<{ token: string }>(
      await client(s).post('/api/dev/login', { username: 'bystander' }),
      200
    )
    const friend = await client(s).post('/api/relationships/requests', { username: 'alice_m13' }, token)
    assert.equal(friend.status, 404, 'a pending account looks like an unknown username')
    const dev = await client(s).post('/api/dev/login', { username: 'alice_m13' })
    assert.equal(dev.status, 403)
  })

  test('confirmation needs the right code and the right password', async () => {
    const code = await lastCode(s, 'alice@example.com')
    const wrongPassword = await client(s).post('/api/auth/verify-email', {
      login: 'alice@example.com',
      password: 'not-the-password-9',
      code
    })
    assert.equal(wrongPassword.status, 400)
    assert.equal(await errorCode(wrongPassword), 'invalid_code')
    const wrongCode = await client(s).post('/api/auth/verify-email', {
      login: 'alice@example.com',
      password: PASSWORD,
      code: 'AAAA-AAAA'
    })
    assert.equal(await errorCode(wrongCode), 'invalid_code')
    const malformed = await client(s).post('/api/auth/verify-email', {
      login: 'alice@example.com',
      password: PASSWORD,
      code: 'nope'
    })
    assert.equal(await errorCode(malformed), 'invalid_code')
  })

  test('the right code signs in, confirms the address and joins the configured server', async () => {
    const code = await lastCode(s, 'alice@example.com')
    const result = await json<ApiAuthResult>(
      // Lower-case and separators don't matter when typing the code.
      await client(s).post('/api/auth/verify-email', {
        login: 'alice_m13',
        password: PASSWORD,
        code: code.toLowerCase().replace('-', ' ')
      }),
      200
    )
    assert.equal(result.newAccount, true)
    assert.equal(result.user.username, 'alice_m13')
    assert.equal(result.user.email, 'alice@example.com')
    assert.equal(result.user.emailVerified, true)
    const me = await json<ApiMe>(await client(s).req('/api/users/me', { token: result.token }), 200)
    assert.equal(me.id, result.user.id)
    assert.ok(await s.repo.getMember('hangout', result.user.id), 'auto-joined')

    // Replay: the code worked once.
    const replay = await client(s).post('/api/auth/verify-email', { login: 'alice_m13', password: PASSWORD, code })
    assert.equal(await errorCode(replay), 'invalid_code')
    // Sign in by username or by address.
    await json(await client(s).post('/api/auth/login', { username: 'alice_m13', password: PASSWORD }), 200)
    await json(await client(s).post('/api/auth/login', { username: 'ALICE@example.com', password: PASSWORD }), 200)
  })

  test('duplicate username is reported; duplicate address is not (its owner is told instead)', async () => {
    const taken = await signUp(s, 'other@example.com', 'alice_m13')
    assert.equal(taken.status, 409)
    assert.equal(await errorCode(taken), 'username_taken')

    s.mail.clear()
    const dup = await signUp(s, 'alice@example.com', 'alice_two')
    assert.deepEqual(await json(dup, 202), { status: 'email_sent', expiresInMinutes: 30 })
    await s.ctx.mail.drain()
    const notice = s.mail.to('alice@example.com')
    assert.equal(notice.length, 1)
    assert.match(notice[0]!.subject, /already have/)
    assert.ok(!/\b[0-9A-Z]{4}-[0-9A-Z]{4}\b/.test(notice[0]!.text), 'no code in the notice')
    assert.equal(await s.repo.findUserByUsername('alice_two'), undefined)
  })

  test('invalid input: email, weak password, missing fields, bad username', async () => {
    const bad = await signUp(s, 'not-an-email', 'someone')
    assert.equal(await errorCode(bad), 'invalid_email')
    const weak = await signUp(s, 'weak@example.com', 'weakling', 'password1234')
    assert.equal(await errorCode(weak), 'weak_password')
    const short = await signUp(s, 'weak@example.com', 'weakling', 'short')
    assert.equal(await errorCode(short), 'weak_password')
    const missing = await client(s).post('/api/auth/signup', { email: 'm@example.com', password: PASSWORD })
    assert.equal(missing.status, 400)
    assert.equal(await errorCode(missing), 'invalid_request')
    const extra = await client(s).post('/api/auth/signup', {
      email: 'm@example.com',
      username: 'mmm',
      password: PASSWORD,
      instanceAdmin: true
    })
    assert.equal(await errorCode(extra), 'invalid_request')
    const name = await signUp(s, 'n@example.com', 'bad name!')
    assert.equal(await errorCode(name), 'invalid_username')
    assert.equal(s.mail.to('weak@example.com').length, 0)
  })

  test('expired codes stop working; resend issues a new one and retires the old', async () => {
    await json(await signUp(s, 'bob@example.com', 'bob_m13'), 202)
    const first = await lastCode(s, 'bob@example.com')
    sql(s, "UPDATE email_codes SET expires_at = ? WHERE purpose = 'verify' AND email = ?", Date.now() - 1, 'bob@example.com')
    const expired = await client(s).post('/api/auth/verify-email', { login: 'bob_m13', password: PASSWORD, code: first })
    assert.equal(await errorCode(expired), 'invalid_code')

    await json(await client(s).post('/api/auth/resend-verification', { login: 'bob_m13', password: PASSWORD }), 202)
    const second = await lastCode(s, 'bob@example.com')
    assert.notEqual(second, first)
    await json(await client(s).post('/api/auth/resend-verification', { login: 'bob@example.com', password: PASSWORD }), 202)
    const third = await lastCode(s, 'bob@example.com')
    const old = await client(s).post('/api/auth/verify-email', { login: 'bob_m13', password: PASSWORD, code: second })
    assert.equal(await errorCode(old), 'invalid_code', 'a newer code retires the older one')
    await json(await client(s).post('/api/auth/verify-email', { login: 'bob_m13', password: PASSWORD, code: third }), 200)
  })

  test('resend for an unknown account or with a wrong password sends nothing (same answer)', async () => {
    s.mail.clear()
    const unknown = await client(s).post('/api/auth/resend-verification', { login: 'ghost@example.com', password: PASSWORD })
    const wrong = await client(s).post('/api/auth/resend-verification', { login: 'bob_m13', password: 'wrong-password-123' })
    assert.deepEqual(await json(unknown, 202), await json(wrong, 202))
    await s.ctx.mail.drain()
    assert.equal(s.mail.sent.length, 0)
  })

  test('a code dies after too many wrong guesses', async () => {
    await json(await signUp(s, 'carol@example.com', 'carol_m13'), 202)
    const code = await lastCode(s, 'carol@example.com')
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const res = await client(s).post('/api/auth/verify-email', { login: 'carol_m13', password: PASSWORD, code: 'ZZZZ-ZZZZ' })
      assert.equal(await errorCode(res), 'invalid_code')
    }
    const late = await client(s).post('/api/auth/verify-email', { login: 'carol_m13', password: PASSWORD, code })
    assert.equal(await errorCode(late), 'invalid_code')
  })

  test('signing up again (same username and address) replaces the password and sends a new code', async () => {
    await json(await signUp(s, 'dave@example.com', 'dave_m13', 'first-attempt-passphrase'), 202)
    await json(await signUp(s, 'dave@example.com', 'dave_m13', PASSWORD), 202)
    const code = await lastCode(s, 'dave@example.com')
    const oldPassword = await client(s).post('/api/auth/verify-email', {
      login: 'dave_m13',
      password: 'first-attempt-passphrase',
      code
    })
    assert.equal(await errorCode(oldPassword), 'invalid_code')
    await json(await client(s).post('/api/auth/verify-email', { login: 'dave_m13', password: PASSWORD, code }), 200)
  })

  test('an unconfirmed sign-up can’t hold an address hostage; only the inbox owner can confirm', async () => {
    // Someone signs up first with erin's address (they can't confirm: no access to the inbox).
    await json(await signUp(s, 'erin@example.com', 'mallory_m13', 'mallory-owns-this-now'), 202)
    s.mail.clear()
    // Erin signs up later: the unconfirmed sign-up gives way instead of blocking her for a day.
    await json(await signUp(s, 'erin@example.com', 'erin_m13'), 202)
    assert.equal(await s.repo.findUserByUsername('mallory_m13'), undefined)
    const code = await lastCode(s, 'erin@example.com')
    // Erin's code can't activate anyone else's account, and the other way round.
    const wrongPerson = await client(s).post('/api/auth/verify-email', { login: 'erin@example.com', password: 'mallory-owns-this-now', code })
    assert.equal(await errorCode(wrongPerson), 'invalid_code')
    await json(await client(s).post('/api/auth/verify-email', { login: 'erin_m13', password: PASSWORD, code }), 200)
    // Confirmed, the address is taken for real: a later sign-up only notifies its owner.
    s.mail.clear()
    await json(await signUp(s, 'erin@example.com', 'mallory_m13', 'mallory-owns-this-now'), 202)
    await s.ctx.mail.drain()
    assert.match(s.mail.to('erin@example.com')[0]!.subject, /already have/)
    assert.equal(await s.repo.findUserByUsername('mallory_m13'), undefined)
  })

  test('unconfirmed sign-ups are deleted after a day, freeing the username and address', async () => {
    await json(await signUp(s, 'frank@example.com', 'frank_m13'), 202)
    sql(s, 'UPDATE users SET created_at = ? WHERE username = ?', Date.now() - PENDING_SIGNUP_TTL_MS - 1000, 'frank_m13')
    const removed = await s.repo.purgeExpired(Date.now(), {
      sessionsMs: 30 * 86_400_000,
      auditMs: 365 * 86_400_000,
      pendingSignupMs: PENDING_SIGNUP_TTL_MS
    })
    assert.ok((removed.pendingSignups ?? 0) >= 1)
    assert.equal(await s.repo.findUserByUsername('frank_m13'), undefined)
    // Confirmed accounts are never touched by this cleanup.
    assert.ok(await s.repo.findUserByUsername('alice_m13'))
    await json(await signUp(s, 'frank@example.com', 'frank_m13'), 202)
  })

  test('audit and logs never contain codes, passwords or addresses', async () => {
    const db = new DatabaseSync(s.file)
    try {
      const rows = db.prepare('SELECT action, detail FROM audit_events').all() as { action: string; detail: string | null }[]
      const text = JSON.stringify(rows)
      assert.ok(rows.some((r) => r.action === 'auth.signup'))
      assert.ok(rows.some((r) => r.action === 'auth.email_verified'))
      assert.ok(!text.includes(PASSWORD))
      assert.ok(!text.includes('@example.com'), 'no addresses in the audit log')
      assert.ok(!/[0-9A-Z]{4}-[0-9A-Z]{4}/.test(text), 'no codes in the audit log')
      const codes = db.prepare('SELECT code_hash FROM email_codes').all() as { code_hash: string }[]
      assert.ok(codes.every((c) => /^[0-9a-f]{64}$/.test(c.code_hash)), 'only verifiers are stored')
    } finally {
      db.close()
    }
  })
})

// ======================================================================
describe('password reset by email', () => {
  let s: Server
  let account: ApiAuthResult
  before(async () => {
    s = await start()
    account = await signUpAndVerify(s, 'grace@example.com', 'grace_m13')
  })
  after(() => stop(s))

  test('known and unknown addresses get the same answer; only the account owner gets a code', async () => {
    s.mail.clear()
    const known = await client(s).post('/api/auth/forgot-password', { email: 'Grace@Example.com' })
    const unknown = await client(s).post('/api/auth/forgot-password', { email: 'nobody@example.com' })
    assert.deepEqual(await json(known, 202), await json(unknown, 202))
    await s.ctx.mail.drain()
    assert.equal(s.mail.to('nobody@example.com').length, 0)
    assert.match(s.mail.to('grace@example.com')[0]!.subject, /Reset/)
  })

  test('malformed, wrong, expired and reused codes are refused', async () => {
    const code = await lastCode(s, 'grace@example.com')
    for (const bad of ['', 'abc', 'ZZZZ-ZZZZ', `${code}X`]) {
      const res = await client(s).post('/api/auth/reset-password', {
        email: 'grace@example.com',
        code: bad,
        newPassword: NEW_PASSWORD
      })
      assert.equal(await errorCode(res), 'invalid_code', bad)
    }
    const weak = await client(s).post('/api/auth/reset-password', {
      email: 'grace@example.com',
      code,
      newPassword: 'grace_m13-pass'
    })
    assert.equal(await errorCode(weak), 'weak_password')

    // Expired.
    sql(s, "UPDATE email_codes SET expires_at = ? WHERE purpose = 'reset'", Date.now() - 1)
    const expired = await client(s).post('/api/auth/reset-password', { email: 'grace@example.com', code, newPassword: NEW_PASSWORD })
    assert.equal(await errorCode(expired), 'invalid_code')
  })

  test('a valid code sets the new password, signs out every device and works once', async () => {
    await json(await client(s).post('/api/auth/forgot-password', { email: 'grace@example.com' }), 202)
    const code = await lastCode(s, 'grace@example.com')
    const reset = await json<ApiAuthResult>(
      await client(s).post('/api/auth/reset-password', { email: 'grace@example.com', code, newPassword: NEW_PASSWORD }),
      200
    )
    assert.equal(reset.user.id, account.user.id)
    assert.equal((await client(s).req('/api/users/me', { token: account.token })).status, 401, 'old session revoked')
    assert.equal((await client(s).req('/api/users/me', { token: reset.token })).status, 200)
    const oldLogin = await client(s).post('/api/auth/login', { username: 'grace_m13', password: PASSWORD })
    assert.equal(oldLogin.status, 401)
    await json(await client(s).post('/api/auth/login', { username: 'grace_m13', password: NEW_PASSWORD }), 200)
    const reuse = await client(s).post('/api/auth/reset-password', { email: 'grace@example.com', code, newPassword: PASSWORD })
    assert.equal(await errorCode(reuse), 'invalid_code')
  })

  test('unknown addresses cost the same work; account names stay hidden until the code is right', async () => {
    const zed = await signUpAndVerify(s, 'ivan@example.com', 'zed_m13')
    const hasher = s.ctx.hasher
    const original = hasher.hash.bind(hasher)
    let hashes = 0
    hasher.hash = async (password: string) => {
      hashes++
      return original(password)
    }
    try {
      const unknown = await client(s).post('/api/auth/reset-password', {
        email: 'nobody@example.com',
        code: 'ABCD-EFGH',
        newPassword: NEW_PASSWORD
      })
      assert.equal(await errorCode(unknown), 'invalid_code')
      assert.equal(hashes, 1, 'the same hashing work as for a real account')
    } finally {
      hasher.hash = original
    }
    await json(await client(s).post('/api/auth/forgot-password', { email: 'ivan@example.com' }), 202)
    const code = await lastCode(s, 'ivan@example.com')
    // A password based on the username: with a wrong code, the usual answer (no hint)…
    const probe = await client(s).post('/api/auth/reset-password', { email: 'ivan@example.com', code: 'ABCD-EFGH', newPassword: 'zed_m13-pass' })
    assert.equal(await errorCode(probe), 'invalid_code')
    // …with the right one, the rule is explained and the code stays usable.
    const weak = await client(s).post('/api/auth/reset-password', { email: 'ivan@example.com', code, newPassword: 'zed_m13-pass' })
    assert.equal(await errorCode(weak), 'weak_password')
    const done = await json<ApiAuthResult>(
      await client(s).post('/api/auth/reset-password', { email: 'ivan@example.com', code, newPassword: NEW_PASSWORD }),
      200
    )
    assert.equal(done.user.id, zed.user.id)
  })

  test('accounts without a confirmed address, and disabled accounts, get no reset code', async () => {
    await json(await signUp(s, 'heidi@example.com', 'heidi_m13'), 202)
    s.mail.clear()
    await json(await client(s).post('/api/auth/forgot-password', { email: 'heidi@example.com' }), 202)
    await s.ctx.mail.drain()
    assert.equal(s.mail.to('heidi@example.com').length, 0, 'pending sign-up: no reset')

    await s.repo.setUserDisabled(account.user.id, Date.now())
    await json(await client(s).post('/api/auth/forgot-password', { email: 'grace@example.com' }), 202)
    await s.ctx.mail.drain()
    assert.equal(s.mail.to('grace@example.com').length, 0, 'disabled: no reset')
    await s.repo.setUserDisabled(account.user.id, null)
  })

  test('email delivery failures never break the response', async () => {
    s.mail.failWith = new Error('relay down')
    try {
      await json(await client(s).post('/api/auth/forgot-password', { email: 'grace@example.com' }), 202)
      await s.ctx.mail.drain()
    } finally {
      s.mail.failWith = null
    }
  })
})

// ======================================================================
describe('adding an address to an existing account', () => {
  let s: Server
  let token = ''
  before(async () => {
    s = await start({ REGISTRATION_MODE: 'invite' })
    const now = Date.now()
    await s.repo.provisionAccount(
      { id: 'u-ivan', username: 'ivan', displayName: 'Ivan', avatarColor: '#222222', bot: false, createdAt: now },
      await HASHER.hash(PASSWORD),
      now
    )
    token = (await json<ApiAuthResult>(await client(s).post('/api/auth/login', { username: 'ivan', password: PASSWORD }), 200)).token
  })
  after(() => stop(s))

  test('needs the current password, then a code sent to the new address', async () => {
    const status = await json<{ email: string | null; verified: boolean }>(await client(s).req('/api/auth/email', { token }), 200)
    assert.deepEqual(status, { email: null, verified: false })
    const wrong = await client(s).post('/api/auth/email', { email: 'ivan@example.com', password: 'wrong-password-00' }, token)
    assert.equal(await errorCode(wrong), 'wrong_password')
    await json(await client(s).post('/api/auth/email', { email: 'Ivan@Example.com', password: PASSWORD }, token), 202)
    const code = await lastCode(s, 'ivan@example.com')
    const bad = await client(s).post('/api/auth/email/verify', { code: 'ZZZZ-ZZZZ' }, token)
    assert.equal(await errorCode(bad), 'invalid_code')
    const ok = await json<{ email: string; verified: boolean }>(await client(s).post('/api/auth/email/verify', { code }, token), 200)
    assert.deepEqual(ok, { email: 'ivan@example.com', verified: true })
    const me = await json<ApiMe>(await client(s).req('/api/users/me', { token }), 200)
    assert.equal(me.email, 'ivan@example.com')
    // Password reset by email now works for this invite-registered account.
    await json(await client(s).post('/api/auth/forgot-password', { email: 'ivan@example.com' }), 202)
    assert.match(s.mail.to('ivan@example.com').at(-1)!.subject, /Reset/)
  })

  test("someone else's address is never confirmed (its owner gets a notice)", async () => {
    const now = Date.now()
    await s.repo.provisionAccount(
      { id: 'u-judy', username: 'judy', displayName: 'Judy', avatarColor: '#333333', bot: false, createdAt: now },
      await HASHER.hash(PASSWORD),
      now
    )
    const judy = (await json<ApiAuthResult>(await client(s).post('/api/auth/login', { username: 'judy', password: PASSWORD }), 200)).token
    s.mail.clear()
    await json(await client(s).post('/api/auth/email', { email: 'ivan@example.com', password: PASSWORD }, judy), 202)
    await s.ctx.mail.drain()
    assert.match(s.mail.to('ivan@example.com')[0]!.subject, /already have/)
    const attempt = await client(s).post('/api/auth/email/verify', { code: 'AAAA-AAAA' }, judy)
    assert.equal(await errorCode(attempt), 'invalid_code')
  })

  test('an unconfirmed sign-up holding the address doesn’t stop its real owner adding it', async () => {
    const now = Date.now()
    sql(
      s,
      "INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, email, signup_pending) VALUES ('u-squat', 'squatter', 'Squatter', '#444444', 0, ?, 'kim@example.com', 1)",
      now
    )
    await s.repo.provisionAccount(
      { id: 'u-kim', username: 'kim', displayName: 'Kim', avatarColor: '#555555', bot: false, createdAt: now },
      await HASHER.hash(PASSWORD),
      now
    )
    const kim = (await json<ApiAuthResult>(await client(s).post('/api/auth/login', { username: 'kim', password: PASSWORD }), 200)).token
    await json(await client(s).post('/api/auth/email', { email: 'kim@example.com', password: PASSWORD }, kim), 202)
    const code = await lastCode(s, 'kim@example.com')
    assert.deepEqual(await json(await client(s).post('/api/auth/email/verify', { code }, kim), 200), {
      email: 'kim@example.com',
      verified: true
    })
    assert.equal(await s.repo.getUser('u-squat'), undefined, 'the unconfirmed sign-up gave way')
  })

  test('removing the address needs the password', async () => {
    const wrong = await client(s).post('/api/auth/email/remove', { password: 'wrong-password-00' }, token)
    assert.equal(await errorCode(wrong), 'wrong_password')
    assert.deepEqual(await json(await client(s).post('/api/auth/email/remove', { password: PASSWORD }, token), 200), {
      email: null,
      verified: false
    })
    assert.equal((await s.repo.getUser('u-ivan'))?.email, null)
  })
})

// ======================================================================
describe('migration v6 (email accounts)', () => {
  test('a Milestone 11/12 database upgrades with nothing lost, and the rollback step is safe', async () => {
    const { sqliteMigrations } = await import('../src/db/migrations.js')
    const file = join(dir, 'm12.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    for (const m of sqliteMigrations.filter((x) => x.version <= 5)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 1)
    }
    const hash = await HASHER.hash(PASSWORD)
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, instance_admin) VALUES ('u1', 'owner', 'Owner', '#6d72f6', 0, 1000, 1)").run()
    db.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES ('u2', 'friend', 'Friend', '#3ba776', 0, 2000)").run()
    db.prepare('INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, 1, 1)').run('u1', hash)
    db.prepare("INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES ('s1', 'Home', '#111111', 'u1', 0, 1)").run()
    db.prepare("INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ('s1', 'u1', 'owner', 1), ('s1', 'u2', 'member', 1)").run()
    db.prepare("INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES ('c1', 's1', 'general', 'text', NULL, 'Text', 0, 1)").run()
    db.prepare("INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ('c1', 'u2', 'hello from M12', 5)").run()
    db.close()

    const repo = new SqliteRepository(file)
    await repo.migrate()
    await repo.migrate() // repeat: no-op
    const owner = await repo.getUser('u1')
    assert.equal(owner?.instanceAdmin, true)
    assert.equal(owner?.email, null)
    assert.equal(owner?.signupPending, false, 'existing accounts are never "pending"')
    assert.equal(await repo.getPasswordHash('u1'), hash)
    assert.equal((await repo.listMessages('c1', { limit: 10 }))[0]?.content, 'hello from M12')

    // New features work on the upgraded database; addresses are unique.
    assert.equal(await repo.confirmEmail('u1', 'owner@example.com', 10, null), 'ok')
    assert.equal(await repo.confirmEmail('u2', 'owner@example.com', 11, null), 'email_taken')
    assert.equal((await repo.findUserByEmail('owner@example.com'))?.id, 'u1')

    const raw = (repo as unknown as { db: DatabaseSync }).db
    assert.throws(() => raw.prepare("UPDATE users SET email = 'owner@example.com' WHERE id = 'u2'").run(), /UNIQUE/)
    const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version))
    assert.deepEqual(versions, sqliteMigrations.map((m) => m.version))
    assert.ok(versions.includes(6))

    // Documented rollback preparation: unconfirmed sign-ups are removed before running older
    // code (which doesn't know they must not sign in). Confirmed data is untouched.
    raw.prepare("INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, email, signup_pending) VALUES ('p1', 'pending', 'P', '#000000', 0, 3000, 'p@example.com', 1)").run()
    raw.prepare('INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, 1, 1)').run('p1', hash)
    raw.exec('DELETE FROM users WHERE signup_pending = 1')
    assert.equal(await repo.getUser('p1'), undefined)
    assert.equal(await repo.getPasswordHash('p1'), undefined, 'credentials cascade')
    assert.ok(await repo.getUser('u2'))
    assert.equal(raw.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0)
    await repo.close()
  })
})

// ======================================================================
describe('email rate limits', () => {
  test('per-address budget applies to unknown addresses too (no enumeration by 429)', async () => {
    const s = await start({}, ['emailsPerAddress'])
    try {
      const codes: number[] = []
      for (let i = 0; i < 4; i++) {
        codes.push((await client(s).post('/api/auth/forgot-password', { email: 'unknown@example.com' })).status)
      }
      assert.deepEqual(codes, [202, 202, 202, 429])

      await json(await signUp(s, 'kim@example.com', 'kim_m13'), 202)
      await json(await client(s).post('/api/auth/resend-verification', { login: 'kim_m13', password: PASSWORD }), 202)
      await json(await client(s).post('/api/auth/resend-verification', { login: 'kim_m13', password: PASSWORD }), 202)
      // The fourth email to kim@example.com in a short time is refused.
      const limited = await client(s).post('/api/auth/resend-verification', { login: 'kim@example.com', password: PASSWORD })
      assert.equal(limited.status, 429)
    } finally {
      await stop(s)
    }
  })

  test('sign-ups per IP address are limited', async () => {
    const s = await start({}, ['signupPerIp'])
    try {
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) statuses.push((await signUp(s, `p${i}@example.com`, `person_${i}`)).status)
      assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429])
    } finally {
      await stop(s)
    }
  })
})
