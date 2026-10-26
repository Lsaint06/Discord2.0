import { buildApp } from './app.js'
import { isLoopbackHost, loadConfig } from './config.js'
import { seedIfEmpty } from './db/seed.js'
import { createRepository } from './db/sqlite.js'

const config = loadConfig()
const repo = createRepository(config.databaseUrl)
await repo.migrate()
const seeded = await seedIfEmpty(repo)

const { app } = await buildApp(config, repo)

if (seeded) app.log.info('Seeded a fresh database with starter servers')
if (config.devAuth) {
  app.log.warn(
    'DEV_AUTH is enabled: anyone who can reach this server can sign in as any username. Development only.'
  )
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
