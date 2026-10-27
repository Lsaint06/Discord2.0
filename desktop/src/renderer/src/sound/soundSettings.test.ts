import { afterEach, describe, expect, it, vi } from 'vitest'

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('sound settings persistence', () => {
  it('migrates a pre-Milestone-9 "notification sounds off" choice and drops the old key', async () => {
    const store = stubStorage({
      'd2.settings': JSON.stringify({ notificationSounds: false, fontSize: 16 })
    })
    const session = await import('../net/session')
    const settings = session.loadSettings()
    expect(settings.soundEvents.message).toBe(false)
    expect(settings.soundEvents.mention).toBe(false)
    expect(settings.soundEvents.mute).toBe(true)
    expect(settings).not.toHaveProperty('notificationSounds')
    session.saveSettings(settings)
    expect(JSON.parse(store.get('d2.settings')!)).not.toHaveProperty('notificationSounds')
  })

  it('round-trips sound settings across restarts', async () => {
    stubStorage()
    let session = await import('../net/session')
    const settings = session.loadSettings()
    expect(settings.soundEffects).toBe(true)
    expect(settings.soundVolume).toBe(60)
    session.saveSettings({
      ...settings,
      soundEffects: false,
      soundVolume: 35,
      soundEvents: { ...settings.soundEvents, voiceJoin: false }
    })
    vi.resetModules()
    session = await import('../net/session')
    const reloaded = session.loadSettings()
    expect(reloaded.soundEffects).toBe(false)
    expect(reloaded.soundVolume).toBe(35)
    expect(reloaded.soundEvents.voiceJoin).toBe(false)
    expect(reloaded.soundEvents.message).toBe(true)
  })

  it('corrupt stored sound settings fall back to safe defaults', async () => {
    stubStorage({ 'd2.settings': JSON.stringify({ soundVolume: 'max', soundEvents: 'all' }) })
    const session = await import('../net/session')
    const settings = session.loadSettings()
    expect(settings.soundVolume).toBe(60)
    expect(settings.soundEvents.message).toBe(true)
  })
})
