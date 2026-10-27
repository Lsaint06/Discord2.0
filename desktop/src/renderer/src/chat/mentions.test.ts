import { describe, expect, it } from 'vitest'
import { matchMentionAt, mentionCandidates } from './mentionMatch'
import { createMentionDetector, extractMentions, mentionsUser, selfMentionNames } from './mentions'
import { parseInline } from './markdown'

const me = { username: 'thereallsaint', displayName: 'The Real Saint' }
const others = ['bob', 'Bob Smith', 'bobby', 'ann', 'Ann Lee', 'lsaint06', 'L Saint']

describe('mention detection', () => {
  it('matches @username and @display name, case-insensitively', () => {
    expect(mentionsUser('hey @thereallsaint', me)).toBe(true)
    expect(mentionsUser('hey @TheRealLSaint', me)).toBe(true)
    expect(mentionsUser('hey @TheRealSaint', me)).toBe(false)
    expect(mentionsUser('ping @The Real Saint about it', me)).toBe(true)
    expect(mentionsUser('ping @the real saint', me)).toBe(true)
    expect(mentionsUser('@everyone meeting now', me)).toBe(true)
  })

  it('does not match partial names, similar usernames or emails', () => {
    const bob = { username: 'bob', displayName: 'Bob' }
    expect(mentionsUser('@bobby are you there', bob, others)).toBe(false)
    expect(mentionsUser('see @bob.smith later', bob, others)).toBe(false)
    expect(mentionsUser('mail bob@bob.com', bob)).toBe(false)
    expect(mentionsUser('@bob_jr', bob)).toBe(false)
    expect(mentionsUser('thanks @bob.', bob)).toBe(true)
    expect(mentionsUser('(@bob)', bob)).toBe(true)
    expect(mentionsUser('@bob, hi', bob)).toBe(true)
  })

  it('a longer known name wins: "@Ann Lee" is not a mention of "ann"', () => {
    const ann = { username: 'ann', displayName: 'ann' }
    expect(mentionsUser('hi @Ann Lee!', ann, others)).toBe(false)
    expect(mentionsUser('hi @Ann!', ann, others)).toBe(true)
    const annLee = { username: 'annl', displayName: 'Ann Lee' }
    expect(mentionsUser('hi @Ann Lee!', annLee, others)).toBe(true)
  })

  it('names with regex/special characters are matched literally', () => {
    const odd = { username: 'a.b-c', displayName: 'Dan (DJ) *Star*' }
    expect(mentionsUser('yo @Dan (DJ) *Star* !', odd)).toBe(true)
    expect(mentionsUser('yo @Dan (DJ) Star', odd)).toBe(false)
    expect(mentionsUser('@a.b-c ok', odd)).toBe(true)
    expect(mentionsUser('@aXb-c ok', odd)).toBe(false)
  })

  it('ignores mentions in code and escaped mentions, like rendering does', () => {
    expect(mentionsUser('`@thereallsaint` is my handle', me)).toBe(false)
    expect(mentionsUser('```\n@everyone\n```', me)).toBe(false)
    expect(mentionsUser('\\@everyone', me)).toBe(false)
    expect(mentionsUser('> quoted @thereallsaint', me)).toBe(true)
    expect(mentionsUser('**@thereallsaint**', me)).toBe(true)
  })

  it('other people are not me', () => {
    expect(mentionsUser('@lsaint06 and @L Saint', me, others)).toBe(false)
    expect(mentionsUser('hello saint', me)).toBe(false)
    expect(mentionsUser('', me)).toBe(false)
  })

  it('the detector caches and exposes the names for rendering', () => {
    const detector = createMentionDetector(me, others)
    expect(detector.mentions('@The Real Saint')).toBe(true)
    expect(detector.mentions('@The Real Saint')).toBe(true)
    expect(detector.selfNames.has('the real saint')).toBe(true)
    expect(detector.candidates[0]!.length).toBeGreaterThanOrEqual(
      detector.candidates.at(-1)!.length
    )
    expect(selfMentionNames(me)).toContain('everyone')
  })
})

describe('mention rendering', () => {
  it('renders multi-word display names as one mention when the names are known', () => {
    const names = mentionCandidates(others)
    expect(parseInline('hi @Ann Lee!', { mentionNames: names })).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', text: '@Ann Lee' },
      { type: 'text', text: '!' }
    ])
    // Without names it still recognizes a single word.
    expect(parseInline('hi @Ann Lee')[1]).toEqual({ type: 'mention', text: '@Ann' })
  })

  it('drops trailing punctuation from unknown single-word mentions', () => {
    expect(parseInline('thanks @someone.')[1]).toEqual({ type: 'mention', text: '@someone' })
    expect(matchMentionAt('a@b.c', 1, [])).toBeNull()
    expect(matchMentionAt('@', 0, [])).toBeNull()
  })

  it('extractMentions returns normalized names', () => {
    expect(extractMentions('@Bob Smith and @ANN', mentionCandidates(others))).toEqual([
      'bob smith',
      'ann'
    ])
  })
})
