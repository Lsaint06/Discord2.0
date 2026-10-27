import type { PresenceStatus, SelectableStatus } from '../types'

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return parts
    .slice(0, 3)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  year: 'numeric'
})

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function formatTime(ts: number): string {
  return timeFormat.format(ts)
}

export function formatTimestamp(ts: number): string {
  const today = startOfDay(Date.now())
  const day = startOfDay(ts)
  if (day === today) return `Today at ${formatTime(ts)}`
  if (day === today - 86_400_000) return `Yesterday at ${formatTime(ts)}`
  return `${dateFormat.format(ts)} ${formatTime(ts)}`
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

export function formatDayDivider(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(ts)
}

export function presenceFromSetting(status: SelectableStatus): PresenceStatus {
  return status === 'invisible' ? 'offline' : status
}

export const statusLabels: Record<SelectableStatus | PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline'
}

const memberSince = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

export function formatMemberSince(ts: number | undefined): string | null {
  return ts ? memberSince.format(ts) : null
}
