// Measures the cost of animated profile pictures on THIS server's CPU (release blocker F2): uploads
// generated worst-case animated GIFs (at the frame/pixel limits, under the 10 MB upload limit)
// through the real API, one at a time and then two at once, and reports the time per upload.
// Watch `tegrastats --interval 1000` and `sudo docker stats` on the Jetson while it runs.
// node bench-animated.mjs <base> <stateFile>
import { client, form, loadSharp, readState } from './lib.mjs'

const [base, stateFile] = process.argv.slice(2)
if (!stateFile) throw new Error('usage: node bench-animated.mjs <base> <stateFile>')
const api = client(base)
const sharp = loadSharp()
const state = readState(stateFile)
if (state.kind !== 'd2-staging-synthetic') throw new Error('not a staging state file')
const meta = await api.call('GET', '/api/meta')
if (meta.apiVersion !== 6) throw new Error('needs the API 6 server')
const MAX_UPLOAD = 10 * 1024 * 1024

// Moving 16-colour bands: the full frame and pixel budget (60 MP) while staying near 4.5 MB, under
// the 10 MB upload limit (random-looking content at these sizes would be 20+ MB and refused).
async function gif(size, frames) {
  const raw = Buffer.alloc(size * size * frames * 3)
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = ((f * size + y) * size + x) * 3
        const v = ((x >> 3) + (y >> 3) + f) & 15
        raw[i] = v * 16
        raw[i + 1] = 255 - v * 16
        raw[i + 2] = (v * 37) & 255
      }
    }
  }
  return sharp(raw, { raw: { width: size, height: size * frames, channels: 3, pageHeight: size } })
    .gif({ loop: 0, delay: Array(frames).fill(40), effort: 1 })
    .toBuffer()
}

const results = []
async function timed(label, user, kind, bytes) {
  const t0 = performance.now()
  try {
    await api.call('POST', `/api/users/me/${kind}`, { token: state.users[user].token, form: form({}, { data: bytes, type: 'image/gif', name: `${kind}.gif` }) })
    return { label, user, kind, inputMB: +(bytes.length / 1048576).toFixed(2), ms: Math.round(performance.now() - t0), ok: true }
  } catch (e) {
    return { label, user, kind, inputMB: +(bytes.length / 1048576).toFixed(2), ms: Math.round(performance.now() - t0), ok: false, error: String(e.message).slice(0, 160) }
  }
}

const cases = [
  ['avatar 300 frames 447x447 (60 MP)', 'avatar', 447, 300],
  ['avatar 100 frames 774x774 (60 MP)', 'avatar', 774, 100],
  ['banner 60 frames 1000x1000 (60 MP)', 'banner', 1000, 60]
]
const made = []
for (const [label, kind, size, frames] of cases) {
  const bytes = await gif(size, frames)
  if (bytes.length > MAX_UPLOAD) {
    results.push({ label, skipped: `generated ${(bytes.length / 1048576).toFixed(1)} MB, over the 10 MB upload limit` })
    continue
  }
  made.push([label, kind, bytes])
  results.push(await timed(label, 'dave', kind, bytes))
}
const avatar = made.find(([, kind]) => kind === 'avatar')
if (avatar) {
  const t0 = performance.now()
  const both = await Promise.all([timed('concurrent #1', 'dave', 'avatar', avatar[2]), timed('concurrent #2', 'alice', 'avatar', avatar[2])])
  results.push(...both, { label: 'two at once (wall)', ms: Math.round(performance.now() - t0) })
}
console.log(JSON.stringify({ apiVersion: meta.apiVersion, timeoutMs: 60000, results }, null, 1))
const measured = results.filter((r) => r.ok !== undefined)
process.exitCode = measured.length === 0 || results.some((r) => r.ok === false || (r.ms ?? 0) > 45000) ? 1 : 0
