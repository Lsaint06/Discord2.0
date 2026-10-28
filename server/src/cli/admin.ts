/**
 * Local administration for Discord 2.0. Runs on the server machine against the same database
 * (there is no HTTP endpoint for bootstrapping an administrator).
 *
 *   Development:  npm run admin -- <command>
 *   Docker:       docker compose exec server node dist/cli/admin.js <command>
 *
 * Passwords are read from a hidden prompt (or one line on stdin), never from arguments.
 */
import { randomUUID } from 'node:crypto'
import { PasswordHasher } from '../auth/password.js'
import { normalizePassword, passwordProblem } from '../auth/passwordPolicy.js'
import { CODE_LENGTHS, codeGroups, codeVerifier, newCode, normalizeCode } from '../auth/secrets.js'
import { loadConfig } from '../config.js'
import type { AuditRecord, Repository, UserRecord } from '../db/repository.js'
import { RepositoryConflict } from '../db/repository.js'
import { createRepository } from '../db/sqlite.js'
import { seedIfEmpty } from '../db/seed.js'
import { colorForName, normalizeDisplayName, normalizeUsername } from '../lib/validation.js'
import { LIMITS } from '../protocol.js'
import { issueRegistrationCode, issueResetCode } from '../routes/admin.js'

const HELP = `Discord 2.0 administration (local only)

Usage: admin <command> [options]

Accounts
  create-admin --username <name> [--display-name <name>] [--own-unowned-servers]
        Create the first administrator, or turn an existing development identity
        (e.g. your own) into a password account with administrator rights.
        Prompts for the password. Prints recovery codes once.
  promote <username>            Make an existing password account an administrator.
  reset-code <username>         One-time password reset code (24 h) for a password account.
  revoke-sessions <username>    Sign a user out everywhere.

Invitations
  registration-invite [--hours 72] [--server <serverId>] [--note <text>]
        Single-use code to create a new account (optionally joining a server).

Legacy development identities
  legacy list                   Identities without a password, with their data.
  legacy claim-code <username> [--hours 72]
        Single-use code that lets the right person set a password on that identity,
        keeping its user id, messages, files, reactions and read state.
  legacy merge <from> <into> [--apply]
        Move everything from identity <from> into account <into>. Dry run unless --apply.

Servers
  set-owner <serverId> <username>   Emergency ownership recovery.

Maintenance
  verify                        Integrity and migration report (exit code 1 on problems).
  status                        Short summary.
`

function args(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next)
        i++
      } else {
        flags.set(a.slice(2), true)
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function flag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name)
  return typeof v === 'string' ? v : undefined
}

function hours(flags: Map<string, string | true>, fallback: number): number {
  const raw = flag(flags, 'hours')
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 24 * 14) throw new Error('--hours must be 1-336')
  return n
}

let stdinLines: string[] | null = null
async function readStdinLine(): Promise<string> {
  if (stdinLines === null) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  }
  return stdinLines.shift() ?? ''
}

/** Reads a secret without echoing it (TTY), or one line from piped stdin. */
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return readStdinLine()
  process.stdout.write(question)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let value = ''
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function askNewPassword(context: { username: string; displayName?: string }): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await promptHidden(`New password (at least ${LIMITS.passwordMinLength} characters): `)
    const problem = passwordProblem(first, context)
    if (problem) {
      console.error(`  ${problem}`)
      if (!process.stdin.isTTY) break
      continue
    }
    if (process.stdin.isTTY) {
      const second = await promptHidden('Repeat password: ')
      if (second !== first) {
        console.error('  Passwords did not match.')
        continue
      }
    }
    return normalizePassword(first)
  }
  throw new Error('No acceptable password entered.')
}

async function audit(repo: Repository, entry: Omit<AuditRecord, 'at' | 'ip'>): Promise<void> {
  await repo.addAuditEvent({ ...entry, at: Date.now(), ip: 'local-cli' })
}

async function userByName(repo: Repository, name: string | undefined): Promise<UserRecord> {
  if (!name) throw new Error('Missing username.')
  const user = await repo.findUserByUsername(normalizeUsername(name))
  if (!user) throw new Error(`No user named "${name}".`)
  return user
}

