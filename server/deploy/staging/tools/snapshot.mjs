// Records what each synthetic user sees through the API, plus content hashes of every attachment
// and profile image, so the same view can be compared after the upgrade, a rollback or a restore.
// The SAME session tokens are used every time, which also proves sessions survive.
// node snapshot.mjs <base> <stateFile> <out.json>
import { writeFileSync } from 'node:fs'
import { USERS, client, readState, syntheticPassword } from './lib.mjs'

const [base, stateFile, out] = process.argv.slice(2)
if (!out) throw new Error('usage: node snapshot.mjs <base> <stateFile> <out.json>')
const api = client(base)
const state = readState(stateFile)
if (state.kind !== 'd2-staging-synthetic') throw new Error('not a staging state file')
const meta = await api.call('GET', '/api/meta')
const snap = { base, at: new Date().toISOString(), apiVersion: meta.apiVersion, users: {}, files: {}, problems: [] }
const attachmentIds = new Set()
const mediaIds = new Set()

async function get(token, path) {
  const res = await api.raw('GET', path, { token })
  const text = await res.text()
  if (!res.ok) {
    snap.problems.push(`${path} -> ${res.status}`)
    return { __status: res.status }
  }
  return text ? JSON.parse(text) : null
}
const note = (u) => {
  for (const k of ['avatarId', 'bannerId']) if (u?.[k]) mediaIds.add(u[k])
}
const scanMessages = (list) => {
  if (!Array.isArray(list)) return list
  for (const m of list) for (const a of m.attachments ?? []) attachmentIds.add(a.id)
  return list
}

for (const name of USERS) {
  const token = state.users[name].token
  const v = {}
  v.me = await get(token, '/api/users/me')
  note(v.me)
  v.preferences = await get(token, '/api/users/me/preferences')
  v.servers = await get(token, '/api/servers')
  v.relationships = await get(token, '/api/relationships')
  v.readStates = await get(token, '/api/read-states')
  v.users = await get(token, '/api/users')
  if (Array.isArray(v.users)) v.users.forEach(note)
  v.members = {}
  v.messages = {}
  v.pins = {}
  for (const s of Array.isArray(v.servers) ? v.servers : []) {
    v.members[s.id] = await get(token, `/api/servers/${s.id}/members`)
    for (const c of s.channels ?? []) {
      if (c.type !== 'text') continue
      v.messages[c.id] = scanMessages(await get(token, `/api/channels/${c.id}/messages?limit=100`))
      v.pins[c.id] = (await get(token, `/api/channels/${c.id}/pins`))?.map?.((m) => m.id) ?? null
    }
  }
  v.conversations = await get(token, '/api/conversations')
  v.conversationMessages = {}
  for (const c of Array.isArray(v.conversations) ? v.conversations : []) {
    const id = c.id ?? c.channelId
    v.conversationMessages[id] = scanMessages(await get(token, `/api/channels/${id}/messages?limit=100`))
  }
  v.profiles = {}
  for (const other of USERS) {
    if (other === name) continue
    v.profiles[other] = await get(token, `/api/users/${state.users[other].id}/profile`)
    note(v.profiles[other]?.user)
  }
  if (name === 'owner') {
    const g = state.ids.guild
    v.roles = await get(token, `/api/servers/${g}/roles`)
    v.bans = await get(token, `/api/servers/${g}/bans`)
    v.invites = await get(token, `/api/servers/${g}/invites`)
    v.overrides = {}
    for (const ch of [state.ids.staff, state.ids.general]) v.overrides[ch] = await get(token, `/api/channels/${ch}/overrides`)
    v.adminAccounts = await get(token, '/api/admin/accounts')
    v.registrationInvites = await get(token, '/api/admin/registration-invites')
  }
  snap.users[name] = v
}

// Access rules: the disabled account is still refused, the banned user still banned, and a member
// still can't read the staff channel.
const erinLogin = await api.raw('POST', '/api/auth/login', { json: { username: 'erin', password: syntheticPassword() } })
snap.erinLoginStatus = erinLogin.status
snap.daveGuildStatus = (await api.raw('GET', `/api/servers/${state.ids.guild}`, { token: state.users.dave.token })).status
snap.carolStaffStatus = (await api.raw('GET', `/api/channels/${state.ids.staff}/messages`, { token: state.users.carol.token })).status

const reader = state.users.owner.token
for (const id of [...attachmentIds].sort()) snap.files[`attachment:${id}`] = await api.bytes(`/api/attachments/${id}`, reader)
for (const id of [...mediaIds].sort()) {
  for (const size of ['full', 'small']) snap.files[`media:${id}:${size}`] = await api.bytes(`/api/profile-media/${id}?size=${size}`, reader)
}
writeFileSync(out, JSON.stringify(snap, null, 1), { mode: 0o600 })
console.log(
  JSON.stringify({
    apiVersion: snap.apiVersion,
    users: Object.keys(snap.users).length,
    textChannelsRead: Object.values(snap.users).reduce((n, v) => n + Object.keys(v.messages).length, 0),
    messagesSeen: Object.values(snap.users).reduce((n, v) => n + Object.values(v.messages).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0), 0),
    files: Object.keys(snap.files).length,
    problems: snap.problems,
    erinLoginStatus: snap.erinLoginStatus,
    daveGuildStatus: snap.daveGuildStatus,
    carolStaffStatus: snap.carolStaffStatus
  })
)
process.exitCode = snap.problems.length ? 1 : 0
