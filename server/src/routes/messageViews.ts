import type { AttachmentRecord, MessageRecord, Repository } from '../db/repository.js'
import {
  LIMITS,
  type ApiAttachment,
  type ApiMessage,
  type ApiMessageReference,
  type ApiReaction
} from '../protocol.js'

export function toApiAttachment(a: AttachmentRecord): ApiAttachment {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    kind: a.kind,
    size: a.size,
    ...(a.width !== null && a.height !== null ? { width: a.width, height: a.height } : {})
  }
}

function preview(content: string): string {
  return content.length > LIMITS.replyPreviewLength
    ? `${content.slice(0, LIMITS.replyPreviewLength - 1)}…`
    : content
}

/**
 * Turns stored messages into API messages with attachments, reactions (incl. the viewer's own),
 * pin state and reply previews — a fixed number of batched queries regardless of page size.
 */
export async function buildApiMessages(
  repo: Repository,
  records: MessageRecord[],
  viewerId: string,
  nonce?: string
): Promise<ApiMessage[]> {
  if (records.length === 0) return []
  const ids = records.map((m) => m.id)
  const replyIds = [...new Set(records.flatMap((m) => (m.replyToId ? [m.replyToId] : [])))]

  const [attachments, reactions, pinned, parents] = await Promise.all([
    repo.attachmentsForMessages(ids),
    repo.reactionsForMessages(ids, viewerId),
    repo.pinnedAmong(ids),
    repo.getMessages(replyIds)
  ])
  const parentAttachments = await repo.attachmentsForMessages(parents.map((p) => p.id))

  const attachmentsBy = new Map<string, ApiAttachment[]>()
  for (const a of attachments) {
    const key = a.messageId ?? ''
    attachmentsBy.set(key, [...(attachmentsBy.get(key) ?? []), toApiAttachment(a)])
  }
  const reactionsBy = new Map<string, ApiReaction[]>()
  for (const r of reactions) {
    reactionsBy.set(r.messageId, [
      ...(reactionsBy.get(r.messageId) ?? []),
      { emoji: r.emoji, count: r.count, me: r.me }
    ])
  }
  const parentCounts = new Map<string, number>()
  for (const a of parentAttachments) {
    if (a.messageId) parentCounts.set(a.messageId, (parentCounts.get(a.messageId) ?? 0) + 1)
  }
  const parentsById = new Map(parents.map((p) => [p.id, p]))

  return records.map((m) => {
    let replyTo: ApiMessageReference | null = null
    if (m.replyToId) {
      const parent = parentsById.get(m.replyToId)
      replyTo = parent
        ? {
            id: parent.id,
            deleted: false,
            authorId: parent.authorId,
            content: preview(parent.content),
            attachmentCount: parentCounts.get(parent.id) ?? 0
          }
        : { id: m.replyToId, deleted: true }
    }
    return {
      id: m.id,
      channelId: m.channelId,
      authorId: m.authorId,
      content: m.content,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      replyTo,
      attachments: attachmentsBy.get(m.id) ?? [],
      reactions: reactionsBy.get(m.id) ?? [],
      pinned: pinned.has(m.id),
      ...(nonce ? { nonce } : {})
    }
  })
}

/** For broadcasts: the viewer-specific `me` flag must be false for everyone. */
export async function buildBroadcastMessage(
  repo: Repository,
  record: MessageRecord,
  nonce?: string
): Promise<ApiMessage> {
  const [message] = await buildApiMessages(repo, [record], '', nonce)
  return message!
}
