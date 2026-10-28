import { useEffect, useState } from 'react'
import type { MediaSession } from '../media/MediaSession'
import { reportToArray, type Stat } from '../media/stats'
import {
  summarizeConnection,
  type ConnectionSample,
  type ConnectionSummary
} from '../media/connectionStats'

interface StatsSource {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>
}

async function statsOf(track: StatsSource | undefined): Promise<Stat[] | undefined> {
  const report = await track?.getRTCStatsReport?.().catch(() => undefined)
  return report ? reportToArray(report) : undefined
}

/**
 * Samples voice connection telemetry while `active` (connected). One getStats() per audio track
 * per interval; no work at all when disconnected. The first values appear after two samples
 * (rates need a previous sample); round trip and transport appear after the first.
 */
export function useConnectionStats(
  session: Pick<MediaSession, 'getConnectionStatTracks'>,
  active: boolean,
  intervalMs: number
): ConnectionSummary | null {
  const [summary, setSummary] = useState<ConnectionSummary | null>(null)

  useEffect(() => {
    if (!active) return
    let prev: ConnectionSample | undefined
    let cancelled = false
    const sample = async (): Promise<void> => {
      const { microphone, remoteAudio } = session.getConnectionStatTracks()
      const inbound = new Map<string, Stat[]>()
      await Promise.all(
        [...remoteAudio].map(async ([sid, track]) => {
          const stats = await statsOf(track as StatsSource)
          if (stats) inbound.set(sid, stats)
        })
      )
      const cur: ConnectionSample = { outbound: await statsOf(microphone as StatsSource), inbound }
      if (cancelled) return
      setSummary(summarizeConnection(cur, prev))
      prev = cur
    }
    void sample()
    const timer = setInterval(() => void sample(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
      setSummary(null)
    }
  }, [session, active, intervalMs])

  return active ? summary : null
}
