/**
 * Milestone 14: the 12 original avatar decorations (inline SVG drawn for Discord 2.0).
 *
 * Layout: a 120×120 view box; the avatar circle is the middle 84 units (r = 42), so the
 * decoration box is the avatar size × 120/84, centered on it. Decorations never take pointer
 * events. They animate only while `animate` is true (hover, an open profile, the studio
 * preview); otherwise they show their first frame. Every animation loops back to its start,
 * so the reduced-motion rule (which ends animations instantly) leaves a still decoration.
 */
import { useId, type ReactNode } from 'react'
import type { AvatarDecorationId } from '../../net/protocol'

const C = 60

const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180
const pt = (r: number, deg: number): [number, number] => [
  C + r * Math.cos(rad(deg)),
  C + r * Math.sin(rad(deg))
]

/** SVG arc path on radius r from `from`° to `to`° (0° = top, clockwise). */
function arc(r: number, from: number, to: number): string {
  const [x1, y1] = pt(r, from)
  const [x2, y2] = pt(r, to)
  const large = to - from > 180 ? 1 : 0
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

const STAR = 'M0-5L1.2-1.2L5 0L1.2 1.2L0 5L-1.2 1.2L-5 0L-1.2-1.2Z'
const PETAL = 'M0-6C4-6 6-2 0 6C-6-2-4-6 0-6Z'
const CRESCENT = 'M0-7A7 7 0 1 0 0 7A5.4 5.4 0 1 1 0-7Z'
const HEART_ROWS = ['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..']

function PixelHeart({
  x,
  y,
  size,
  fill
}: {
  x: number
  y: number
  size: number
  fill: string
}): React.JSX.Element {
  const cells: ReactNode[] = []
  HEART_ROWS.forEach((row, r) =>
    [...row].forEach((cell, c) => {
      if (cell === 'X') {
        cells.push(
          <rect
            key={`${r}-${c}`}
            x={x + (c - 2.5) * size}
            y={y + (r - 2.5) * size}
            width={size}
            height={size}
            fill={fill}
          />
        )
      }
    })
  )
  return <>{cells}</>
}

function art(id: AvatarDecorationId, uid: string): ReactNode {
  const g = (name: string): string => `${uid}-${name}`
  const url = (name: string): string => `url(#${g(name)})`
  switch (id) {
    case 'violet-halo':
      return (
        <>
          <defs>
            <linearGradient id={g('a')} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ddd6fe" />
              <stop offset="0.5" stopColor="#8b5cf6" />
              <stop offset="1" stopColor="#f0abfc" />
            </linearGradient>
            <filter id={g('glow')} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.4" />
            </filter>
          </defs>
          <circle
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke={url('a')}
            strokeWidth="6"
            opacity="0.55"
            filter={url('glow')}
          />
          <circle cx={C} cy={C} r="46" fill="none" stroke={url('a')} strokeWidth="2.6" />
          <g className="d-spin">
            <circle
              cx={C}
              cy={C}
              r="51.5"
              fill="none"
              stroke="#ede9fe"
              strokeWidth="1.6"
              strokeDasharray="2 9"
              strokeLinecap="round"
            />
          </g>
          <g className="d-spin-rev">
            <circle
              cx={C}
              cy={C}
              r="55.5"
              fill="none"
              stroke="#a78bfa"
              strokeWidth="1.1"
              strokeDasharray="18 26"
              opacity="0.7"
            />
          </g>
        </>
      )
    case 'celestial-ring':
      return (
        <>
          <defs>
            <linearGradient id={g('gold')} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff1c1" />
              <stop offset="0.45" stopColor="#e5b94e" />
              <stop offset="0.7" stopColor="#b8862b" />
              <stop offset="1" stopColor="#fde68a" />
            </linearGradient>
          </defs>
          <circle cx={C} cy={C} r="46.5" fill="none" stroke={url('gold')} strokeWidth="3.2" />
          <circle
            cx={C}
            cy={C}
            r="50.5"
            fill="none"
            stroke="#fde68a"
            strokeWidth="0.8"
            opacity="0.6"
          />
          <g className="d-spin-slow">
            {[20, 110, 200, 290].map((deg, i) => {
              const [x, y] = pt(50.5, deg)
              return (
                <g key={deg} transform={`translate(${x} ${y})`}>
                  <path
                    d={STAR}
                    fill="#fff7d6"
                    className="d-twinkle"
                    style={{ animationDelay: `${i * 0.45}s` }}
                  />
                </g>
              )
            })}
          </g>
        </>
      )
    case 'frost-shards':
      return (
        <>
          <defs>
            <linearGradient id={g('ice')} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="1" stopColor="#7dd3fc" />
            </linearGradient>
          </defs>
          <circle
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke="#bae6fd"
            strokeWidth="2"
            strokeDasharray="10 3 2 3"
            opacity="0.9"
          />
          <g fill={url('ice')} stroke="#f0f9ff" strokeWidth="0.6" strokeLinejoin="round">
            <path d="M24 28L33 6L38 30Z" />
            <path d="M16 40L6 24L30 34Z" />
            <path d="M34 22L44 4L46 24Z" opacity="0.85" />
            <path d="M96 92L87 114L82 90Z" />
            <path d="M104 80L114 96L90 86Z" />
            <path d="M86 98L76 116L74 96Z" opacity="0.85" />
          </g>
          <g className="d-shimmer" fill="#ffffff">
            <path d="M33 6L35 20L31 18Z" opacity="0.9" />
            <path d="M87 114L85 100L89 102Z" opacity="0.9" />
          </g>
        </>
      )
    case 'neon-pulse':
      return (
        <>
          <defs>
            <filter id={g('glow')} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.6" />
            </filter>
          </defs>
          <circle
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke="#22d3ee"
            strokeWidth="5"
            opacity="0.6"
            filter={url('glow')}
          />
          <circle cx={C} cy={C} r="46" fill="none" stroke="#a5f3fc" strokeWidth="2" />
          <circle
            className="d-pulse"
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2"
          />
          <circle
            className="d-pulse d-delay"
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke="#f0abfc"
            strokeWidth="1.5"
          />
        </>
      )
    case 'pixel-hearts':
      return (
        <>
          <circle
            cx={C}
            cy={C}
            r="47"
            fill="none"
            stroke="#f9a8d4"
            strokeWidth="1.6"
            strokeDasharray="1.5 4.5"
            strokeLinecap="square"
          />
          {[
            [35, 0],
            [160, 0.5],
            [275, 1]
          ].map(([deg, delay]) => {
            const [x, y] = pt(51, deg!)
            return (
              <g key={deg} className="d-bob" style={{ animationDelay: `${delay}s` }}>
                <PixelHeart x={x} y={y} size={2.4} fill="#fb7185" />
                <rect x={x - 3.6} y={y - 3.6} width="2.4" height="2.4" fill="#ffe4e6" />
              </g>
            )
          })}
        </>
      )
    case 'petal-fall':
      return (
        <>
          <defs>
            <clipPath id={g('box')}>
              <rect x="0" y="0" width="120" height="120" />
            </clipPath>
          </defs>
          <path
            d={arc(47, 250, 470)}
            fill="none"
            stroke="#fbcfe8"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.8"
          />
          {[262, 300, 338, 376, 414, 452].map((deg, i) => {
            const [x, y] = pt(47, deg)
            return (
              <g key={deg} transform={`translate(${x} ${y}) rotate(${deg})`}>
                {[0, 72, 144, 216, 288].map((r) => (
                  <path
                    key={r}
                    d={PETAL}
                    transform={`rotate(${r}) translate(0 -4) scale(${i % 2 ? 0.55 : 0.7})`}
                    fill="#f9a8d4"
                  />
                ))}
                <circle r="1.6" fill="#fde68a" />
              </g>
            )
          })}
          <g clipPath={url('box')} fill="#fbcfe8">
            {[
              [78, 0],
              [98, 1.3],
              [24, 2.2]
            ].map(([x, delay]) => (
              <g key={x} transform={`translate(${x} 0)`}>
                <g className="d-fall" style={{ animationDelay: `${delay}s` }}>
                  <path d={PETAL} transform="scale(0.7)" />
                </g>
              </g>
            ))}
          </g>
        </>
      )
    case 'star-orbit':
      return (
        <>
          <circle
            cx={C}
            cy={C}
            r="51"
            fill="none"
            stroke="#c7d2fe"
            strokeWidth="0.7"
            opacity="0.5"
          />
          {[
            ['d-spin', 51, 0, 1],
            ['d-spin-slow', 55, 130, 0.8],
            ['d-spin-rev', 48.5, 250, 0.65]
          ].map(([cls, r, deg, scale]) => {
            const [x, y] = pt(r as number, deg as number)
            return (
              <g key={deg as number} className={cls as string}>
                <path d={STAR} transform={`translate(${x} ${y}) scale(${scale})`} fill="#fef9c3" />
                <circle cx={x} cy={y} r="5" fill="#fef08a" opacity="0.18" />
              </g>
            )
          })}
        </>
      )
    case 'ember-sparks':
      return (
        <>
          <defs>
            <linearGradient id={g('fire')} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#fbbf24" />
              <stop offset="0.6" stopColor="#f97316" />
              <stop offset="1" stopColor="#dc2626" stopOpacity="0" />
            </linearGradient>
            <filter id={g('glow')} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2" />
            </filter>
          </defs>
          <path
            d={arc(46.5, 110, 250)}
            fill="none"
            stroke={url('fire')}
            strokeWidth="6"
            strokeLinecap="round"
            filter={url('glow')}
            opacity="0.8"
          />
          <path
            d={arc(46.5, 100, 260)}
            fill="none"
            stroke="#fdba74"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {[
            [38, 0],
            [60, 0.6],
            [82, 1.1],
            [50, 1.6],
            [72, 2.1]
          ].map(([x, delay]) => (
            <circle
              key={x}
              className="d-rise"
              cx={x}
              cy="104"
              r="1.6"
              fill="#fde68a"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </>
      )
    case 'circuit-trace': {
      const traces = [
        'M60 14V4H74V0',
        'M100 40H112V26H120',
        'M104 72H116V90',
        'M24 96L12 108H0',
        'M16 50H6V36',
        'M80 104L88 116H100'
      ]
      return (
        <>
          <circle cx={C} cy={C} r="46" fill="none" stroke="#34d399" strokeWidth="1.6" />
          <g fill="none" stroke="#10b981" strokeWidth="1.4" opacity="0.75">
            {traces.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <g fill="#6ee7b7">
            {[
              [74, 1],
              [120, 26],
              [116, 90],
              [1, 108],
              [6, 36],
              [100, 116]
            ].map(([x, y]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" />
            ))}
          </g>
          <g fill="none" stroke="#d1fae5" strokeWidth="1.6" strokeLinecap="round">
            {traces.map((d, i) => (
              <path
                key={d}
                className="d-trace"
                d={d}
                pathLength={100}
                strokeDasharray="14 86"
                style={{ animationDelay: `${i * 0.35}s` }}
              />
            ))}
          </g>
        </>
      )
    }
    case 'moon-orbit':
      return (
        <>
          <circle
            cx={C}
            cy={C}
            r="53"
            fill="none"
            stroke="#cbd5e1"
            strokeWidth="0.9"
            strokeDasharray="3 4"
            opacity="0.65"
          />
          <circle
            cx={C}
            cy={C}
            r="46"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="1.4"
            opacity="0.6"
          />
          <g className="d-spin-slow">
            {(() => {
              const [x, y] = pt(53, 40)
              return (
                <g transform={`translate(${x} ${y}) rotate(-20)`}>
                  <circle r="10" fill="#e0e7ff" opacity="0.18" />
                  <path d={CRESCENT} fill="#f8fafc" />
                </g>
              )
            })()}
            {[150, 230].map((deg) => {
              const [x, y] = pt(53, deg)
              return <circle key={deg} cx={x} cy={y} r="1.3" fill="#f1f5f9" />
            })}
          </g>
        </>
      )
    case 'prism-ribbon': {
      const colors = ['#f87171', '#fbbf24', '#a3e635', '#22d3ee', '#818cf8', '#e879f9']
      return (
        <>
          <g className="d-spin-slow">
            {colors.map((color, i) => (
              <path
                key={color}
                d={arc(47, i * 60 + 2, i * 60 + 58)}
                fill="none"
                stroke={color}
                strokeWidth="4.5"
                strokeLinecap="round"
              />
            ))}
          </g>
          <circle
            cx={C}
            cy={C}
            r="50.5"
            fill="none"
            stroke="#ffffff"
            strokeWidth="0.8"
            opacity="0.5"
          />
          <g className="d-spin-rev">
            <path
              d={arc(53.5, 300, 360)}
              fill="none"
              stroke="#ffffff"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity="0.7"
            />
            <path
              d={arc(53.5, 120, 160)}
              fill="none"
              stroke="#ffffff"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity="0.5"
            />
          </g>
        </>
      )
    }
    case 'cosmic-comet':
      return (
        <>
          <defs>
            <radialGradient id={g('head')}>
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.5" stopColor="#bfdbfe" />
              <stop offset="1" stopColor="#60a5fa" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle
            cx={C}
            cy={C}
            r="47"
            fill="none"
            stroke="#1e3a8a"
            strokeWidth="1"
            opacity="0.45"
          />
          <g className="d-spin">
            {[
              [70, 0.12, 1],
              [50, 0.25, 1.8],
              [30, 0.45, 2.6],
              [14, 0.7, 3.2]
            ].map(([span, opacity, width]) => (
              <path
                key={span}
                d={arc(50, 360 - span!, 359)}
                fill="none"
                stroke="#93c5fd"
                strokeWidth={width}
                strokeLinecap="round"
                opacity={opacity}
              />
            ))}
            <circle cx={pt(50, 0)[0]} cy={pt(50, 0)[1]} r="6" fill={url('head')} />
            <circle cx={pt(50, 0)[0]} cy={pt(50, 0)[1]} r="2" fill="#ffffff" />
          </g>
        </>
      )
  }
}

export function AvatarDecoration({
  id,
  animate
}: {
  id: AvatarDecorationId
  /** Play the animation (otherwise the first frame is shown). */
  animate: boolean
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  return (
    <svg
      className={`avatar-decoration deco-${id}${animate ? ' animate' : ''}`}
      viewBox="0 0 120 120"
      aria-hidden="true"
      focusable="false"
      data-decoration={id}
    >
      {art(id, uid)}
    </svg>
  )
}
