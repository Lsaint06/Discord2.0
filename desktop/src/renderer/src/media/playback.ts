import type { PlaybackSample } from './stats'

type FrameMeta = { presentedFrames: number; expectedDisplayTime: number; receiveTime?: number }
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * Counts frames the <video> element actually presents (requestVideoFrameCallback), and how long
 * each waited between network arrival and display. Cheap: one callback per frame, no pixel work.
 */
export class PlaybackSampler {
  private handle: number | null = null
  private presentedFrames?: number
  private r2dSum = 0
  private r2dCount = 0

  constructor(private readonly video: FrameCallbackVideo) {
    this.schedule()
  }

  private schedule(): void {
    if (!this.video.requestVideoFrameCallback) return
    this.handle = this.video.requestVideoFrameCallback((_now, meta) => {
      this.presentedFrames = meta.presentedFrames
      if (meta.receiveTime !== undefined && meta.expectedDisplayTime >= meta.receiveTime) {
        this.r2dSum += meta.expectedDisplayTime - meta.receiveTime
        this.r2dCount++
      }
      this.schedule()
    })
  }

  sample(): PlaybackSample {
    const q = this.video.getVideoPlaybackQuality?.()
    return {
      t: performance.now(),
      presentedFrames: this.presentedFrames,
      totalVideoFrames: q?.totalVideoFrames,
      droppedVideoFrames: q?.droppedVideoFrames,
      receiveToDisplaySumMs: this.r2dSum,
      receiveToDisplayCount: this.r2dCount
    }
  }

  stop(): void {
    if (this.handle !== null) this.video.cancelVideoFrameCallback?.(this.handle)
    this.handle = null
  }
}
