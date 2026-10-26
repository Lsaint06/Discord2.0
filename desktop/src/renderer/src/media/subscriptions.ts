/**
 * Which remote tracks to receive. Rooms connect with autoSubscribe disabled and apply this
 * policy, so nobody decodes a screen share they aren't watching.
 */

export type TrackSourceName =
  'microphone' | 'camera' | 'screen_share' | 'screen_share_audio' | 'unknown'

export interface SubscriptionContext {
  /** The remote participant who published the track. */
  identity: string
  deafened: boolean
  /** Identity whose stream the local user is watching, if any. */
  watching: string | null
}

export function shouldSubscribe(
  source: TrackSourceName | string,
  ctx: SubscriptionContext
): boolean {
  switch (source) {
    case 'microphone':
      return !ctx.deafened
    case 'screen_share':
      return ctx.watching === ctx.identity
    case 'screen_share_audio':
      return ctx.watching === ctx.identity && !ctx.deafened
    default:
      // Camera and unknown sources are never published by our clients (backend grants forbid it).
      return false
  }
}
