// Exercises 20 write paths, the risky part of running OLDER code on a NEWER schema (rollback) and
// new code on old data (upgrade). Prints one status per operation; exit code 1 if any failed.
// node writes.mjs <base> <stateFile> <label>
import { client, form, loadSharp, readState, syntheticPassword } from './lib.mjs'

const [base, stateFile, label] = process.argv.slice(2)
if (!label) throw new Error('usage: node writes.mjs <base> <stateFile> <label>')
const api = client(base)
const sharp = loadSharp()
const state = readState(stateFile)
if (state.kind !== 'd2-staging-synthetic') throw new Error('not a staging state file')
const PW = syntheticPassword()
const U = state.users
const results = {}
const tag = `${label}-${Date.now().toString(36)}`.replace(/[^a-z0-9-]/gi, '')
async function step(name, fn) {
  try {
    const r = await fn()
    results[name] = r === undefined ? 'ok' : r
  } catch (e) {
    results[name] = 'FAILED: ' + String(e.message).slice(0, 160)
  }
}
const ok = () => 'ok'
const g = state.ids.general
let msgId
await step('sendMessage', async () => {
  msgId = (await api.call('POST', `/api/channels/${g}/messages`, { token: U.alice.token, json: { content: `write test ${tag}`, nonce: tag } })).id
})
await step('editMessage', () => api.call('PATCH', `/api/channels/${g}/messages/${msgId}`, { token: U.alice.token, json: { content: `write test ${tag} (edited)` } }).then(ok))
await step('react', () => api.call('PUT', `/api/channels/${g}/messages/${msgId}/reactions/${encodeURIComponent('✅')}`, { token: U.bob.token }).then(ok))
await step('reply', () => api.call('POST', `/api/channels/${g}/messages`, { token: U.carol.token, json: { content: 'reply', nonce: tag + 'r', replyToId: msgId } }).then(ok))
await step('pin', () => api.call('PUT', `/api/channels/${g}/pins/${msgId}`, { token: U.bob.token }).then(ok))
await step('upload+send', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00aa88' } }).png().toBuffer()
  const up = await api.call('POST', `/api/channels/${g}/attachments`, { token: U.carol.token, form: form({}, { data: png, type: 'image/png', name: `${tag}.png` }) })
  const a = Array.isArray(up) ? up[0] : up
  await api.call('POST', `/api/channels/${g}/messages`, { token: U.carol.token, json: { content: '', nonce: tag + 'a', attachmentIds: [a.id] } })
})
await step('deleteMessage', () => api.call('DELETE', `/api/channels/${g}/messages/${msgId}`, { token: U.alice.token }).then(ok))
await step('createChannel', () => api.call('POST', `/api/servers/${state.ids.guild}/channels`, { token: U.owner.token, json: { name: `w-${tag}`.slice(0, 30).toLowerCase(), type: 'text' } }).then(ok))
await step('createServer', () => api.call('POST', '/api/servers', { token: U.alice.token, json: { name: `S ${tag}`.slice(0, 30), color: '#123456' } }).then(ok))
await step('registerNewUser', async () => {
  const inv = await api.call('POST', '/api/admin/registration-invites', { token: U.owner.token, json: { password: PW } })
  const name = ('n' + tag.toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20)
  await api.call('POST', '/api/auth/register', { json: { code: inv.code, username: name, displayName: name, password: PW } })
})
await step('login', () => api.call('POST', '/api/auth/login', { json: { username: 'bob', password: PW } }).then(ok))
await step('dmMessage', () => api.call('POST', `/api/channels/${state.ids.dm}/messages`, { token: U.carol.token, json: { content: 'dm ' + tag, nonce: tag + 'd' } }).then(ok))
await step('profileUpdate', () => api.call('PATCH', '/api/users/me', { token: U.bob.token, json: { bio: 'bio ' + tag } }).then(ok))
await step('avatarUpload', async () => {
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#aa8800' } }).png().toBuffer()
  await api.call('POST', '/api/users/me/avatar', { token: U.dave.token, form: form({}, { data: png, type: 'image/png', name: 'd.png' }) })
})
await step('preferences', () => api.call('PATCH', '/api/users/me/preferences', { token: U.bob.token, json: { density: 'compact' } }).then(ok))
await step('status', () => api.call('PUT', '/api/users/me/status', { token: U.bob.token, json: { status: 'idle' } }).then(ok))
await step('friendRequest', () => api.call('POST', '/api/relationships/requests', { token: U.carol.token, json: { username: 'owner' } }).then(ok, (e) => (/409|already/i.test(e.message) ? 'ok (already requested)' : Promise.reject(e))))
await step('readAck', () => api.call('PUT', `/api/channels/${g}/read`, { token: U.bob.token, json: { messageId: String(state.ids.messages.withPhoto) } }).then(ok))
await step('serverInvite', () => api.call('POST', `/api/servers/${state.ids.guild}/invites`, { token: U.owner.token, json: {} }).then(ok))
await step('roleChange', () => api.call('PATCH', `/api/servers/${state.ids.guild}/members/${U.carol.id}`, { token: U.owner.token, json: { role: 'member' } }).then(ok))
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAILED'))
const meta = await api.call('GET', '/api/meta')
console.log(JSON.stringify({ label, apiVersion: meta.apiVersion, operations: Object.keys(results).length, failed: failed.length, results }, null, 1))
process.exitCode = failed.length ? 1 : 0
