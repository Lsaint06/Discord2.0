// Staging, phase 1 (API 4, i.e. today's production code): SYNTHETIC data created through the API
// the way people created it in production. Accounts (registration invites), a server with roles,
// a permission override and a staff-only channel, text and voice channels, messages (replies,
// edits, reactions, pins, a deletion), image and file attachments, friends, a DM, a group, a block,
// profiles with avatar and banner, presence, preferences, read states, invites, a ban and a
// disabled account. Every name, text, picture and sound is generated here; nothing is real.
//
// node seed-api4.mjs <base> <stateFile>
// Needs: the owner account created by `stg.sh create-owner` (admin CLI), and nothing else yet.
import { existsSync } from 'node:fs'
import { client, form, loadSharp, sleep, syntheticPassword, writeState } from './lib.mjs'

const [base, stateFile] = process.argv.slice(2)
if (!base || !stateFile) throw new Error('usage: node seed-api4.mjs <base> <stateFile>')
if (existsSync(stateFile)) throw new Error(`${stateFile} already exists: this server was seeded already`)
const api = client(base)
const sharp = loadSharp()
const PW = syntheticPassword()

const meta = await api.call('GET', '/api/meta')
if (meta.apiVersion !== 4) {
  throw new Error(`phase 1 must run on the API 4 server (today's production code); this one is API ${meta.apiVersion}`)
}

const login = async (username) => (await api.call('POST', '/api/auth/login', { json: { username, password: PW } })).token
const owner = { token: await login('owner') }
owner.id = (await api.call('GET', '/api/users/me', { token: owner.token })).id

// Fresh staging only: apart from the built-in system bot, the owner must be the one and only account.
const accounts = await api.call('GET', '/api/admin/accounts', { token: owner.token })
const accountList = (Array.isArray(accounts) ? accounts : (accounts.accounts ?? [])).filter((a) => !a.bot)
if (accountList.length !== 1) {
  throw new Error(`expected a fresh staging server with only the owner account, found ${accountList.length} accounts`)
}

const state = { kind: 'd2-staging-synthetic', createdAt: new Date().toISOString(), meta, users: { owner } }

// ---- Accounts (registration invites, as the owner hands them out) ----
for (const [username, displayName] of [
  ['alice', 'Alice Admin'],
  ['bob', 'Bob Moderator'],
  ['carol', 'Carol Member'],
  ['dave', 'Dave Banned'],
  ['erin', 'Erin Disabled']
]) {
  const inv = await api.call('POST', '/api/admin/registration-invites', {
    token: owner.token,
    json: { password: PW, serverId: 'hangout', note: `synthetic: ${username}` }
  })
  const r = await api.call('POST', '/api/auth/register', { json: { code: inv.code, username, displayName, password: PW } })
  state.users[username] = { id: r.user.id, token: r.token }
}
const U = state.users

// ---- A server with roles, a permission override, text and voice channels ----
const guild = await api.call('POST', '/api/servers', { token: owner.token, json: { name: 'Staging Guild', color: '#2f9e8f' } })
const invite = await api.call('POST', `/api/servers/${guild.id}/invites`, { token: owner.token, json: {} })
for (const u of ['alice', 'bob', 'carol', 'dave']) {
  await api.call('POST', '/api/invites/accept', { token: U[u].token, json: { code: invite.code } })
}
await api.call('PATCH', `/api/servers/${guild.id}/members/${U.alice.id}`, { token: owner.token, json: { role: 'admin' } })
await api.call('PATCH', `/api/servers/${guild.id}/members/${U.bob.id}`, { token: owner.token, json: { role: 'moderator' } })
const roles = await api.call('GET', `/api/servers/${guild.id}/roles`, { token: owner.token })
const roleList = Array.isArray(roles) ? roles : (roles.roles ?? [])
const memberRole = roleList.find((r) => r.role === 'member')
const PIN = 1 << 5
// A customized role: members may not pin (its stored value must survive the upgrade unchanged).
const memberPerms = memberRole ? (memberRole.permissions ?? memberRole.effective ?? 0) & ~PIN : null
if (memberPerms !== null) {
  await api.call('PUT', `/api/servers/${guild.id}/roles/member`, { token: owner.token, json: { permissions: memberPerms } })
}
const staff = await api.call('POST', `/api/servers/${guild.id}/channels`, {
  token: owner.token,
  json: { name: 'staff-only', type: 'text', topic: 'Moderators and up', category: 'Staff' }
})
await api.call('PUT', `/api/channels/${staff.id}/overrides/member`, { token: owner.token, json: { allow: 0, deny: 1 } })
const news = await api.call('POST', `/api/servers/${guild.id}/channels`, {
  token: owner.token,
  json: { name: 'announcements', type: 'text', topic: 'Important updates' }
})
const voiceA = await api.call('POST', `/api/servers/${guild.id}/channels`, { token: owner.token, json: { name: 'Raid Room', type: 'voice' } })
const voiceB = await api.call('POST', `/api/servers/${guild.id}/channels`, { token: owner.token, json: { name: 'Chill Room', type: 'voice' } })
const fresh = await api.call('GET', `/api/servers/${guild.id}`, { token: owner.token })
const general =
  fresh.channels.find((c) => c.type === 'text' && c.name === 'general') ?? fresh.channels.find((c) => c.type === 'text')

