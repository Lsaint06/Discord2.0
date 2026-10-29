/**
 * Milestone 14: the 8 original profile effects. Each plays once for EFFECT_DURATION_MS (under
 * 5 s) when a profile opens and again when you hover it (`run` changes). Particle-heavy scenes
 * use a bounded canvas loop (≤ 150 particles, stops at the end, when the window is hidden or
 * when the card closes); the others are CSS layers. With motion reduced, a still frame is
 * drawn instead. The layer sits behind the card's text and never takes pointer events.
 */
import { useEffect, useRef } from 'react'
import type { ProfileEffectId } from '../../net/protocol'
import { EFFECT_DURATION_MS, EFFECT_INFO } from '../../lib/profileStyle'

/** Small deterministic PRNG so a replay looks varied but tests are stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Scene {
  /** Draws the scene at time t (seconds since start). */
  draw: (ctx: CanvasRenderingContext2D, t: number) => void
}

type SceneFactory = (w: number, h: number, rand: () => number) => Scene

const fadeOut = (t: number, end: number, len = 0.6): number =>
  t > end - len ? Math.max(0, (end - t) / len) : 1

const END = EFFECT_DURATION_MS / 1000

const SCENES: Partial<Record<ProfileEffectId, SceneFactory>> = {
  'meteor-shower': (w, h, rand) => {
    const meteors = Array.from({ length: 14 }, () => ({
      start: rand() * (END - 1.2),
      x: w * (0.3 + rand() * 0.9),
      y: -20 - rand() * h * 0.3,
      speed: 380 + rand() * 260,
      len: 60 + rand() * 70,
      width: 1 + rand() * 1.6
    }))
    const dx = -0.84
    const dy = 0.54
    return {
      draw(ctx, t) {
        ctx.lineCap = 'round'
        for (const m of meteors) {
          const age = t - m.start
          if (age < 0 || age > 1.6) continue
          const hx = m.x + dx * m.speed * age
          const hy = m.y + dy * m.speed * age
          const tx = hx - dx * m.len
          const ty = hy - dy * m.len
          const alpha = Math.min(1, age * 6) * Math.max(0, 1 - age / 1.6) * fadeOut(t, END)
          const grad = ctx.createLinearGradient(tx, ty, hx, hy)
          grad.addColorStop(0, 'rgba(147, 197, 253, 0)')
          grad.addColorStop(1, `rgba(255, 255, 255, ${alpha})`)
          ctx.strokeStyle = grad
          ctx.lineWidth = m.width
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(hx, hy)
          ctx.stroke()
          ctx.fillStyle = `rgba(224, 242, 254, ${alpha})`
          ctx.beginPath()
          ctx.arc(hx, hy, m.width * 1.3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  },
  'sakura-drift': (w, h, rand) => {
    const petals = Array.from({ length: 26 }, () => ({
      start: rand() * (END - 1.5),
      x: rand() * w,
      speed: 45 + rand() * 50,
      sway: 10 + rand() * 18,
      phase: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 4,
      size: 3.5 + rand() * 3.5,
      color: rand() > 0.4 ? '249, 168, 212' : '251, 207, 232'
    }))
    return {
      draw(ctx, t) {
        for (const p of petals) {
          const age = t - p.start
          if (age < 0) continue
          const y = -10 + p.speed * age
          if (y > h + 10) continue
          const x = p.x + Math.sin(p.phase + age * 2.2) * p.sway
          const alpha = Math.min(1, age * 3) * fadeOut(t, END) * 0.9
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(p.phase + age * p.spin)
          ctx.fillStyle = `rgba(${p.color}, ${alpha})`
          ctx.beginPath()
          ctx.moveTo(0, -p.size)
          ctx.bezierCurveTo(p.size * 0.9, -p.size, p.size, -p.size * 0.2, 0, p.size)
          ctx.bezierCurveTo(-p.size, -p.size * 0.2, -p.size * 0.9, -p.size, 0, -p.size)
          ctx.fill()
          ctx.restore()
        }
      }
    }
  },
  'galaxy-dust': (w, h, rand) => {
    const cx = w * 0.5
    const cy = Math.min(h * 0.35, 90)
    const colors = ['196, 181, 253', '125, 211, 252', '255, 255, 255', '240, 171, 252']
    const motes = Array.from({ length: 140 }, () => {
      const r = 8 + rand() ** 0.7 * Math.max(w, h) * 0.55
      return {
        r,
        angle: rand() * Math.PI * 2,
        omega: (0.9 + rand() * 0.5) * (60 / (r + 30)),
        size: 0.6 + rand() * 1.6,
        color: colors[Math.floor(rand() * colors.length)]!
      }
    })
    return {
      draw(ctx, t) {
        const appear = Math.min(1, t / 0.8) * fadeOut(t, END, 1)
        ctx.globalCompositeOperation = 'lighter'
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46)
        core.addColorStop(0, `rgba(233, 213, 255, ${0.5 * appear})`)
        core.addColorStop(1, 'rgba(139, 92, 246, 0)')
        ctx.fillStyle = core
        ctx.fillRect(cx - 46, cy - 46, 92, 92)
        for (const m of motes) {
          const a = m.angle + m.omega * t
          const r = m.r * (0.75 + 0.25 * Math.min(1, t / 1.2))
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r * 0.45
          ctx.fillStyle = `rgba(${m.color}, ${0.8 * appear})`
          ctx.fillRect(x, y, m.size, m.size)
        }
        ctx.globalCompositeOperation = 'source-over'
      }
    }
  },
  'golden-sparks': (w, h, rand) => {
    const origins = [
      [w * 0.25, h * 0.18],
      [w * 0.7, h * 0.12],
      [w * 0.5, h * 0.3]
    ]
    const sparks = Array.from({ length: 90 }, (_, i) => {
      const [ox, oy] = origins[i % origins.length]!
      const angle = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.4
      const speed = 90 + rand() * 170
      return {
        start: Math.floor(i / 30) * 0.9 + rand() * 0.2,
        ox: ox!,
        oy: oy!,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.4 + rand() * 1.2,
        size: 0.9 + rand() * 1.5
      }
    })
    return {
      draw(ctx, t) {
        for (const s of sparks) {
          const age = t - s.start
          if (age < 0 || age > s.life) continue
          const x = s.ox + s.vx * age
          const y = s.oy + s.vy * age + 0.5 * 240 * age * age
          const alpha = (1 - age / s.life) * fadeOut(t, END)
          ctx.fillStyle = `rgba(251, 191, 36, ${0.25 * alpha})`
          ctx.beginPath()
          ctx.arc(x, y, s.size * 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = `rgba(255, 244, 214, ${alpha})`
          ctx.beginPath()
          ctx.arc(x, y, s.size, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  },
  'winter-snow': (w, h, rand) => {
    const flakes = Array.from({ length: 70 }, () => ({
      start: rand() * (END - 1.8),
      x: rand() * w,
      speed: 26 + rand() * 40,
      drift: (rand() - 0.5) * 16,
      wobble: rand() * Math.PI * 2,
      size: 0.8 + rand() * 2.2,
      alpha: 0.5 + rand() * 0.5
    }))
    return {
      draw(ctx, t) {
        for (const f of flakes) {
          const age = t - f.start
          if (age < 0) continue
          const y = -6 + f.speed * age
          if (y > h + 6) continue
          const x = f.x + f.drift * age + Math.sin(f.wobble + age * 1.6) * 6
          ctx.fillStyle = `rgba(255, 255, 255, ${f.alpha * Math.min(1, age * 2) * fadeOut(t, END)})`
          ctx.beginPath()
          ctx.arc(x, y, f.size, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }
}

/** Whether an effect is drawn on a canvas (vs. CSS layers). */
const isCanvasEffect = (id: ProfileEffectId): boolean => Boolean(SCENES[id])

function CanvasEffect({
  id,
  run,
  still
}: {
  id: ProfileEffectId
  run: number
  still: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const factory = SCENES[id]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !factory || !ctx) return
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const scene = factory(w, h, mulberry32(run * 7919 + id.length))
    if (still) {
      ctx.clearRect(0, 0, w, h)
      scene.draw(ctx, END * 0.45)
      return
    }
    let frame = 0
    const started = performance.now()
    const tick = (now: number): void => {
      const t = (now - started) / 1000
      ctx.clearRect(0, 0, w, h)
      if (t >= END || document.hidden) return
      scene.draw(ctx, t)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      ctx.clearRect(0, 0, w, h)
    }
  }, [id, run, still])
  return <canvas ref={ref} className={`profile-effect fx-${id}`} aria-hidden="true" />
}

function CssEffect({ id, still }: { id: ProfileEffectId; still: boolean }): React.JSX.Element {
  return (
    <div className={`profile-effect fx-${id}${still ? ' still' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
      {id === 'neon-wave' && (
        <svg viewBox="0 0 400 60" preserveAspectRatio="none">
          <path d="M0 30 Q25 6 50 30 T100 30 T150 30 T200 30 T250 30 T300 30 T350 30 T400 30" />
          <path d="M0 34 Q25 54 50 34 T100 34 T150 34 T200 34 T250 34 T300 34 T350 34 T400 34" />
        </svg>
      )}
    </div>
  )
}

/**
 * One profile effect layer. `run` > 0 plays it (a new value replays it); `still` draws a
 * motionless frame (reduced motion / reduced effects).
 */
function ProfileEffect({
  id,
  run,
  still
}: {
  id: ProfileEffectId
  run: number
  still: boolean
}): React.JSX.Element | null {
  if (!EFFECT_INFO[id]) return null
  if (!still && run <= 0) return null
  return isCanvasEffect(id) ? (
    <CanvasEffect key={still ? 'still' : run} id={id} run={Math.max(1, run)} still={still} />
  ) : (
    <CssEffect key={still ? 'still' : run} id={id} still={still} />
  )
}

export default ProfileEffect
