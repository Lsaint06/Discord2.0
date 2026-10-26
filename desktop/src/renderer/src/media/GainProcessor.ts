import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'

/**
 * Microphone gain stage (the "Input Volume" setting) as a LiveKit track processor:
 * mic → GainNode → MediaStreamDestination, published in place of the raw track.
 */
export class GainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'd2-input-gain'
  processedTrack?: MediaStreamTrack

  private source?: MediaStreamAudioSourceNode
  private gainNode?: GainNode
  private destination?: MediaStreamAudioDestinationNode

  constructor(
    private gain: number,
    /** Called with each raw capture track the processor receives (initial and after restarts). */
    private readonly onSourceTrack?: (track: MediaStreamTrack) => void
  ) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.build(opts)
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    this.teardown()
    this.build(opts)
  }

  async destroy(): Promise<void> {
    this.teardown()
  }

  /** Linear gain, e.g. 1 = unchanged, 0 = silent, 2 = +6 dB. */
  setGain(gain: number): void {
    this.gain = gain
    if (this.gainNode) this.gainNode.gain.value = gain
  }

  private build({ track, audioContext }: AudioProcessorOptions): void {
    this.onSourceTrack?.(track)
    if (audioContext.state === 'suspended') void audioContext.resume()
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]))
    this.gainNode = audioContext.createGain()
    this.gainNode.gain.value = this.gain
    this.destination = audioContext.createMediaStreamDestination()
    this.source.connect(this.gainNode).connect(this.destination)
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
  }

  private teardown(): void {
    this.source?.disconnect()
    this.gainNode?.disconnect()
    this.processedTrack?.stop()
    this.source = undefined
    this.gainNode = undefined
    this.destination = undefined
    this.processedTrack = undefined
  }
}
