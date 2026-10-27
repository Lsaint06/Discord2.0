/**
 * Pure permission logic (no I/O). The access service (src/access.ts) loads memberships, role
 * permissions and channel overrides from the database and calls these functions; every route
 * and gateway event goes through it. Hiding a button in the UI is never the security boundary.
 */
import {
  ALL_PERMISSIONS,
  Permissions,
  ROLE_RANK,
  type ConfigurableRole,
  type ServerRole
} from '../protocol.js'

const P = Permissions

export const MEMBER_DEFAULT =
  P.viewChannel | P.sendMessages | P.attachFiles | P.addReactions | P.connect | P.speak | P.stream

export const MODERATOR_DEFAULT =
  MEMBER_DEFAULT | P.manageMessages | P.pinMessages | P.createInvites | P.kickMembers

export const ADMIN_DEFAULT =
  MODERATOR_DEFAULT |
  P.manageChannels |
  P.manageInvites |
  P.banMembers |
  P.manageRoles |
  P.manageServer

export const DEFAULT_ROLE_PERMISSIONS: Record<ConfigurableRole, number> = {
  admin: ADMIN_DEFAULT,
  moderator: MODERATOR_DEFAULT,
  member: MEMBER_DEFAULT
}

/** Bits that only make sense per channel (allowed in channel overrides). */
export const CHANNEL_PERMISSIONS =
  P.viewChannel |
  P.sendMessages |
  P.attachFiles |
  P.addReactions |
  P.manageMessages |
  P.pinMessages |
  P.connect |
  P.speak |
  P.stream

export const CONFIGURABLE_ROLES: ConfigurableRole[] = ['admin', 'moderator', 'member']

export function isConfigurableRole(value: unknown): value is ConfigurableRole {
  return value === 'admin' || value === 'moderator' || value === 'member'
}

export function isServerRole(value: unknown): value is ServerRole {
  return value === 'owner' || isConfigurableRole(value)
}

export interface Override {
  role: ConfigurableRole
  allow: number
  deny: number
}

/** Server-level permissions for a role. The owner always has everything. */
export function rolePermissions(
  role: ServerRole,
  configured: Partial<Record<ConfigurableRole, number>>
): number {
  if (role === 'owner') return ALL_PERMISSIONS
  return (configured[role] ?? DEFAULT_ROLE_PERMISSIONS[role]) & ALL_PERMISSIONS
}

/**
 * Effective permissions in one channel: role permissions, then the channel's override for that
 * role (deny first, then allow). Without View Channel you can do nothing in the channel.
 */
export function channelPermissions(
  role: ServerRole,
  configured: Partial<Record<ConfigurableRole, number>>,
  overrides: Override[]
): number {
  if (role === 'owner') return ALL_PERMISSIONS
  let perms = rolePermissions(role, configured)
  const o = overrides.find((x) => x.role === role)
  if (o) perms = (perms & ~(o.deny & CHANNEL_PERMISSIONS)) | (o.allow & CHANNEL_PERMISSIONS)
  return perms & P.viewChannel ? perms : 0
}

export const has = (perms: number, bit: number): boolean => (perms & bit) === bit

export const outranks = (actor: ServerRole, target: ServerRole): boolean =>
  ROLE_RANK[actor] > ROLE_RANK[target]

/**
 * Can `actor` change `target`'s role to `next`? Requires Manage Roles, and both the target's
 * current and new role must be strictly below the actor's. Ownership only moves by transfer.
 */
export function canAssignRole(
  actor: { role: ServerRole; permissions: number },
  targetRole: ServerRole,
  next: ServerRole
): boolean {
  if (next === 'owner' || targetRole === 'owner') return false
  return (
    has(actor.permissions, P.manageRoles) &&
    outranks(actor.role, targetRole) &&
    outranks(actor.role, next)
  )
}

/** Kick/ban: needs the permission and a strictly higher role than the target. */
export function canModerateMember(
  actor: { role: ServerRole; permissions: number },
  targetRole: ServerRole,
  bit: number
): boolean {
  return targetRole !== 'owner' && has(actor.permissions, bit) && outranks(actor.role, targetRole)
}

/**
 * Can `actor` set a role's server permissions / channel override bits? Only for roles below
 * their own, and never granting a permission they don't have themselves (no escalation).
 */
export function canConfigureRole(
  actor: { role: ServerRole; permissions: number },
  role: ConfigurableRole,
  grantedBits: number,
  requiredBit: number = P.manageRoles
): boolean {
  if (!has(actor.permissions, requiredBit) || !outranks(actor.role, role)) return false
  return (grantedBits & ~actor.permissions) === 0
}

export function permissionNames(bits: number): string[] {
  return Object.entries(P)
    .filter(([, bit]) => (bits & bit) === bit)
    .map(([name]) => name)
}
