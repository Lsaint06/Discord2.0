/**
 * GIF messages (Milestone 13). A GIF is sent as a plain link to the provider's page, so older
 * apps (and search) still show something useful; this app recognises such a message and shows
 * the GIF itself, streamed through the server.
 */

export interface GifRef {
  provider: 'giphy' | 'mock'
  id: string
}

const GIPHY = /^https:\/\/giphy\.com\/gifs\/(?:[A-Za-z0-9-]*-)?([A-Za-z0-9]{6,40})$/
const MOCK = /^https:\/\/gifs\.invalid\/(mock-[a-z]+-\d{1,4})$/

/** The message text for a GIF picked in the picker. */
export function gifMessageContent(provider: string, id: string): string {
  return provider === 'mock' ? `https://gifs.invalid/${id}` : `https://giphy.com/gifs/${id}`
}

/** The GIF a message consists of — only when the whole message is one GIF link. */
export function parseGifMessage(content: string): GifRef | null {
  const text = content.trim()
  if (text.length > 200 || /\s/.test(text)) return null
  const giphy = GIPHY.exec(text)
  if (giphy) return { provider: 'giphy', id: giphy[1]! }
  const mock = MOCK.exec(text)
  if (mock) return { provider: 'mock', id: mock[1]! }
  return null
}
