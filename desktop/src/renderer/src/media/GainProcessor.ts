import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'

const GATE_INTERVAL_MS = 20
/** Keep the gate open this long after speech drops below the threshold (avoids clipped words). */
const GATE_HOLD_MS = 250

/**
 * Microphone processing as a LiveKit track processor:
 *   mic → [analyser tap] → GainNode (input volume) → GateNode (noise gate) → published track
 * The analyser feeds the input level meter; the gate implements manual input sensitivity.
 */
export class GainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'd2-input-gain'
  processedTrack?: MediaStreamTrack

  private source?: MediaStreamAudioSourceNode
  private analyser?: AnalyserNode
  private gainNode?: GainNode
  private gateNode?: GainNode
  private destination?: MediaStreamAudioDestinationNode
  private samples?: Float32Array<ArrayBuffer>
  private gateTimer: ReturnType<typeof setInterval> | null = null
  private gateThresholdDb: number | null = null
  private gateOpenUntil = 0

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

  /** Noise gate threshold in dBFS, or null to disable the gate (always open). */
  setGate(thresholdDb: number | null): void {
    this.gateThresholdDb = thresholdDb
    this.syncGateTimer()
  }

  /** Current input RMS level in dBFS (≈ -100 for silence), measured before gain/gate. */
  getLevelDb(): number | null {
    if (!this.analyser || !this.samples) return null
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const s of this.samples) sum += s * s
    const rms = Math.sqrt(sum / this.samples.length)
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100
  }

  private build({ track, audioContext }: AudioProcessorOptions): void {
    this.onSourceTrack?.(track)
    if (audioContext.state === 'suspended') void audioContext.resume()
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]))
    this.analyser = audioContext.createAnalyser()
    this.analyser.fftSize = 1024
    this.samples = new Float32Array(this.analyser.fftSize)
    this.gainNode = audioContext.createGain()
    this.gainNode.gain.value = this.gain
    this.gateNode = audioContext.createGain()
    this.destination = audioContext.createMediaStreamDestination()
    this.source.connect(this.analyser)
    this.source.connect(this.gainNode).connect(this.gateNode).connect(this.destination)
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
    this.syncGateTimer()
  }

  private syncGateTimer(): void {
    const enabled = this.gateThresholdDb !== null && this.gateNode !== undefined
    if (enabled && !this.gateTimer) {
      this.gateTimer = setInterval(() => this.tickGate(), GATE_INTERVAL_MS)
    } else if (!enabled && this.gateTimer) {
      clearInterval(this.gateTimer)
      this.gateTimer = null
    }
    if (!enabled && this.gateNode) this.gateNode.gain.value = 1
  }

  private tickGate(): void {
    const gate = this.gateNode
    const threshold = this.gateThresholdDb
    const level = this.getLevelDb()
    if (!gate || threshold === null || level === null) return
    const now = performance.now()
    if (level >= threshold) this.gateOpenUntil = now + GATE_HOLD_MS
    const target = now < this.gateOpenUntil ? 1 : 0
    // Short ramps avoid clicks: fast attack, gentler release.
    gate.gain.setTargetAtTime(target, gate.context.currentTime, target === 1 ? 0.005 : 0.05)
  }

  private teardown(): void {
    if (this.gateTimer) clearInterval(this.gateTimer)
    this.gateTimer = null
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.gainNode?.disconnect()
    this.gateNode?.disconnect()
    this.processedTrack?.stop()
    this.source = undefined
    this.analyser = undefined
    this.gainNode = undefined
    this.gateNode = undefined
    this.destination = undefined
    this.processedTrack = undefined
    this.samples = undefined
  }
}
