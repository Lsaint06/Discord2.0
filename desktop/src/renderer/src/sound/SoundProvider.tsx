import { useEffect, type ReactNode } from 'react'
import type { SoundService } from './SoundService'
import type { SoundPreferences } from './soundPolicy'
import { SoundContext } from './soundContext'

interface SoundProviderProps {
  service: SoundService
  preferences: SoundPreferences
  /** Voice output device ('' = default); sound effects follow it. */
  outputDeviceId: string
  children: ReactNode
}

/** Owns the SoundService lifecycle for the signed-in workspace and shares it with settings. */
function SoundProvider({
  service,
  preferences,
  outputDeviceId,
  children
}: SoundProviderProps): React.JSX.Element {
  useEffect(() => {
    service.setPreferences(preferences)
  }, [service, preferences])

  useEffect(() => {
    service.setOutputDevice(outputDeviceId)
  }, [service, outputDeviceId])

  // Audio may only start after a user gesture; the first click or key press unlocks it.
  useEffect(() => {
    const unlock = (): void => service.unlock()
    window.addEventListener('pointerdown', unlock, { once: true, capture: true })
    window.addEventListener('keydown', unlock, { once: true, capture: true })
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true })
      window.removeEventListener('keydown', unlock, { capture: true })
    }
  }, [service])

  // Sign-out / window close: release the audio device.
  useEffect(() => () => service.dispose(), [service])

  return <SoundContext.Provider value={service}>{children}</SoundContext.Provider>
}

export default SoundProvider
