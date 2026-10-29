import type { CameraState } from '../../media/CameraController'
import { CameraIcon } from '../Icons'

export interface CameraAvailability {
  ok: boolean
  /** Why the camera can't be used here (shown as the tooltip / note). */
  reason?: string
}

interface CameraButtonProps {
  camera: CameraState
  availability: CameraAvailability
  onToggle: () => void
  /** Icon-only round button (call view) instead of the labelled panel button. */
  round?: boolean
}

/** Camera on/off with distinct off / starting / live / unavailable / failed states. */
function CameraButton({
  camera,
  availability,
  onToggle,
  round
}: CameraButtonProps): React.JSX.Element {
  const on = camera.status === 'on'
  const starting = camera.status === 'starting'
  const failed = camera.status === 'error'
  const disabled = !availability.ok && !on && !starting
  const label = disabled
    ? (availability.reason ?? 'Camera unavailable')
    : starting
      ? 'Starting camera… (click to cancel)'
      : on
        ? 'Turn off camera'
        : failed
          ? 'Camera failed — try again'
          : 'Turn on camera'
  const state = on
    ? 'on'
    : starting
      ? 'starting'
      : failed
        ? 'failed'
        : disabled
          ? 'unavailable'
          : 'off'
  return (
    <button
      type="button"
      className={
        round ? `call-round-button camera-${state}` : `button small camera-button camera-${state}`
      }
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-camera={state}
    >
      <CameraIcon size={round ? 22 : 16} slashed={!on && !starting} />
      {!round && <span>{starting ? 'Starting…' : on ? 'Camera on' : 'Camera'}</span>}
      {on && <span className="camera-live-dot" aria-hidden="true" />}
    </button>
  )
}

export default CameraButton
