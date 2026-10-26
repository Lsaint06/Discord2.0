import { useEffect, useState } from 'react'
import {
  reportToArray,
  summarizeInboundVideo,
  summarizeOutboundVideo,
  type InboundVideoStats,
  type OutboundVideoStats,
  type StatsSample
} from '../media/stats'

interface StatsTrack {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>
}

type Direction = 'inbound' | 'outbound'
type Result<D extends Direction> = D extends 'inbound' ? InboundVideoStats : OutboundVideoStats

/**
 * Samples one video track's WebRTC stats on an interval while `track` is set and the
 * component is mounted. Returns null until the first rate-bearing sample.
 */
export function useTrackStats<D extends Direction>(
  track: StatsTrack | undefined,
  direction: D,
  intervalMs = 1000
): Result<D> | null {
  const [stats, setStats] = useState<{ track: StatsTrack; value: Result<D> } | null>(null)

  useEffect(() => {
    if (!track?.getRTCStatsReport) return
    let prev: StatsSample | undefined
    let cancelled = false
    const sample = async (): Promise<void> => {
      const report = await track.getRTCStatsReport?.().catch(() => undefined)
      if (cancelled || !report) return
      const raw = reportToArray(report)
      const { summary, sample: next } =
        direction === 'inbound'
          ? summarizeInboundVideo(raw, prev)
          : summarizeOutboundVideo(raw, prev)
      prev = next
      setStats({ track, value: summary as Result<D> })
    }
    void sample()
    const timer = setInterval(() => void sample(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [track, direction, intervalMs])

  // Ignore stale results from a previous track.
  return stats && stats.track === track ? stats.value : null
}
