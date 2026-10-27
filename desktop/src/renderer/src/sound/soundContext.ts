import { createContext, useContext } from 'react'
import type { SoundService } from './SoundService'

/** The app's single SoundService (null outside the signed-in workspace). */
export const SoundContext = createContext<SoundService | null>(null)

export function useSoundService(): SoundService | null {
  return useContext(SoundContext)
}
