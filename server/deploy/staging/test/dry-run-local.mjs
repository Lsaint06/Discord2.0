// Local dry run of the staging migration rehearsal: no Docker, no Jetson, no network beyond
// loopback. It runs the SAME tools in the SAME order as docs/v1.4.0-staging-plan.md, with the two
// server builds started directly on 127.0.0.1:3451 against a disposable data folder:
//
//   old server (API 4) -> owner via admin CLI -> seed api4 -> snapshot s0 -> backup + verify
//   -> new server (API 6, migrations) -> verify, snapshot s1, compare s0/s1 (upgrade)
//   -> R1: old server on the migrated data -> verify, snapshot s2, compare s0/s2, 20 writes
//   -> roll forward -> 20 writes, verify -> seed api6 -> animated-image benchmark
//   -> R3: restore the backup -> old server -> snapshot s3, compare s0/s3 (strict)
//
// node dry-run-local.mjs <oldServerDir> <newServerDir> <emptyWorkDir>
//   oldServerDir: a build of production's commit (git archive 86831b4 server; npm ci; npm run build)
//   newServerDir: this repository's server folder after `npm run build`
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [oldDir, newDir, work] = process.argv.slice(2).map((p) => p && resolve(p))
if (!work) throw new Error('usage: node dry-run-local.mjs <oldServerDir> <newServerDir> <emptyWorkDir>')
if (existsSync(work) && readdirSync(work).length) throw new Error(`${work} must be empty`)
const tools = join(import.meta.dirname, '..', 'tools')
const data = join(work, 'data')
mkdirSync(data, { recursive: true })
const PORT = 3451
const BASE = `http://127.0.0.1:${PORT}`
const pwFile = join(work, 'synthetic-password')
writeFileSync(pwFile, randomBytes(18).toString('base64url') + '\n', { mode: 0o600 })
const state = join(work, 'state.json')
const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  DEV_AUTH: 'false',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  DATABASE_URL: `sqlite:${join(data, 'discord2.db')}`,
  LOG_LEVEL: 'warn'
}
const toolEnv = { ...process.env, D2_SYNTHETIC_PASSWORD_FILE: pwFile, D2_SHARP_FROM: join(newDir, 'package.json') }
const summary = { startedAt: new Date().toISOString(), steps: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(name, ok, detail) {
  summary.steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`)
  if (!ok) {
    writeFileSync(join(work, 'dry-run-summary.json'), JSON.stringify(summary, null, 1))
    throw new Error(`step failed: ${name}`)
  }
}

let server = null
async function start(dir, label) {
  server = spawn(process.execPath, ['dist/index.js'], { cwd: dir, env: serverEnv, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  server.stderr.on('data', (d) => (err += d))
  for (let i = 0; i < 100; i++) {
    await sleep(150)
    const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json(), () => null)
    if (meta) return record(`start ${label}`, true, { apiVersion: meta.apiVersion })
  }
  record(`start ${label}`, false, err.slice(0, 400))
}
async function stop() {
  if (!server) return
  const s = server
  server = null
  s.kill()
  await new Promise((r) => s.once('exit', r))
  await sleep(300)
}

function node(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const tool = (script, ...args) => node([join(tools, script), ...args], { env: toolEnv })
const lastJson = (text) => JSON.parse(text.slice(text.lastIndexOf('\n{') + 1 || text.indexOf('{')))
const cli = (dir, args, input) => node([join(dir, 'dist', 'cli', 'admin.js'), ...args], { cwd: dir, env: serverEnv, input })
const dbstats = (file) => JSON.parse(node([join(tools, 'dbstats.cjs'), file]).out)
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const tar = (args) => spawnSync('tar', args, { encoding: 'utf8' })

try {
  // ---- API 4: production's code on an empty volume ----
  await start(oldDir, 'old server (production code) on empty data')
  const owner = cli(oldDir, ['create-admin', '--username', 'owner', '--own-unowned-servers'], readFileSync(pwFile, 'utf8'))
  record('owner created with the old admin CLI', owner.code === 0, owner.code === 0 ? undefined : owner.err.slice(0, 300))
  let r = tool('seed-api4.mjs', BASE, state)
  record('seed api4 (synthetic)', r.code === 0, r.code === 0 ? JSON.parse(r.out) : r.err.slice(0, 400))
  r = tool('seed-api4.mjs', BASE, join(work, 'state-again.json'))
  record('seed api4 refuses a non-empty server', r.code !== 0 && /only the owner account/.test(r.err))
  r = tool('snapshot.mjs', BASE, state, join(work, 'snap-s0.json'))
  record('snapshot s0 (API 4)', r.code === 0, r.code === 0 ? JSON.parse(r.out) : r.err.slice(0, 400))
  await stop()
  const before = dbstats(join(data, 'discord2.db'))
  record('database at migrations 1-5 like production', before.migrations.length === 5 && before.integrity === 'ok', before.migrations)

  // ---- Backup (server stopped) and verify on a scratch copy with the OLD code ----
  const backup = join(work, 'backup-pre.tgz')
  const t = tar(['-czf', backup, '-C', data, '.'])
  record('backup archive', t.status === 0, t.status === 0 ? { bytes: readFileSync(backup).length, sha256: sha(backup) } : t.stderr)
  const scratch = join(work, 'verify-scratch')
  mkdirSync(scratch)
  tar(['-xzf', backup, '-C', scratch])
  r = node([join(oldDir, 'dist', 'cli', 'admin.js'), 'verify'], { cwd: oldDir, env: { ...serverEnv, DATABASE_URL: `sqlite:${join(scratch, 'discord2.db')}` } })
  record('backup verified by the old admin CLI', r.code === 0 && /OK: no integrity problems/.test(r.out), r.out.split('\n').pop())
  rmSync(scratch, { recursive: true, force: true })

  // ---- Upgrade to API 6 ----
  await start(newDir, 'new server (v1.4.0): migrations 6-12')
  r = cli(newDir, ['verify'])
  record('admin verify after the upgrade', r.code === 0 && /OK: no integrity problems/.test(r.out), r.out.split('\n').pop())
  r = tool('snapshot.mjs', BASE, state, join(work, 'snap-s1.json'))
  record('snapshot s1 (API 6, same sessions)', r.code === 0, r.code === 0 ? JSON.parse(r.out) : r.err.slice(0, 400))
  r = tool('compare.mjs', join(work, 'snap-s0.json'), join(work, 'snap-s1.json'), 'upgrade')
  const upgradeCompare = lastJson(r.out)
  record('compare s0 -> s1 (upgrade): only the intended changes', r.code === 0, {
    valuesCompared: upgradeCompare.valuesCompared,
    failures: upgradeCompare.failures,
    expectedDifferences: upgradeCompare.expectedDifferences
  })
  r = tool('compare.mjs', join(work, 'snap-s0.json'), join(work, 'snap-s1.json'), 'strict')
  record('strict mode does flag those intended changes (the check is not blind)', r.code !== 0 && lastJson(r.out).failures > 0)
  await stop()
  const after = dbstats(join(data, 'discord2.db'))
  const lost = Object.entries(before.counts).filter(([table, n]) => (after.counts[table] ?? -1) < n)
  record('migrations 1-12, integrity ok, no rows lost, triggers kept', after.migrations.length === 12 && after.integrity === 'ok' && after.foreignKeyViolations === 0 && lost.length === 0 && before.triggers.every((x) => after.triggers.includes(x)), {
    migrations: after.migrations.length,
    newTables: Object.keys(after.counts).filter((x) => !(x in before.counts)),
    lost
  })

  // ---- R1: old code on the migrated data ----
  await start(oldDir, 'R1: old server on the migrated data')
  r = cli(oldDir, ['verify'])
  record('R1 admin verify (old CLI)', r.code === 0 && /OK: no integrity problems/.test(r.out), r.out.split('\n').pop())
  r = tool('snapshot.mjs', BASE, state, join(work, 'snap-s2.json'))
  record('snapshot s2 (R1)', r.code === 0, r.code === 0 ? JSON.parse(r.out) : r.err.slice(0, 400))
  r = tool('compare.mjs', join(work, 'snap-s0.json'), join(work, 'snap-s2.json'), 'upgrade')
  record('compare s0 -> s2 (R1): nothing lost', r.code === 0, { failures: lastJson(r.out).failures, expected: lastJson(r.out).expectedDifferences })
  r = tool('writes.mjs', BASE, state, 'r1')
  record('R1: 20 write operations on old code', r.code === 0, { failed: lastJson(r.out).failed, operations: lastJson(r.out).operations })
  await stop()

  // ---- Roll forward, then the API 6 data ----
  await start(newDir, 'roll forward to v1.4.0')
  r = tool('writes.mjs', BASE, state, 'fwd')
  record('roll forward: 20 write operations', r.code === 0, { failed: lastJson(r.out).failed })
  r = cli(newDir, ['verify'])
  record('admin verify after roll forward', r.code === 0 && /OK: no integrity problems/.test(r.out))
  r = tool('seed-api6.mjs', BASE, state)
  record('seed api6 (profile styles, animated avatar, themes, saved, note, soundboard)', r.code === 0, r.code === 0 ? JSON.parse(r.out) : r.err.slice(0, 400))
  r = tool('bench-animated.mjs', BASE, state)
  const bench = r.code === 0 ? lastJson(r.out).results : null
  record('animated-image benchmark: every worst case uploaded and timed (numbers are for THIS PC only)', r.code === 0 && bench.filter((x) => x.ok).length >= 5, bench ? bench.map((x) => `${x.label}: ${x.ms} ms${x.inputMB ? ` (${x.inputMB} MB)` : ''}`) : r.err.slice(0, 400) || r.out.slice(-400))
  await stop()
  const clips = readdirSync(join(data, 'attachments', 'soundboard')).filter((f) => f.endsWith('.wav'))
  record('soundboard clips stored on the data volume', clips.length === 2, clips.length)

  // ---- R3: restore the pre-upgrade backup ----
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data)
  const x = tar(['-xzf', backup, '-C', data])
  record('R3: backup restored into the emptied data folder', x.status === 0)
  await start(oldDir, 'R3: old server on the restored backup')
  r = tool('snapshot.mjs', BASE, state, join(work, 'snap-s3.json'))
  record('snapshot s3 (restored)', r.code === 0)
  r = tool('compare.mjs', join(work, 'snap-s0.json'), join(work, 'snap-s3.json'), 'strict')
  record('compare s0 -> s3 (strict): identical', r.code === 0, { valuesCompared: lastJson(r.out).valuesCompared, failures: lastJson(r.out).failures })
  await stop()
  summary.result = 'PASS'
} catch (e) {
  summary.result = 'FAIL'
  summary.error = String(e.message)
  process.exitCode = 1
} finally {
  await stop()
  summary.finishedAt = new Date().toISOString()
  writeFileSync(join(work, 'dry-run-summary.json'), JSON.stringify(summary, null, 1))
  console.log(`\nDry run: ${summary.result} (${summary.steps.filter((s) => s.ok).length}/${summary.steps.length} steps). Summary: ${join(work, 'dry-run-summary.json')}`)
}
