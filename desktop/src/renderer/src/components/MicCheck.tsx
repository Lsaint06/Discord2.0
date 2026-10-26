import { useEffect, useRef, useState } from 'react'
import type { MediaSession } from '../media/MediaSession'
import type { UserSettings } from '../types'
import { Toggle } from './SettingsControls'

interface MicCheckProps {
  session: MediaSession
  settings: UserSettings
  onChange: (patch: Partial<UserSettings>) => void
}

const MIN_DB = -100
const toPct = (db: number): number => Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100))

/** Local microphone loopback (never sent anywhere): meter + optional playback to your output. */
class MicTest {
  private stream?: MediaStream
  private ctx?: AudioContext
  private analyser?: AnalyserNode
  private samples?: Float32Array<ArrayBuffer>
  private audio?: HTMLAudioElement

  async start(settings: UserSettings): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl
      }
    })
    this.ctx = new AudioContext()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.samples = new Float32Array(this.analyser.fftSize)
    source.connect(this.analyser)
    // Playback through an <audio> element so the chosen output device is honoured.
    const gain = this.ctx.createGain()
    gain.gain.value = settings.inputVolume / 100
    const dest = this.ctx.createMediaStreamDestination()
    source.connect(gain).connect(dest)
    this.audio = new Audio()
    this.audio.srcObject = dest.stream
    if (settings.outputDeviceId && 'setSinkId' in this.audio) {
      await this.audio.setSinkId(settings.outputDeviceId).catch(() => undefined)
    }
    await this.audio.play().catch(() => undefined)
  }

  levelDb(): number | null {
    if (!this.analyser || !this.samples) return null
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const s of this.samples) sum += s * s
    const rms = Math.sqrt(sum / this.samples.length)
    return rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB
  }

  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    if (this.audio) {
      this.audio.pause()
      this.audio.srcObject = null
    }
    void this.ctx?.close().catch(() => undefined)
    this.stream = undefined
    this.ctx = undefined
    this.analyser = undefined
    this.audio = undefined
  }
}

/** Input sensitivity (noise gate) with a live level meter and a local mic test. */
function MicCheck({ session, settings, onChange }: MicCheckProps): React.JSX.Element {
  const [level, setLevel] = useState<number | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const testRef = useRef<MicTest | null>(null)

  useEffect(() => {
    const timer = setInterval(() => {
      setLevel(testRef.current?.levelDb() ?? session.getInputLevelDb())
    }, 50)
    return () => clearInterval(timer)
  }, [session])

  // Always release the test microphone when leaving the page.
  useEffect(
    () => () => {
      testRef.current?.stop()
      testRef.current = null
    },
    []
  )

  const toggleTest = async (): Promise<void> => {
    if (testRef.current) {
      testRef.current.stop()
      testRef.current = null
      setTesting(false)
      return
    }
    setTestError(null)
    const test = new MicTest()
    try {
      await test.start(settings)
      testRef.current = test
      setTesting(true)
    } catch (err) {
      test.stop()
      setTestError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access is blocked.'
          : 'Could not open the microphone.'
      )
    }
  }

  const ptt = settings.inputMode === 'push-to-talk'
  const manual = !settings.inputSensitivityAuto && !ptt
  const open = level !== null && (!manual || level >= settings.inputSensitivityDb)

  return (
    <div className="mic-check">
      <span className="setting-field-label">Input Sensitivity</span>
      {ptt ? (
        <p className="settings-note">Push-to-talk is on, so input sensitivity isn&rsquo;t used.</p>
      ) : (
        <Toggle
          label="Automatically determine input sensitivity"
          checked={settings.inputSensitivityAuto}
          onChange={(inputSensitivityAuto) => onChange({ inputSensitivityAuto })}
        />
      )}
      <div
        className={`level-meter${open ? ' open' : ''}`}
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={MIN_DB}
        aria-valuemax={0}
        aria-valuenow={Math.round(level ?? MIN_DB)}
      >
        <div className="level-meter-fill" style={{ width: `${toPct(level ?? MIN_DB)}%` }} />
        {manual && (
          <div
            className="level-meter-threshold"
            style={{ left: `${toPct(settings.inputSensitivityDb)}%` }}
          />
        )}
      </div>
      {manual && (
        <input
          className="slider"
          type="range"
          min={MIN_DB}
          max={0}
          step={1}
          value={settings.inputSensitivityDb}
          onChange={(e) => onChange({ inputSensitivityDb: Number(e.target.value) })}
          aria-label={`Input sensitivity ${settings.inputSensitivityDb} dB`}
        />
      )}
      <p className="settings-note">
        {level === null
          ? 'Join voice or start a mic test to see your input level.'
          : manual
            ? `Threshold ${settings.inputSensitivityDb} dB — the bar turns green when you'll be heard.`
            : 'Speak to see your input level.'}
      </p>
      <div className="inline-form">
        <button type="button" className="button secondary" onClick={() => void toggleTest()}>
          {testing ? 'Stop Test' : "Let's Check"}
        </button>
        {testing && <span className="field-hint">You should hear yourself. Use headphones.</span>}
        {testError && <span className="field-hint error">{testError}</span>}
      </div>
    </div>
  )
}

export default MicCheck
