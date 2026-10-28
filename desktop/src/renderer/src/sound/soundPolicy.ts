/**
 * When a sound may play. Pure logic (no audio, no DOM) so every rule is unit-tested:
 * - the global switch and each event's toggle;
 * - Do Not Disturb silences message and mention sounds (voice cues stay: you caused them or
 *   you're in a call);
 * - muted channels, your own messages, and the conversation you're already looking at are silent
 *   (the same eligibility as desktop notifications);
 * - each message id sounds at most once (reconnects, echoes and repeated server events);
 * - bursts are coalesced: many messages at once → one chime; distinct mentions are spaced out
 *   rather than dropped (up to a small backlog).
 */
import type { SoundEvent } from './sounds'
import { SOUND_EVENTS } from './sounds'

export interface SoundPreferences {
  /** Global switch for all sound effects. */
  enabled: boolean
  /** 0–100. */
  volume: number
  events: Record<SoundEvent, boolean>
}

export const DEFAULT_SOUND_EVENTS: Record<SoundEvent, boolean> = {
  message: true,
  mention: true,
  friendRequest: true,
  voiceJoin: true,
  voiceLeave: true,
  connect: true,
  disconnect: true,
  mute: true,
  unmute: true,
  deafen: true,
  undeafen: true
}

export const DEFAULT_SOUND_VOLUME = 60

export function eventEnabled(prefs: SoundPreferences, event: SoundEvent): boolean {
  return prefs.enabled && prefs.volume > 0 && prefs.events[event] !== false
}

/**
 * Normalizes stored sound settings. A pre-Milestone-9 `notificationSounds: false` (the user had
 * turned off the Windows notification sound) turns off the message and mention sounds, so no
 * one who chose silence suddenly gets sounds.
 */
export function migrateSoundSettings(stored: Record<string, unknown>): {
  soundEffects: boolean
  soundVolume: number
  soundEvents: Record<SoundEvent, boolean>
} {
  const events = { ...DEFAULT_SOUND_EVENTS }
  const raw = stored.soundEvents
  if (raw && typeof raw === 'object') {
    for (const event of SOUND_EVENTS) {
      const value = (raw as Record<string, unknown>)[event]
      if (typeof value === 'boolean') events[event] = value
    }
  } else if (stored.notificationSounds === false) {
    events.message = false
    events.mention = false
  }
  const volume = Number(stored.soundVolume)
  return {
    soundEffects: typeof stored.soundEffects === 'boolean' ? stored.soundEffects : true,
    soundVolume: Number.isFinite(volume)
      ? Math.min(100, Math.max(0, Math.round(volume)))
      : DEFAULT_SOUND_VOLUME,
    soundEvents: events
  }
}

// ---- Messages ----

export interface MessageSoundContext {
  meId: string | undefined
  /** Your account's status preference. */
  doNotDisturb: boolean
  mutedChannels: Record<string, boolean>
  activeChannelId: string | undefined
  windowFocused: boolean
  /** The message mentions you (see chat/mentions.ts). */
  mentionsMe: boolean
}

/** Which sound (if any) an incoming message deserves, before deduplication and rate limiting. */
export function messageSound(
  message: { authorId: string; channelId: string },
  ctx: MessageSoundContext,
  prefs: SoundPreferences
): 'message' | 'mention' | null {
  if (!prefs.enabled) return null
  if (message.authorId === ctx.meId) return null
  if (ctx.doNotDisturb) return null
  if (ctx.mutedChannels[message.channelId]) return null
  if (ctx.windowFocused && ctx.activeChannelId === message.channelId) return null
  if (ctx.mentionsMe && eventEnabled(prefs, 'mention')) return 'mention'
  // A mention with the mention sound off still counts as a message.
  if (eventEnabled(prefs, 'message')) return 'message'
  return null
}

/** Remembers which message ids already produced a sound (bounded, oldest forgotten first). */
export class SeenMessages {
  private readonly ids = new Set<string>()
  constructor(private readonly max = 2000) {}

  /** True the first time an id is seen. */
  firstTime(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    return true
  }
}

// ---- Rate limiting ----

export type GateDecision = { play: true; delayMs: number } | { play: false }

/** Minimum spacing between plays of the same event (ms). */
const SPACING: Record<SoundEvent, number> = {
  message: 900,
  mention: 350,
  friendRequest: 1000,
  voiceJoin: 250,
  voiceLeave: 250,
  connect: 400,
  disconnect: 400,
  mute: 60,
  unmute: 60,
  deafen: 60,
  undeafen: 60
}
/** Events that are delayed (queued) instead of dropped when they come too fast. */
const QUEUED: ReadonlySet<SoundEvent> = new Set<SoundEvent>(['mention'])
const MAX_BACKLOG = 3

/**
 * Burst control. Message chimes coalesce (one per window; a recent mention covers them too).
 * Mentions are distinct and important, so they are spaced out, up to a short backlog.
 */
export class SoundGate {
  /** When each event is next allowed to start (ms). */
  private readonly nextAt = new Map<SoundEvent, number>()

  admit(event: SoundEvent, now: number): GateDecision {
    const allowedAt = this.nextAt.get(event) ?? -Infinity
    let start = now
    if (now < allowedAt) {
      if (!QUEUED.has(event)) return { play: false }
      if ((allowedAt - now) / SPACING[event] >= MAX_BACKLOG) return { play: false }
      start = allowedAt
    }
    this.nextAt.set(event, start + SPACING[event])
    if (event === 'mention') {
      // A mention also counts as the message chime for this window.
      const messageAt = this.nextAt.get('message') ?? -Infinity
      this.nextAt.set('message', Math.max(messageAt, start + SPACING.message))
    }
    return { play: true, delayMs: start - now }
  }
}