// ---- Messages ----
let nonce = 0
const send = (u, channelId, content, extra = {}) =>
  api.call('POST', `/api/channels/${channelId}/messages`, {
    token: U[u].token,
    json: { content, nonce: `stg${++nonce}x${Date.now()}`, ...extra }
  })
const msgs = []
const lines = [
  ['owner', 'Welcome to the Staging Guild! Everything here is synthetic test data.'],
  ['alice', 'Thanks! **Bold**, _italic_, `code` and a link: https://example.com/docs'],
  ['bob', 'Moderation tools are ready.'],
  ['carol', 'Hi everyone 👋 — unicode test: café, naïve, 日本語, emoji 🎉'],
  ['dave', 'Hello from Dave.'],
  ['alice', '@carol did you see the new channel?'],
  ['carol', 'Yes! Looks great.'],
  ['owner', 'Reminder: test night on Friday.'],
  ['bob', 'I will pin that.'],
  ['carol', 'Multi-line\nmessage\nwith three lines.']
]
for (const [u, content] of lines) msgs.push(await send(u, general.id, content))
for (let i = 0; i < 20; i++) msgs.push(await send(['alice', 'bob', 'carol', 'owner'][i % 4], general.id, `Backlog message ${i + 1}`))
const reply = await send('carol', general.id, 'Replying to the welcome message.', { replyToId: msgs[0].id })
await api.call('PATCH', `/api/channels/${general.id}/messages/${msgs[2].id}`, {
  token: U.bob.token,
  json: { content: 'Moderation tools are ready (edited).' }
})
for (const [u, emoji] of [['alice', '🎉'], ['carol', '🎉'], ['bob', '👍']]) {
  await api.call('PUT', `/api/channels/${general.id}/messages/${msgs[0].id}/reactions/${encodeURIComponent(emoji)}`, { token: U[u].token })
}
await api.call('PUT', `/api/channels/${general.id}/pins/${msgs[7].id}`, { token: U.bob.token })
const doomed = await send('dave', general.id, 'This message will be deleted.')
await api.call('DELETE', `/api/channels/${general.id}/messages/${doomed.id}`, { token: U.dave.token })
await send('alice', staff.id, 'Staff only: do not share.')
await send('bob', staff.id, 'Noted.')
await send('owner', news.id, 'v1.4.0 staging is live.')

// ---- Attachments: a generated picture, a generated photo-like JPEG and a text file ----
const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#335577' } })
  .composite([{ input: Buffer.from('<svg width="640" height="360"><circle cx="320" cy="180" r="120" fill="#ffcc00"/></svg>') }])
  .png()
  .toBuffer()
const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa3355' } }).jpeg({ quality: 80 }).toBuffer()
const txt = Buffer.from('Synthetic staging notes\n' + 'line\n'.repeat(200))
const upload = async (u, channelId, file) => {
  const r = await api.call('POST', `/api/channels/${channelId}/attachments`, { token: U[u].token, form: form({}, file) })
  return Array.isArray(r) ? r[0] : r
}
const a1 = await upload('carol', general.id, { data: png, type: 'image/png', name: 'diagram.png' })
const a2 = await upload('carol', general.id, { data: txt, type: 'text/plain', name: 'notes.txt' })
const withFiles = await send('carol', general.id, 'Here are the files.', { attachmentIds: [a1.id, a2.id] })
const a3 = await upload('bob', general.id, { data: jpg, type: 'image/jpeg', name: 'photo.jpg' })
const withPhoto = await send('bob', general.id, '', { attachmentIds: [a3.id] })

