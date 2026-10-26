import { useEffect, useState } from 'react'
import type { EncoderFlagsState } from '../../../preload/types'
import { Toggle } from './SettingsControls'

/** Startup-time encoder options stored by the main process (desktop app only). */
function EncoderSettings(): React.JSX.Element | null {
  const bridge = window.d2
  const [flags, setFlags] = useState<EncoderFlagsState | null>(null)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge.diagnostics.getEncoderFlags().then((f) => {
      if (!cancelled) setFlags(f)
    })
    return () => {
      cancelled = true
    }
  }, [bridge])

  if (!bridge || !flags) return null
  const pending = flags.saved.av1HardwareEncode !== flags.active.av1HardwareEncode

  return (
    <>
      <Toggle
        label="Hardware AV1 encoding"
        description="Uses the GPU AV1 encoder (RTX 40, Radeon RX 7000, Intel Arc) through Chromium's WebRtcAV1HWEncode feature, which Chromium leaves off on Windows by default. Without it AV1 is encoded in software. Turn off if AV1 streams glitch on your GPU driver."
        checked={flags.saved.av1HardwareEncode}
        onChange={(av1HardwareEncode) =>
          void bridge.diagnostics
            .setEncoderFlags({ av1HardwareEncode })
            .then((f) => f && setFlags(f))
        }
      />
      {pending && (
        <div className="inline-form">
          <span className="field-hint">Takes effect after restarting Discord 2.0.</span>
          <button
            type="button"
            className="button secondary"
            onClick={() => void bridge.diagnostics.relaunch()}
          >
            Restart now
          </button>
        </div>
      )}
    </>
  )
}

export default EncoderSettings
