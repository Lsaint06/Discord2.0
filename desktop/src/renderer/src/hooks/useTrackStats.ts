import { useEffect, useState } from 'react'
import {
  reportToArray,
  summarizeInboundVideo,
  summarizeOutboundVideo,
  summarizePlayback,
  type InboundVideoStats,
  type OutboundVideoStats,
  type PlaybackSample,
  type PlaybackStats,
  type Stat
} from '../media/stats'
import { PlaybackSampler } from '../media/playback'

interface StatsTrack {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>
  /** LiveKit tracks list the elements they are attached to. */
  attachedElements?: HTMLMediaElement[]
}

export interface TrackStats<T> {
  rtc: T
  /** Presentation stats of the attached <video> element (viewer side only). */
  playback: PlaybackStats
}

type Direction = 'inbound' | 'outbound'
type Rtc<D extends Direction> = D extends 'inbound' ? InboundVideoStats : OutboundVideoStats

/**
 * Samples one video track's WebRTC stats every `intervalMs` while `track` is set and the
 * component is mounted (one React update per sample). Rates are computed from the previous
 * sample, so the first value appears after one interval. Resets cleanly when the track changes.
 */
export function useTrackStats<D extends Direction>(
  track: StatsTrack | undefined,
  direction: D,
  intervalMs = 1000
): TrackStats<Rtc<D>> | null {
  const [stats, setStats] = useState<{ track: StatsTrack; value: TrackStats<Rtc<D>> } | null>(null)

  useEffect(() => {
    if (!track?.getRTCStatsReport) return
    let prev: Stat[] | undefined
    let prevPlayback: PlaybackSample | undefined
    let sampler: PlaybackSampler | null = null
    let cancelled = false

    const sample = async (): Promise<void> => {
      const report = await track.getRTCStatsReport?.().catch(() => undefined)
      if (cancelled || !report) return
      const raw = reportToArray(report)
      if (direction === 'inbound' && !sampler) {
        const video = track.attachedElements?.find(
          (el): el is HTMLVideoElement => el instanceof HTMLVideoElement
        )
        if (video) sampler = new PlaybackSampler(video)
      }
      const playbackSample = sampler?.sample()
      if (prev) {
        const rtc = (
          direction === 'inbound'
            ? summarizeInboundVideo(raw, prev)
            : summarizeOutboundVideo(raw, prev)
        ) as Rtc<D>
        const playback = playbackSample ? summarizePlayback(playbackSample, prevPlayback) : {}
        setStats({ track, value: { rtc, playback } })
      }
      prev = raw
      prevPlayback = playbackSample
    }
    void sample()
    const timer = setInterval(() => void sample(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
      sampler?.stop()
    }
  }, [track, direction, intervalMs])

  // Ignore stale results from a previous track.
  return stats && stats.track === track ? stats.value : null
}
