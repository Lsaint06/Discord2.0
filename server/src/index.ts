import { buildApp } from './app.js'
import { assertArgon2Available } from './auth/password.js'
import { isLoopbackHost, loadConfig } from './config.js'
import { seedIfEmpty } from './db/seed.js'
import { createRepository } from './db/sqlite.js'

assertArgon2Available()
const config = loadConfig()
const repo = createRepository(config.databaseUrl)
await repo.migrate()
const seeded = await seedIfEmpty(repo)

const { app } = await buildApp(config, repo)

if (seeded) app.log.info('Seeded a fresh database with starter servers')
if (config.livekit) {
  app.log.info({ livekit: config.livekit.publicUrl, lan: config.livekit.lanUrl }, 'Voice enabled (LiveKit)')
} else {
  app.log.info('Voice disabled: LIVEKIT_* variables are not set')
}
if (config.devAuth) {
  app.log.warn(
    'DEV_AUTH is enabled: anyone who can reach this server can sign in as any username that has no password (development identities). Password accounts are unaffected. Turn it off (DEV_AUTH=false) once everyone has claimed or created an account.'
  )
}
{
  const report = await repo.integrityReport()
  if (report.accounts === 0) {
    app.log.warn(
      'No password accounts yet. Create the first administrator locally: npm run admin -- create-admin --username <name> (Docker: docker compose exec server node dist/cli/admin.js create-admin --username <name>)'
    )
  }
  if (report.legacyIdentities > 0) {
    app.log.info({ legacyIdentities: report.legacyIdentities }, 'development identities waiting to be claimed (admin: legacy list)')
  }
}
if (config.trustProxy) {
  app.log.info({ trustProxy: config.trustProxy }, 'Client IPs are taken from X-Forwarded-For only when the request comes from these proxies')
}
if (!isLoopbackHost(config.host)) {
  app.log.warn(
    { host: config.host },
    'Listening on a non-loopback address. Only do this on a trusted LAN or behind a TLS reverse proxy, never directly on the public internet.'
  )
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    await repo.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error({ err }, 'failed to start')
  await repo.close()
  process.exit(1)
}
