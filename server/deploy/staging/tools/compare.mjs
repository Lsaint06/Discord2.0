// Compares two snapshots. Everything present BEFORE must be identical AFTER (new fields are
// allowed). Records are matched by id. Permission numbers are compared bit by bit: a lost bit is a
// failure, a gained bit is listed for review.
//
//   strict   no difference allowed (e.g. before vs. a restored backup)
//   upgrade  also allows the two intended changes of the v1.4.0 upgrade, reported as "expected":
//            - read states of never-opened channels: lastReadId null -> "0" (Milestone 13 fix);
//            - bit 65536 (Moderate Members) gained by the default owner/admin/moderator roles.
//
// node compare.mjs <before.json> <after.json> [strict|upgrade]
import { readFileSync } from 'node:fs'

const [beforeFile, afterFile, mode = 'strict'] = process.argv.slice(2)
if (!afterFile || !['strict', 'upgrade'].includes(mode)) throw new Error('usage: node compare.mjs <before> <after> [strict|upgrade]')
const before = JSON.parse(readFileSync(beforeFile, 'utf8'))
const after = JSON.parse(readFileSync(afterFile, 'utf8'))
const failures = []
const expected = []
const gained = []
let compared = 0
// Legitimately volatile between two runs of a server.
const VOLATILE = new Set(['at', 'base', 'lastSeenAt', 'expiresAt', 'lastActiveAt', 'uses', 'connectedAt'])
const MODERATE_MEMBERS = 1 << 16

const keyOf = (x) => (x && typeof x === 'object' ? (x.id ?? x.userId ?? x.channelId ?? x.emoji ?? x.role ?? null) : null)

function differ(path, text) {
  if (mode === 'upgrade' && /\.readStates\[[^\]]+\]\.lastReadId$/.test(path) && text === 'null -> "0"') {
    expected.push(`${path}: ${text}`)
  } else {
    failures.push(`${path}: ${text}`)
  }
}

function cmp(a, b, path) {
  if (a !== null && typeof a === 'object' && a.__status !== undefined) {
    if (b?.__status !== a.__status) failures.push(`${path}: was HTTP ${a.__status}, now ${b?.__status ?? 'OK'}`)
    return
  }
  if (b !== null && typeof b === 'object' && b.__status !== undefined) {
    failures.push(`${path}: now HTTP ${b.__status}`)
    return
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return void failures.push(`${path}: array became ${typeof b}`)
    const keyed = a.length > 0 && a.every((x) => keyOf(x) !== null)
    if (keyed) {
      const map = new Map(b.map((x) => [String(keyOf(x)), x]))
      for (const x of a) {
        const k = String(keyOf(x))
        if (!map.has(k)) failures.push(`${path}[${k}]: missing`)
        else cmp(x, map.get(k), `${path}[${k}]`)
      }
      return
    }
    if (a.length !== b.length) failures.push(`${path}: length ${a.length} -> ${b.length}`)
    a.forEach((x, i) => cmp(x, b[i], `${path}[${i}]`))
    return
  }
  if (a !== null && typeof a === 'object') {
    if (b === null || typeof b !== 'object') return void failures.push(`${path}: object became ${JSON.stringify(b)}`)
    for (const [k, v] of Object.entries(a)) {
      if (VOLATILE.has(k)) continue
      if (!(k in b)) {
        failures.push(`${path}.${k}: field missing`)
        continue
      }
      cmp(v, b[k], `${path}.${k}`)
    }
    return
  }
  compared++
  if (/permissions|allow|deny$/i.test(path.split('.').pop() ?? '') && typeof a === 'number' && typeof b === 'number') {
    const lost = a & ~b
    const added = b & ~a
    if (lost) failures.push(`${path}: lost permission bits ${lost} (${a} -> ${b})`)
    if (added) {
      const line = `${path}: gained bits ${added} (${a} -> ${b})`
      if (mode === 'upgrade' && added === MODERATE_MEMBERS) expected.push(line)
      else if (mode === 'strict') failures.push(line)
      else gained.push(line)
    }
    return
  }
  if (a !== b) differ(path, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
}

cmp(before.users, after.users, 'users')
cmp(before.files, after.files, 'files')
for (const k of ['erinLoginStatus', 'daveGuildStatus', 'carolStaffStatus']) cmp(before[k], after[k], k)
const out = {
  mode,
  apiVersions: [before.apiVersion, after.apiVersion],
  valuesCompared: compared,
  failures: failures.length,
  failureList: failures.slice(0, 60),
  expectedDifferences: expected.length,
  expectedSample: expected.slice(0, 10),
  unexpectedGainedPermissionBits: gained.slice(0, 40),
  problemsBefore: before.problems,
  problemsAfter: after.problems
}
console.log(JSON.stringify(out, null, 1))
process.exitCode = failures.length || gained.length || compared === 0 ? 1 : 0
