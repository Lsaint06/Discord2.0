import type { ChannelType } from '../protocol.js'
import type { ChannelRecord, Repository } from './repository.js'

interface SeedChannel {
  slug: string
  name: string
  type: ChannelType
  topic?: string
}

interface SeedServer {
  id: string
  name: string
  color: string
  categories: { name: string; channels: SeedChannel[] }[]
}

export const SYSTEM_BOT_ID = 'system-orbit'

const seedServers: SeedServer[] = [
  {
    id: 'hangout',
    name: 'The Hangout',
    color: '#6d72f6',
    categories: [
      {
        name: 'Information',
        channels: [
          { slug: 'welcome', name: 'welcome', type: 'text', topic: 'Say hi and read the house rules.' },
          { slug: 'announcements', name: 'announcements', type: 'text', topic: 'Server news and updates.' }
        ]
      },
      {
        name: 'Text Channels',
        channels: [
          { slug: 'general', name: 'general', type: 'text', topic: 'Anything and everything.' },
          { slug: 'memes', name: 'memes', type: 'text', topic: 'Low effort, high reward.' },
          { slug: 'music', name: 'music', type: 'text', topic: 'Share what you are listening to.' }
        ]
      },
      {
        name: 'Voice Channels',
        channels: [
          { slug: 'lounge', name: 'Lounge', type: 'voice' },
          { slug: 'chill', name: 'Chill Zone', type: 'voice' },
          { slug: 'afk', name: 'AFK', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'gamenight',
    name: 'Game Night',
    color: '#3ba776',
    categories: [
      {
        name: 'Text Channels',
        channels: [
          { slug: 'lobby', name: 'lobby', type: 'text', topic: 'Plan the next session here.' },
          { slug: 'lfg', name: 'looking-for-group', type: 'text', topic: 'Need a squad? Ask here.' },
          { slug: 'clips', name: 'clips', type: 'text', topic: 'Post your best (and worst) moments.' }
        ]
      },
      {
        name: 'Voice Channels',
        channels: [
          { slug: 'squad', name: 'Squad Up', type: 'voice' },
          { slug: 'duo', name: 'Duo Queue', type: 'voice' }
        ]
      }
    ]
  },
  {
    id: 'studyhall',
    name: 'Study Hall',
    color: '#f0a43a',
    categories: [
      {
        name: 'Text Channels',
        channels: [
          { slug: 'homework', name: 'homework-help', type: 'text', topic: 'Ask questions, share resources.' },
          { slug: 'resources', name: 'resources', type: 'text', topic: 'Useful links and notes.' }
        ]
      },
      {
        name: 'Voice Channels',
        channels: [{ slug: 'focus', name: 'Focus Room', type: 'voice' }]
      }
    ]
  },
  {
    id: 'pixel',
    name: 'Pixel Art Club',
    color: '#e0607e',
    categories: [
      {
        name: 'Text Channels',
        channels: [
          { slug: 'showcase', name: 'showcase', type: 'text', topic: 'Show off your work.' },
          { slug: 'feedback', name: 'feedback', type: 'text', topic: 'Kind, honest critique.' }
        ]
      },
      {
        name: 'Voice Channels',
        channels: [{ slug: 'studio', name: 'Studio', type: 'voice' }]
      }
    ]
  }
]

/** Populates an empty database with starter servers so a fresh install is usable. Idempotent. */
export async function seedIfEmpty(repo: Repository): Promise<boolean> {
  if ((await repo.countServers()) > 0) return false
  const now = Date.now()

  if (!(await repo.getUser(SYSTEM_BOT_ID))) {
    await repo.createUser({
      id: SYSTEM_BOT_ID,
      username: 'orbit',
      displayName: 'Orbit',
      avatarColor: '#7a869a',
      bot: true,
      createdAt: now
    })
  }

  for (const [serverIndex, s] of seedServers.entries()) {
    const channels: ChannelRecord[] = []
    let position = 0
    for (const category of s.categories) {
      for (const c of category.channels) {
        channels.push({
          id: `${s.id}-${c.slug}`,
          serverId: s.id,
          name: c.name,
          type: c.type,
          topic: c.topic ?? null,
          category: category.name,
          position: position++,
          createdAt: now
        })
      }
    }
    await repo.createServer(
      { id: s.id, name: s.name, color: s.color, ownerId: null, position: serverIndex, createdAt: now },
      channels
    )
  }

  await repo.createMessage({
    channelId: 'hangout-welcome',
    authorId: SYSTEM_BOT_ID,
    content: 'Welcome to Discord 2.0! Messages here are stored on your own server.',
    createdAt: now
  })
  await repo.createMessage({
    channelId: 'hangout-general',
    authorId: SYSTEM_BOT_ID,
    content: 'This is #general. Open a second client and say hi 👋',
    createdAt: now
  })
  return true
}
