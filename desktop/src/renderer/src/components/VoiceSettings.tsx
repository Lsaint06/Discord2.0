import { useEffect, useState } from 'react'
import type { InputMode, UserSettings } from '../types'
import type { MicrophoneAccess } from '../../../preload/types'
import type { MediaSession } from '../media/MediaSession'
import { describeKey, isValidPushToTalkKey } from '../media/voiceLogic'
import { Field, Toggle } from './SettingsControls'
import MicCheck from './MicCheck'

interface VoiceSettingsProps {
  session: MediaSession
  settings: UserSettings
  muted: boolean
  deafened: boolean
  onChange: (patch: Partial<UserSettings>) => void
  onToggleMute: () => void
  onToggleDeafen: () => void
}

interface Devices {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

const supportsOutputSelection =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

function deviceLabel(device: MediaDeviceInfo, index: number, kind: string): string {
  return device.label || `${kind} ${index + 1}`
}

function VoiceSettings({
  session,
  settings,
  muted,
  deafened,
  onChange,
  onToggleMute,
  onToggleDeafen
}: VoiceSettingsProps): React.JSX.Element {
  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [] })
  const [micAccess, setMicAccess] = useState<MicrophoneAccess>('unknown')
  const [binding, setBinding] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => [])
      if (cancelled) return
      setDevices({
        // "default"/"communications" are Windows aliases; the empty option already means default.
        inputs: all.filter(
          (d) => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId)
        ),
        outputs: all.filter(
          (d) => d.kind === 'audiooutput' && !['default', 'communications'].includes(d.deviceId)
        )
      })
    }
    void load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    void window.d2?.media.getMicrophoneAccess().then((access) => {
      if (!cancelled) setMicAccess(access)
    })
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', load)
    }
  }, [])

  useEffect(() => {
    if (!binding) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setBinding(false)
        return
      }
      if (isValidPushToTalkKey(e.code)) {
        onChange({ pushToTalkKey: e.code })
        setBinding(false)
      }
    }
    // Capture phase so the key never reaches other handlers (or the settings Escape handler).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [binding, onChange])

  const labelsHidden = devices.inputs.length > 0 && devices.inputs.every((d) => !d.label)

  return (
    <>
      <h2>Voice &amp; Audio</h2>

      {micAccess === 'denied' || micAccess === 'restricted' ? (
        <div className="dev-notice danger">
          <strong>Microphone access is blocked by Windows</strong>
          <span>
            Turn on &ldquo;Microphone access&rdquo; and &ldquo;Let desktop apps access your
            microphone&rdquo;, then rejoin voice.
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => void window.d2?.media.openMicrophoneSettings()}
          >
            Open Windows microphone settings
          </button>
        </div>
      ) : null}

      <div className="settings-grid">
        <Field label="Input Device">
          <select
            className="text-input"
            value={settings.inputDeviceId}
            onChange={(e) => onChange({ inputDeviceId: e.target.value })}
          >
            <option value="">Default</option>
            {devices.inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, i, 'Microphone')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Output Device">
          <select
            className="text-input"
            value={settings.outputDeviceId}
            disabled={!supportsOutputSelection}
            onChange={(e) => onChange({ outputDeviceId: e.target.value })}
          >
            <option value="">Default</option>
            {devices.outputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, i, 'Speaker')}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {labelsHidden && (
        <p className="settings-note">Device names appear after you join a voice channel once.</p>
      )}

      <div className="settings-grid">
        <Field label={`Input Volume — ${settings.inputVolume}%`}>
          <input
            className="slider"
            type="range"
            min={0}
            max={200}
            step={5}
            value={settings.inputVolume}
            onChange={(e) => onChange({ inputVolume: Number(e.target.value) })}
          />
        </Field>
        <Field label={`Output Volume — ${settings.outputVolume}%`}>
          <input
            className="slider"
            type="range"
            min={0}
            max={200}
            step={5}
            value={settings.outputVolume}
            onChange={(e) => onChange({ outputVolume: Number(e.target.value) })}
          />
        </Field>
      </div>

      <Field label="Input Mode">
        <div className="status-options" role="radiogroup">
          {(
            [
              ['voice-activity', 'Voice Activity'],
              ['push-to-talk', 'Push to Talk']
            ] as [InputMode, string][]
          ).map(([mode, label]) => (
            <label
              key={mode}
              className={`status-option${settings.inputMode === mode ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="input-mode"
                checked={settings.inputMode === mode}
                onChange={() => onChange({ inputMode: mode })}
              />
              {label}
            </label>
          ))}
        </div>
      </Field>

      {settings.inputMode === 'push-to-talk' && (
        <>
          <Field label="Push-to-Talk Key">
            <div className="inline-form">
              <span className="keybind">
                {binding ? 'Press a key… (Esc to cancel)' : describeKey(settings.pushToTalkKey)}
              </span>
              <button
                type="button"
                className="button primary"
                onClick={() => setBinding((b) => !b)}
              >
                {binding ? 'Cancel' : 'Change'}
              </button>
            </div>
          </Field>
          <Toggle
            label="System-wide push-to-talk (experimental)"
            description="Works while Discord 2.0 is in the background. Press once to talk, again to stop. Windows reserves the key while you're in voice, so pick one you don't type with (e.g. F8)."
            checked={settings.pushToTalkGlobal}
            onChange={(pushToTalkGlobal) => onChange({ pushToTalkGlobal })}
          />
        </>
      )}

      <MicCheck session={session} settings={settings} onChange={onChange} />

      <Toggle
        label="Echo Cancellation"
        checked={settings.echoCancellation}
        onChange={(echoCancellation) => onChange({ echoCancellation })}
      />
      <Toggle
        label="Noise Suppression"
        checked={settings.noiseSuppression}
        onChange={(noiseSuppression) => onChange({ noiseSuppression })}
      />
      <Toggle
        label="Automatic Gain Control"
        checked={settings.autoGainControl}
        onChange={(autoGainControl) => onChange({ autoGainControl })}
      />
      <Toggle label="Mute Microphone" checked={muted || deafened} onChange={onToggleMute} />
      <Toggle label="Deafen" checked={deafened} onChange={onToggleDeafen} />

      <h3 className="settings-subheading">Troubleshooting</h3>
      <ul className="settings-tips">
        <li>Nobody hears you? Run &ldquo;Let&rsquo;s Check&rdquo; and confirm the bar moves.</li>
        <li>
          Hearing echo? Use headphones, keep Echo Cancellation on, and avoid sharing system audio on
          Windows 10.
        </li>
        <li>Robotic or cutting-out audio usually means Wi-Fi loss; try a wired connection.</li>
        <li>Unplugged a headset? Discord 2.0 switches to your default device automatically.</li>
      </ul>
      <button
        type="button"
        className="button secondary"
        onClick={() =>
          onChange({
            inputDeviceId: '',
            outputDeviceId: '',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            inputVolume: 100,
            outputVolume: 100,
            inputSensitivityAuto: true
          })
        }
      >
        Reset Voice Settings
      </button>
    </>
  )
}

export default VoiceSettings
