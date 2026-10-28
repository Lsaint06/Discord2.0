import { useEffect, useRef, type ReactNode } from 'react'
import type { SoundService } from './SoundService'
import type { SoundPreferences } from './soundPolicy'
import { SoundContext } from './soundContext'
import { listCustomSounds, loadCustomSoundData } from './customSounds'

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

  // Your own sounds that the settings use: loaded from this PC's library once, then kept by the
  // service (a deleted or broken file simply falls back to the built-in sound).
  const registered = useRef(new Set<string>())
  const customIds = Object.values(preferences.custom ?? {})
    .filter((id): id is string => typeof id === 'string')
    .sort()
    .join(',')
  useEffect(() => {
    const wanted = customIds ? customIds.split(',') : []
    const missing = wanted.filter((id) => !registered.current.has(id))
    if (missing.length === 0) return
    let cancelled = false
    void listCustomSounds()
      .then(async (library) => {
        for (const id of missing) {
          const meta = library.find((m) => m.id === id)
          const data = meta ? await loadCustomSoundData(id) : null
          if (cancelled || !meta || !data) continue
          service.setCustomSound(id, { data, gain: meta.gain })
          registered.current.add(id)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [service, customIds])

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