// ---- Friends, a DM, a group, a block ----
await api.call('POST', '/api/relationships/requests', { token: U.alice.token, json: { username: 'carol' } })
await api.call('POST', `/api/relationships/${U.alice.id}/accept`, { token: U.carol.token })
await api.call('POST', '/api/relationships/requests', { token: U.bob.token, json: { username: 'carol' } }) // left pending
const dm = await api.call('POST', '/api/conversations/dm', { token: U.alice.token, json: { userId: U.carol.id } })
const dmId = dm.id ?? dm.channelId ?? dm.conversation?.id
for (const [u, content] of [['alice', 'Private hello, Carol.'], ['carol', 'Hey Alice! DM works.'], ['alice', 'Great.']]) {
  await send(u, dmId, content)
}
for (const u of ['alice', 'bob']) {
  await api.call('POST', '/api/relationships/requests', { token: owner.token, json: { username: u } })
  await api.call('POST', `/api/relationships/${owner.id}/accept`, { token: U[u].token })
}
const group = await api.call('POST', '/api/conversations/group', { token: owner.token, json: { userIds: [U.alice.id, U.bob.id] } })
const groupId = group.id ?? group.channelId ?? group.conversation?.id
await api.call('PATCH', `/api/conversations/${groupId}`, { token: owner.token, json: { name: 'Staff chat' } }).catch(() => undefined)
for (const [u, content] of [['owner', 'Group chat for the team.'], ['bob', 'On it.']]) await send(u, groupId, content)
await api.call('PUT', `/api/relationships/${U.erin.id}/block`, { token: U.dave.token })

// ---- Profiles, generated images, presence, preferences, read states ----
await api.call('PATCH', '/api/users/me', { token: U.alice.token, json: { bio: 'Synthetic server admin.', pronouns: 'she/her' } })
await api.call('PATCH', '/api/users/me', { token: U.carol.token, json: { bio: 'Synthetic member for two-PC tests.' } })
const avatar = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#7c5cff' } }).png().toBuffer()
const banner = await sharp({ create: { width: 1500, height: 600, channels: 3, background: '#224488' } }).png().toBuffer()
await api.call('POST', '/api/users/me/avatar', { token: U.alice.token, form: form({}, { data: avatar, type: 'image/png', name: 'a.png' }) })
await api.call('POST', '/api/users/me/banner', { token: U.alice.token, form: form({}, { data: banner, type: 'image/png', name: 'b.png' }) })
await api.call('PUT', '/api/users/me/status', { token: U.carol.token, json: { status: 'dnd' } })
await api.call('PATCH', '/api/users/me/preferences', {
  token: U.carol.token,
  json: { theme: 'light', density: 'compact', showTimestamps: false }
})
await api.call('PUT', `/api/channels/${general.id}/read`, { token: U.carol.token, json: { messageId: withPhoto.id } })

// ---- Moderation and administration ----
await sleep(200)
await api.call('PUT', `/api/servers/${guild.id}/bans/${U.dave.id}`, { token: owner.token, json: { reason: 'Synthetic ban' } })
await api.call('POST', `/api/admin/accounts/${U.erin.id}/disabled`, { token: owner.token, json: { disabled: true, password: PW } })
const spare = await api.call('POST', `/api/servers/${guild.id}/invites`, { token: owner.token, json: {} })
await api.call('POST', '/api/admin/registration-invites', { token: owner.token, json: { password: PW, note: 'synthetic: unused' } })

state.ids = {
  guild: guild.id,
  general: general.id,
  staff: staff.id,
  news: news.id,
  voice: [voiceA.id, voiceB.id],
  dm: dmId,
  group: groupId,
  attachments: [a1.id, a2.id, a3.id],
  messages: { welcome: msgs[0].id, reply: reply.id, withFiles: withFiles.id, withPhoto: withPhoto.id, deleted: doomed.id },
  invite: invite.code,
  spareInvite: spare.code
}
state.rolesBefore = roles
writeState(stateFile, state)
console.log(
  JSON.stringify({
    phase: 'api4',
    apiVersion: meta.apiVersion,
    accounts: Object.keys(U),
    server: guild.id,
    textChannels: fresh.channels.filter((c) => c.type === 'text').length,
    voiceChannels: fresh.channels.filter((c) => c.type === 'voice').length,
    messages: msgs.length + 9,
    attachments: 3,
    customizedMemberPermissions: memberPerms
  })
)
