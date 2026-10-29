// Staging, phase 2 (after the upgrade, API 6): SYNTHETIC data for the v1.4.0 features, so the
// two-PC tests have something to look at. Profile styles (gradient, decoration, effect, banner,
// name style), an animated avatar, synced themes, a saved message, a personal note, a server
// description, a voice channel with a user limit and two generated soundboard clips.
//
// node seed-api6.mjs <base> <stateFile>
import { client, form, loadSharp, readState, toneWav, writeState } from './lib.mjs'

const [base, stateFile] = process.argv.slice(2)
if (!base || !stateFile) throw new Error('usage: node seed-api6.mjs <base> <stateFile>')
const api = client(base)
const sharp = loadSharp()
const state = readState(stateFile)
if (state.kind !== 'd2-staging-synthetic') throw new Error('not a staging state file')
if (state.phase2) throw new Error('phase 2 was seeded already')
const meta = await api.call('GET', '/api/meta')
if (meta.apiVersion !== 6 || meta.customization !== true) throw new Error(`phase 2 needs the upgraded API 6 server (got API ${meta.apiVersion})`)
const U = state.users
const g = state.ids.guild

// Profile styles: what friends will see on each other's profile cards.
await api.call('PATCH', '/api/users/me', {
  token: U.owner.token,
  json: {
    profileStyle: { colors: ['#3b2a8f', '#c2457a'], angle: 160, decoration: 'celestial-ring', effect: 'golden-sparks', banner: 'nebula', nameStyle: 'gold' }
  }
})
await api.call('PATCH', '/api/users/me', {
  token: U.carol.token,
  json: {
    profileStyle: { colors: ['#0f766e', '#22d3ee', '#a7f3d0'], angle: 90, decoration: 'petal-fall', effect: 'sakura-drift', banner: 'aurora', nameStyle: 'aurora' }
  }
})

// An animated avatar (generated frames; 24 frames of 256×256).
const size = 256
const frames = 24
const raw = Buffer.alloc(size * size * frames * 3)
for (let f = 0; f < frames; f++) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = ((f * size + y) * size + x) * 3
      raw[i] = (x * 255) / size
      raw[i + 1] = ((f * 255) / frames + y) % 256
      raw[i + 2] = 160
    }
  }
}
const gif = await sharp(raw, { raw: { width: size, height: size * frames, channels: 3, pageHeight: size } })
  .gif({ loop: 0, delay: Array(frames).fill(60), effort: 1 })
  .toBuffer()
const animated = await api.call('POST', '/api/users/me/avatar', { token: U.bob.token, form: form({}, { data: gif, type: 'image/gif', name: 'bob.gif' }) })

// Synced full-app themes, a saved message and a private note.
await api.call('PATCH', '/api/users/me/preferences', { token: U.carol.token, json: { appTheme: 'synthwave' } })
await api.call('PATCH', '/api/users/me/preferences', { token: U.alice.token, json: { appTheme: 'aurora' } })
await api.call('PUT', `/api/saved-messages/${state.ids.messages.welcome}`, { token: U.carol.token })
await api.call('PUT', `/api/users/${U.alice.id}/note`, { token: U.carol.token, json: { note: 'Synthetic note: met in staging' } })

// Server administration features from Milestone 13 (API 5+).
await api.call('PATCH', `/api/servers/${g}`, { token: U.owner.token, json: { description: 'Synthetic staging server for v1.4.0' } })
const duo = await api.call('POST', `/api/servers/${g}/channels`, { token: U.owner.token, json: { name: 'Duo Room', type: 'voice', category: 'Voice Channels' } })
await api.call('PATCH', `/api/channels/${duo.id}`, { token: U.owner.token, json: { userLimit: 2 } })

// Soundboard: two generated clips (sweeps), uploaded by the owner (Manage Server).
const clips = []
for (const [name, seconds, from, to] of [
  ['Staging horn', 0.8, 440, 880],
  ['Staging chirp', 0.5, 1400, 600]
]) {
  const wav = toneWav(seconds, from, to)
  const r = await api.call('POST', `/api/servers/${g}/soundboard`, { token: U.owner.token, form: form({ name }, { data: wav, type: 'audio/wav', name: `${name}.wav` }) })
  clips.push(r.id ?? r.sound?.id)
}

state.phase2 = { at: new Date().toISOString(), duoRoom: duo.id, soundboard: clips, animatedAvatar: animated?.avatarId ?? true }
writeState(stateFile, state)
console.log(JSON.stringify({ phase: 'api6', apiVersion: meta.apiVersion, profileStyles: 2, animatedAvatar: true, themes: 2, savedMessages: 1, notes: 1, soundboardClips: clips.length, duoRoom: duo.id }))
