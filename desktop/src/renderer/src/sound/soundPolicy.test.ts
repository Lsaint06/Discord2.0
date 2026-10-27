import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOUND_EVENTS,
  DEFAULT_SOUND_VOLUME,
  eventEnabled,
  messageSound,
  migrateSoundSettings,
  SeenMessages,
  SoundGate,
  type MessageSoundContext,
  type SoundPreferences
} from './soundPolicy'

const prefs = (patch: Partial<SoundPreferences> = {}): SoundPreferences => ({
  enabled: true,
  volume: 60,
  events: { ...DEFAULT_SOUND_EVENTS },
  ...patch
})
const ctx = (patch: Partial<MessageSoundContext> = {}): MessageSoundContext => ({
  meId: 'me',
  doNotDisturb: false,
  mutedChannels: {},
  activeChannelId: 'general',
  windowFocused: true,
  mentionsMe: false,
  ...patch
})
const msg = { authorId: 'bob', channelId: 'memes' }

describe('message sound rules', () => {
  it('plays a message chime for other channels and a mention sound for mentions', () => {
    expect(messageSound(msg, ctx(), prefs())).toBe('message')
    expect(messageSound(msg, ctx({ mentionsMe: true }), prefs())).toBe('mention')
  })

  it('never for your own messages (optimistic echoes included)', () => {
    expect(messageSound({ ...msg, authorId: 'me' }, ctx({ mentionsMe: true }), prefs())).toBeNull()
  })

  it('follows notification eligibility for the conversation on screen', () => {
    expect(messageSound({ ...msg, channelId: 'general' }, ctx(), prefs())).toBeNull()
    // Same channel but the window is in the background: you aren't looking at it.
    expect(
      messageSound({ ...msg, channelId: 'general' }, ctx({ windowFocused: false }), prefs())
    ).toBe('message')
  })

  it('Do Not Disturb and muted channels silence messages and mentions', () => {
    expect(messageSound(msg, ctx({ doNotDisturb: true, mentionsMe: true }), prefs())).toBeNull()
    expect(
      messageSound(msg, ctx({ mutedChannels: { memes: true }, mentionsMe: true }), prefs())
    ).toBeNull()
  })

  it('global switch, volume 0 and per-event toggles', () => {
    expect(messageSound(msg, ctx({ mentionsMe: true }), prefs({ enabled: false }))).toBeNull()
    expect(eventEnabled(prefs({ volume: 0 }), 'mute')).toBe(false)
    const noMention = prefs({ events: { ...DEFAULT_SOUND_EVENTS, mention: false } })
    // A mention with the mention sound off still counts as a message.
    expect(messageSound(msg, ctx({ mentionsMe: true }), noMention)).toBe('message')
    const silent = prefs({ events: { ...DEFAULT_SOUND_EVENTS, mention: false, message: false } })
    expect(messageSound(msg, ctx({ mentionsMe: true }), silent)).toBeNull()
    expect(
      eventEnabled(prefs({ events: { ...DEFAULT_SOUND_EVENTS, voiceJoin: false } }), 'voiceJoin')
    ).toBe(false)
  })
})

describe('deduplication', () => {
  it('a message id sounds only once (repeated server events, reconnect echoes)', () => {
    const seen = new SeenMessages()
    expect(seen.firstTime('42')).toBe(true)
    expect(seen.firstTime('42')).toBe(false)
    expect(seen.firstTime('43')).toBe(true)
  })

  it('stays bounded', () => {
    const seen = new SeenMessages(3)
    for (const id of ['1', '2', '3', '4']) seen.firstTime(id)
    expect(seen.firstTime('1')).toBe(true) // oldest was forgotten
    expect(seen.firstTime('4')).toBe(false)
  })
})

describe('burst control', () => {
  it('coalesces a burst of messages into one chime', () => {
    const gate = new SoundGate()
    expect(gate.admit('message', 0)).toEqual({ play: true, delayMs: 0 })
    expect(gate.admit('message', 200).play).toBe(false)
    expect(gate.admit('message', 600).play).toBe(false)
    expect(gate.admit('message', 1000).play).toBe(true)
  })

  it('spaces out distinct mentions instead of dropping them, up to a small backlog', () => {
    const gate = new SoundGate()
    const results = [0, 10, 20, 30, 40].map((t) => gate.admit('mention', t))
    expect(results.slice(0, 3).every((r) => r.play)).toBe(true)
    expect(results[1]).toEqual({ play: true, delayMs: 340 })
    expect(results[2]).toEqual({ play: true, delayMs: 680 })
    // Beyond the backlog it's a flood: dropped.
    expect(results[4]!.play).toBe(false)
    // Later mentions play again normally.
    expect(gate.admit('mention', 5000)).toEqual({ play: true, delayMs: 0 })
  })

  it('a mention covers the message chime for the same moment', () => {
    const gate = new SoundGate()
    expect(gate.admit('mention', 0).play).toBe(true)
    expect(gate.admit('message', 100).play).toBe(false)
    expect(gate.admit('message', 2000).play).toBe(true)
  })

  it('quick mute/unmute presses each get feedback', () => {
    const gate = new SoundGate()
    expect(gate.admit('mute', 0).play).toBe(true)
    expect(gate.admit('unmute', 80).play).toBe(true)
    expect(gate.admit('mute', 160).play).toBe(true)
  })
})

describe('settings migration', () => {
  it('defaults for new installs', () => {
    expect(migrateSoundSettings({})).toEqual({
      soundEffects: true,
      soundVolume: DEFAULT_SOUND_VOLUME,
      soundEvents: DEFAULT_SOUND_EVENTS
    })
  })

  it('keeps silence for people who had turned notification sounds off', () => {
    const migrated = migrateSoundSettings({ notificationSounds: false })
    expect(migrated.soundEvents.message).toBe(false)
    expect(migrated.soundEvents.mention).toBe(false)
    expect(migrated.soundEvents.voiceJoin).toBe(true)
    expect(migrateSoundSettings({ notificationSounds: true }).soundEvents.message).toBe(true)
  })

  it('saved sound settings win over the old setting and are validated', () => {
    const migrated = migrateSoundSettings({
      notificationSounds: false,
      soundEffects: false,
      soundVolume: 250,
      soundEvents: { message: true, mute: false, bogus: true, mention: 'yes' }
    })
    expect(migrated.soundEffects).toBe(false)
    expect(migrated.soundVolume).toBe(100)
    expect(migrated.soundEvents.message).toBe(true)
    expect(migrated.soundEvents.mute).toBe(false)
    expect(migrated.soundEvents.mention).toBe(true) // invalid value → default
    expect(migrated.soundEvents).not.toHaveProperty('bogus')
    expect(migrateSoundSettings({ soundVolume: 'loud' }).soundVolume).toBe(DEFAULT_SOUND_VOLUME)
    expect(migrateSoundSettings({ soundVolume: -5 }).soundVolume).toBe(0)
  })
})