function printCode(label: string, code: string, extra?: string): void {
  console.log(`\n${label}:\n\n    ${code}\n`)
  if (extra) console.log(extra)
  console.log('Share it privately (in person or a direct message). It is shown only once.')
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP)
    return 0
  }
  const { positional, flags } = args(rest)
  const config = loadConfig()
  const repo = createRepository(config.databaseUrl)
  await repo.migrate()
  try {
    switch (command) {
      case 'create-admin': {
        const username = normalizeUsername(flag(flags, 'username'))
        const existing = await repo.findUserByUsername(username)
        if (existing?.bot) throw new Error('That username belongs to a bot.')
        const displayName = flag(flags, 'display-name')
          ? normalizeDisplayName(flag(flags, 'display-name'))
          : (existing?.displayName ?? normalizeDisplayName(username))
        if (existing) {
          console.log(
            (await repo.hasPassword([existing.id])).has(existing.id)
              ? `"${username}" already has a password; it will be replaced and the account made an administrator.`
              : `"${username}" is an existing development identity; it will become your administrator account (same user id and history).`
          )
        }
        const password = await askNewPassword({ username, displayName })
        const hasher = new PasswordHasher(config.auth.argon2)
        const now = Date.now()
        const user = await repo.provisionAccount(
          {
            id: randomUUID(),
            username,
            displayName,
            avatarColor: colorForName(username),
            bot: false,
            createdAt: now,
            instanceAdmin: true,
            disabledAt: null
          },
          await hasher.hash(password),
          now
        )
        const codes = Array.from({ length: LIMITS.recoveryCodeCount }, () => newCode(codeGroups('recovery')))
        await repo.replaceRecoveryCodes(
          user.id,
          codes.map((c) => codeVerifier('recovery', normalizeCode(c, CODE_LENGTHS.recovery)!)),
          now
        )
        await audit(repo, { action: 'admin.provision', actorId: null, targetUserId: user.id, serverId: null, detail: { username } })
        if (flags.has('own-unowned-servers')) {
          // A brand-new database gets the same starter servers the backend would create.
          await seedIfEmpty(repo)
          const report = await repo.integrityReport()
          for (const serverId of report.serversWithoutOwner) {
            await repo.setOwner(serverId, user.id, now)
            await audit(repo, { action: 'admin.set_owner', actorId: null, targetUserId: user.id, serverId, detail: null })
            console.log(`Now owner of server ${serverId}.`)
          }
        }
        console.log(`\nAdministrator "${user.username}" is ready. Sign in with this password in the app.`)
        console.log('\nRecovery codes (each works once if you forget your password; store them safely):\n')
        for (const c of codes) console.log(`    ${c}`)
        console.log('')
        return 0
      }

      case 'promote': {
        const user = await userByName(repo, positional[0])
        if (!(await repo.hasPassword([user.id])).has(user.id)) {
          throw new Error('Only password accounts can be administrators. Claim the identity first.')
        }
        await repo.setInstanceAdmin(user.id, true)
        await audit(repo, { action: 'admin.provision', actorId: null, targetUserId: user.id, serverId: null, detail: { promote: true } })
        console.log(`${user.username} is now an administrator.`)
        return 0
      }

      case 'reset-code': {
        const user = await userByName(repo, positional[0])
        if (!(await repo.hasPassword([user.id])).has(user.id)) {
          throw new Error('This identity has no password yet. Use "legacy claim-code" instead.')
        }
        const code = await issueResetCode({ repo }, user.id, null)
        await audit(repo, { action: 'admin.reset_code_created', actorId: null, targetUserId: user.id, serverId: null, detail: null })
        printCode(`Password reset code for ${user.username} (valid 24 hours)`, code, 'They enter it under “Forgot your password?” in the app.')
        return 0
      }

      case 'revoke-sessions': {
        const user = await userByName(repo, positional[0])
        const revoked = await repo.revokeUserSessions(user.id, Date.now())
        await audit(repo, { action: 'auth.logout_all', actorId: null, targetUserId: user.id, serverId: null, detail: { revoked: revoked.length } })
        console.log(`Revoked ${revoked.length} session(s). Connected clients are disconnected within 5 minutes (immediately via the app).`)
        return 0
      }

      case 'registration-invite': {
        const serverId = flag(flags, 'server') ?? null
        if (serverId && !(await repo.getServer(serverId))) throw new Error(`No server with id "${serverId}".`)
        const h = hours(flags, 72)
        const { invite, code } = await issueRegistrationCode(
          { repo },
          { kind: 'register', serverId, note: flag(flags, 'note'), createdBy: null, expiresInHours: h }
        )
        await audit(repo, { action: 'admin.registration_invite_created', actorId: null, targetUserId: null, serverId, detail: { inviteId: invite.id } })
        printCode(`Registration code (single use, valid ${h} hours)`, code, 'They choose “Create an account” in the app and enter it.')
        return 0
      }

      case 'legacy': {
        const sub = positional[0]
        if (sub === 'list') {
          const list = await repo.listLegacyIdentities()
          if (list.length === 0) {
            console.log('No unclaimed development identities.')
            return 0
          }
          console.log('username             messages  files  reactions  last seen            claim code')
          for (const l of list) {
            console.log(
              `${l.user.username.padEnd(20)} ${String(l.messages).padStart(8)}  ${String(l.attachments).padStart(5)}  ${String(l.reactions).padStart(9)}  ${(l.lastSeenAt ? new Date(l.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ') : '-').padEnd(19)}  ${l.openClaimCode ? 'open' : '-'}`
            )
          }
          return 0
        }
        if (sub === 'claim-code') {
          const user = await userByName(repo, positional[1])
          if (user.bot) throw new Error('Bots cannot be claimed.')
          if ((await repo.hasPassword([user.id])).has(user.id)) throw new Error('Already claimed.')
          const h = hours(flags, 72)
          const { invite, code } = await issueRegistrationCode(
            { repo },
            { kind: 'claim', claimUserId: user.id, createdBy: null, expiresInHours: h }
          )
          await audit(repo, { action: 'admin.claim_code_created', actorId: null, targetUserId: user.id, serverId: null, detail: { inviteId: invite.id } })
          printCode(
            `Claim code for "${user.username}" (single use, valid ${h} hours)`,
            code,
            'Give it ONLY to the person who used this identity. They choose “Create an account”,\nenter the code and set a password; their history stays. Earlier claim codes for\nthis identity are revoked.'
          )
          return 0
        }
        if (sub === 'merge') {
          const from = await userByName(repo, positional[1])
          const into = await userByName(repo, positional[2])
          const apply = flags.has('apply')
          let report
          try {
            report = await repo.mergeUsers(from.id, into.id, !apply)
          } catch (err) {
            if (err instanceof RepositoryConflict) throw new Error(`Cannot merge: ${err.reason}`)
            throw err
          }
          console.log(JSON.stringify(report, null, 2))
          if (apply) {
            await audit(repo, { action: 'admin.merge', actorId: null, targetUserId: into.id, serverId: null, detail: { from: from.username, into: into.username } })
            console.log(`\nMerged "${from.username}" into "${into.username}". Run "verify" to check.`)
          } else {
            console.log('\nDry run only. Re-run with --apply to perform the merge (back up first).')
          }
          return 0
        }
        throw new Error('Usage: legacy list | legacy claim-code <username> | legacy merge <from> <into> [--apply]')
      }

      case 'set-owner': {
        const serverId = positional[0]
        if (!serverId || !(await repo.getServer(serverId))) throw new Error('Unknown server id.')
        const user = await userByName(repo, positional[1])
        if (user.bot) throw new Error('Bots cannot own servers.')
        await repo.setOwner(serverId, user.id, Date.now())
        await audit(repo, { action: 'admin.set_owner', actorId: null, targetUserId: user.id, serverId, detail: null })
        console.log(`${user.username} now owns ${serverId}; any previous owner is an admin.`)
        return 0
      }

      case 'verify':
      case 'status': {
        const report = await repo.integrityReport()
        if (command === 'status') {
          console.log(
            `users ${report.users} (accounts ${report.accounts}, legacy ${report.legacyIdentities}, bots ${report.bots}), messages ${report.messages}, attachments ${report.attachments}, memberships ${report.memberships}`
          )
          return 0
        }
        console.log(JSON.stringify(report, null, 2))
        const orphanCount = Object.values(report.orphans).reduce((a, b) => a + b, 0)
        const ok =
          report.integrityCheck === 'ok' &&
          report.foreignKeyViolations === 0 &&
          orphanCount === 0 &&
          report.directContainerMembers === 0
        if (report.directContainerMembers > 0) {
          console.log('\nSECURITY: someone is a member of the private conversation container. Restore a backup.')
        }
        console.log(ok ? '\nOK: no integrity problems found.' : '\nPROBLEMS FOUND (see above).')
        if (report.serversWithoutOwner.length > 0) {
          console.log(`Note: ${report.serversWithoutOwner.length} server(s) have no owner. Use "create-admin --own-unowned-servers" or "set-owner".`)
        }
        return ok ? 0 : 1
      }

      default:
        console.error(`Unknown command "${command}".\n`)
        console.log(HELP)
        return 2
    }
  } finally {
    await repo.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
)
