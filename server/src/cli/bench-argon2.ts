/**
 * Measures Argon2id cost on this machine (run it on the Jetson):
 *   docker compose exec server node dist/cli/bench-argon2.js
 * Aim for roughly 100-500 ms per hash at the chosen settings; set ARGON2_* in .env.
 */
import { cpus, totalmem } from 'node:os'
import { HashGate, PasswordHasher, type Argon2Params } from '../auth/password.js'
import { loadConfig } from '../config.js'

const candidates: Argon2Params[] = [
  { memoryKiB: 19_456, passes: 2, parallelism: 1 },
  { memoryKiB: 47_104, passes: 1, parallelism: 1 },
  { memoryKiB: 65_536, passes: 3, parallelism: 1 },
  { memoryKiB: 65_536, passes: 3, parallelism: 4 }
]

async function time(hasher: PasswordHasher, runs: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await hasher.hash('correct horse battery staple')
    out.push(performance.now() - start)
  }
  return out
}

const configured = loadConfig().auth
console.log(`${process.platform}/${process.arch}, ${cpus().length} CPUs (${cpus()[0]?.model ?? 'unknown'}), ${Math.round(totalmem() / 2 ** 20)} MiB RAM, Node ${process.version}, OpenSSL ${process.versions.openssl}`)
console.log(`Configured: m=${configured.argon2.memoryKiB} KiB, t=${configured.argon2.passes}, p=${configured.argon2.parallelism}, max ${configured.hashConcurrency} concurrent\n`)
for (const params of candidates) {
  const hasher = new PasswordHasher(params, new HashGate(8, 64))
  await time(hasher, 1) // warm-up
  const runs = await time(hasher, 5)
  const median = [...runs].sort((a, b) => a - b)[2]!
  console.log(`m=${String(params.memoryKiB).padStart(6)} KiB t=${params.passes} p=${params.parallelism}: median ${median.toFixed(0)} ms  (${runs.map((r) => r.toFixed(0)).join(', ')})`)
}
const hasher = new PasswordHasher(configured.argon2, new HashGate(configured.hashConcurrency, 64))
const start = performance.now()
await Promise.all(Array.from({ length: 10 }, () => hasher.hash('burst')))
console.log(`\n10 simultaneous sign-ins at the configured settings: ${(performance.now() - start).toFixed(0)} ms total`)
