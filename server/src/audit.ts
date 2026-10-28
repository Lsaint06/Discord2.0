/**
 * Security event log: authentication, account administration and moderation actions.
 * Stored in the audit_events table and mirrored to the server log. Callers pass only
 * non-secret details (never passwords, tokens or codes) — `detail` is also filtered here.
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import type { Repository } from './db/repository.js'

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.session_revoked'
  | 'auth.register'
  | 'auth.claim'
  | 'auth.password_changed'
  | 'auth.recovery_used'
  | 'auth.reset_used'
  | 'auth.recovery_codes_regenerated'
  | 'auth.dev_login'
  | 'auth.signup'
  | 'auth.email_verified'
  | 'auth.email_change_requested'
  | 'auth.email_changed'
  | 'auth.email_removed'
  | 'auth.password_reset_requested'
  | 'auth.email_reset_used'
  | 'admin.provision'
  | 'admin.registration_invite_created'
  | 'admin.registration_invite_revoked'
  | 'admin.claim_code_created'
  | 'admin.reset_code_created'
  | 'admin.account_disabled'
  | 'admin.account_enabled'
  | 'admin.merge'
  | 'admin.set_owner'
  | 'admin.profile_media_removed'
  | 'server.create'
  | 'server.update'
  | 'server.invite_created'
  | 'server.invite_revoked'
  | 'server.join'
  | 'server.leave'
  | 'server.kick'
  | 'server.ban'
  | 'server.unban'
  | 'server.role_changed'
  | 'server.role_permissions'
  | 'server.ownership_transferred'
  | 'server.icon_changed'
  | 'server.icon_removed'
  | 'server.timeout'
  | 'server.timeout_removed'
  | 'channel.create'
  | 'channel.update'
  | 'channel.delete'
  | 'channel.override'
  | 'channel.layout'
  | 'message.moderator_delete'

const SECRET_KEYS = /pass|token|secret|code|hash|authorization/i

function scrub(detail: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!detail) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEYS.test(key)) continue
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value
  }
  return out
}

export class AuditLog {
  constructor(
    private readonly repo: Repository,
    private readonly log: FastifyBaseLogger
  ) {}

  async record(event: {
    action: AuditAction
    actorId?: string | null
    targetUserId?: string | null
    serverId?: string | null
    request?: FastifyRequest | null
    ip?: string | null
    detail?: Record<string, unknown>
  }): Promise<void> {
    const detail = scrub(event.detail)
    const ip = event.ip ?? event.request?.ip ?? null
    const entry = {
      at: Date.now(),
      action: event.action,
      actorId: event.actorId ?? null,
      targetUserId: event.targetUserId ?? null,
      serverId: event.serverId ?? null,
      ip,
      detail
    }
    this.log.info({ audit: entry.action, actor: entry.actorId, target: entry.targetUserId, server: entry.serverId, ...(detail ?? {}) }, 'security event')
    try {
      await this.repo.addAuditEvent(entry)
    } catch (err) {
      this.log.error({ err, audit: entry.action }, 'failed to write audit event')
    }
  }
}
