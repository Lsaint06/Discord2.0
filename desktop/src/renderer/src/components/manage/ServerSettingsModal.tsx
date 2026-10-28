import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../net/api'
import { ApiError } from '../../net/api'
import {
  LIMITS,
  Permissions,
  ROLE_RANK,
  type ApiAuditEvent,
  type ApiBan,
  type ApiChannelOverride,
  type ApiMember,
  type ApiRolePermissions,
  type ApiServer,
  type ApiServerInvite,
  type ConfigurableRole,
  type NotificationLevel,
  type ServerRole
} from '../../net/protocol'
import type { User } from '../../types'
import { accentChoices } from '../../data/defaults'
import {
  PERMISSION_INFO,
  ROLE_COLORS,
  ROLE_LABELS,
  bit,
  hasPermission
} from '../../lib/permissions'
import { formatTimestamp } from '../../lib/format'
import { checkProfileImageFile, PROFILE_IMAGE_ACCEPT } from '../../lib/profileMedia'
import {
  categoriesOf,
  layoutOf,
  moveCategory,
  moveChannel,
  renameCategory,
  sameLayout,
  setChannelCategory,
  type LayoutEntry
} from '../../lib/channelLayout'
import { TIMEOUT_CHOICES, timeoutLength, timeoutRemaining } from '../../lib/timeouts'
import Avatar from '../Avatar'
import { CloseIcon } from '../Icons'
import { ServerGlyph } from '../ServerSidebar'
import { Field } from '../SettingsControls'
import { useDialog } from '../../hooks/useDialog'
import PasswordInput from '../auth/PasswordInput'

type Tab =
  'overview' | 'members' | 'invites' | 'bans' | 'roles' | 'channels' | 'audit' | 'ownership'

interface ServerSettingsModalProps {
  api: ApiClient
  server: ApiServer
  meId: string
  members: ApiMember[] | undefined
  /** Bumps when the server reports changes (refetch lists). */
  revision: number
  resolveUser: (id: string) => User
  onInvite: () => void
  onClose: () => void
}

const CONFIG_ROLES: ConfigurableRole[] = ['admin', 'moderator', 'member']
const errorText = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Something went wrong.'

function useAction(): {
  busy: boolean
  error: string | null
  setError: (e: string | null) => void
  run: (fn: () => Promise<void>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}

function ServerSettingsModal(props: ServerSettingsModalProps): React.JSX.Element {
  const { api, server, meId, resolveUser, onClose } = props
  const role: ServerRole = server.role ?? 'member'
  const perms = server.permissions ?? 0
  const can = (b: number): boolean => hasPermission(perms, b)
  const tabs = useMemo(() => {
    const list: { id: Tab; label: string }[] = []
    if (can(Permissions.manageServer)) list.push({ id: 'overview', label: 'Overview' })
    list.push({ id: 'members', label: 'Members' })
    if (can(Permissions.createInvites) || can(Permissions.manageInvites))
      list.push({ id: 'invites', label: 'Invites' })
    if (can(Permissions.banMembers)) list.push({ id: 'bans', label: 'Bans' })
    if (can(Permissions.manageRoles)) list.push({ id: 'roles', label: 'Roles' })
    if (can(Permissions.manageChannels)) list.push({ id: 'channels', label: 'Channels' })
    if (can(Permissions.manageServer)) list.push({ id: 'audit', label: 'Audit Log' })
    if (role === 'owner') list.push({ id: 'ownership', label: 'Ownership' })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms, role])
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'members')

  const dialogRef = useDialog<HTMLDivElement>({ onClose })

  return (
    <div
      ref={dialogRef}
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${server.name} settings`}
    >
      <nav className="settings-nav">
        <div className="settings-nav-inner">
          <h4>{server.name}</h4>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-nav-item${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <div className="settings-nav-separator" />
          <span className="settings-nav-note">
            Your role: <strong style={{ color: ROLE_COLORS[role] }}>{ROLE_LABELS[role]}</strong>
          </span>
        </div>
      </nav>
      <div className="settings-content">
        <div className="settings-content-inner">
          {tab === 'overview' && <OverviewTab api={api} server={server} />}
          {tab === 'members' && (
            <MembersTab
              api={api}
              server={server}
              meId={meId}
              role={role}
              perms={perms}
              members={props.members}
              resolveUser={resolveUser}
              onInvite={props.onInvite}
            />
          )}
          {tab === 'invites' && (
            <InvitesTab
              api={api}
              server={server}
              meId={meId}
              perms={perms}
              revision={props.revision}
              resolveUser={resolveUser}
              onInvite={props.onInvite}
            />
          )}
          {tab === 'bans' && (
            <BansTab
              api={api}
              server={server}
              revision={props.revision}
              resolveUser={resolveUser}
            />
          )}
          {tab === 'roles' && (
            <RolesTab
              api={api}
              server={server}
              role={role}
              perms={perms}
              revision={props.revision}
            />
          )}
          {tab === 'channels' && (
            <ChannelsTab api={api} server={server} role={role} perms={perms} />
          )}
          {tab === 'audit' && (
            <AuditTab
              api={api}
              server={server}
              revision={props.revision}
              resolveUser={resolveUser}
            />
          )}
          {tab === 'ownership' && (
            <OwnershipTab
              api={api}
              server={server}
              meId={meId}
              members={props.members}
              resolveUser={resolveUser}
            />
          )}
        </div>
        <div className="settings-close">
          <button type="button" onClick={onClose} aria-label="Close server settings">
            <CloseIcon size={20} />
          </button>
          <span>ESC</span>
        </div>
      </div>
    </div>
  )
}

function OverviewTab({ api, server }: { api: ApiClient; server: ApiServer }): React.JSX.Element {
  const [name, setName] = useState(server.name)
  const [color, setColor] = useState(server.color)
  const [description, setDescription] = useState(server.description ?? '')
  const [notifications, setNotifications] = useState<NotificationLevel>(
    server.defaultNotifications ?? 'all'
  )
  const { busy, error, run } = useAction()
  const icon = useAction()
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const supportsAdmin = server.defaultNotifications !== undefined
  const changed =
    name.trim() !== server.name ||
    color !== server.color ||
    (supportsAdmin &&
      (description.trim() !== (server.description ?? '') ||
        notifications !== (server.defaultNotifications ?? 'all')))
  const edited = (): void => setSaved(false)
  return (
    <>
      <h2>Server Overview</h2>
      {supportsAdmin && (
        <div className="server-icon-editor">
          <div
            className="server-icon server-icon-preview"
            style={{ '--server-color': server.color } as React.CSSProperties}
            aria-hidden="true"
          >
            <ServerGlyph server={server} size="full" />
          </div>
          <div className="server-icon-actions">
            <span className="setting-field-label">Server Icon</span>
            <span className="setting-description">
              A square image of at least {LIMITS.serverIconMinSize}×{LIMITS.serverIconMinSize}{' '}
              pixels (PNG, JPEG, WebP or GIF). It&rsquo;s cropped to a square and only members can
              see it.
            </span>
            <div className="inline-actions">
              <button
                type="button"
                className="button secondary small"
                disabled={icon.busy}
                onClick={() => fileRef.current?.click()}
              >
                {icon.busy ? 'Uploading…' : server.iconId ? 'Change Icon' : 'Upload Icon'}
              </button>
              {server.iconId && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={icon.busy}
                  onClick={() =>
                    void icon.run(() => api.removeServerIcon(server.id).then(() => undefined))
                  }
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={PROFILE_IMAGE_ACCEPT}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                const problem = checkProfileImageFile(file)
                if (problem) {
                  icon.setError(problem)
                  return
                }
                void icon.run(() => api.uploadServerIcon(server.id, file).then(() => undefined))
              }}
            />
            {icon.error && (
              <p className="form-error" role="alert">
                {icon.error}
              </p>
            )}
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await api.updateServer(server.id, {
              name: name.trim(),
              color,
              ...(supportsAdmin
                ? { description: description.trim() || null, defaultNotifications: notifications }
                : {})
            })
            setSaved(true)
          })
        }}
      >
        <Field label="Server Name">
          <input
            className="text-input"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value)
              edited()
            }}
          />
        </Field>
        {supportsAdmin && (
          <Field label="Description">
            <textarea
              className="text-input description-input"
              value={description}
              rows={3}
              maxLength={LIMITS.serverDescriptionMaxLength}
              placeholder="What is this server about?"
              onChange={(e) => {
                setDescription(e.target.value)
                edited()
              }}
            />
          </Field>
        )}
        <div className="setting-field">
          <span className="setting-field-label">Color</span>
          <div className="swatches">
            {accentChoices.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  setColor(c)
                  edited()
                }}
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
              />
            ))}
          </div>
        </div>
        {supportsAdmin && (
          <Field label="Default notifications">
            <select
              className="text-input"
              value={notifications}
              onChange={(e) => {
                setNotifications(e.target.value as NotificationLevel)
                edited()
              }}
            >
              <option value="all">All messages</option>
              <option value="mentions">Only @mentions</option>
            </select>
            <span className="setting-description">
              What members are notified about in this server unless they choose otherwise.
            </span>
          </Field>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button primary"
          disabled={!changed || busy || !name.trim()}
        >
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save Changes'}
        </button>
      </form>
    </>
  )
}

function MembersTab(props: {
  api: ApiClient
  server: ApiServer
  meId: string
  role: ServerRole
  perms: number
  members: ApiMember[] | undefined
  resolveUser: (id: string) => User
  onInvite: () => void
}): React.JSX.Element {
  const { api, server, meId, role, perms, resolveUser } = props
  const { busy, error, run } = useAction()
  const [banFor, setBanFor] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const banDialogRef = useDialog<HTMLFormElement>({
    open: banFor !== null,
    onClose: () => setBanFor(null)
  })
  const [timeoutFor, setTimeoutFor] = useState<string | null>(null)
  const [timeoutMinutes, setTimeoutMinutes] = useState(TIMEOUT_CHOICES[2]!.minutes)
  const [timeoutReason, setTimeoutReason] = useState('')
  const timeoutDialogRef = useDialog<HTMLFormElement>({
    open: timeoutFor !== null,
    onClose: () => setTimeoutFor(null)
  })
  // Re-renders the "… left" labels now and then.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const [filter, setFilter] = useState('')
  const outranks = (target: ServerRole): boolean => ROLE_RANK[role] > ROLE_RANK[target]
  const members = [...(props.members ?? [])]
    .sort(
      (a, b) =>
        ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
        resolveUser(a.userId).name.localeCompare(resolveUser(b.userId).name)
    )
    .filter(
      (m) => !filter || resolveUser(m.userId).name.toLowerCase().includes(filter.toLowerCase())
    )
  const assignable = CONFIG_ROLES.filter((r) => outranks(r))

  return (
    <>
      <h2>Members — {props.members?.length ?? '…'}</h2>
      <div className="manage-toolbar">
        <input
          className="text-input"
          placeholder="Search members"
          aria-label="Search members"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {(hasPermission(perms, Permissions.createInvites) ||
          hasPermission(perms, Permissions.manageInvites)) && (
          <button type="button" className="button primary" onClick={props.onInvite}>
            Invite People
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="manage-list" aria-label="Members">
        {members.map((m) => {
          const user = resolveUser(m.userId)
          const self = m.userId === meId
          const canChangeRole =
            hasPermission(perms, Permissions.manageRoles) &&
            !self &&
            m.role !== 'owner' &&
            outranks(m.role)
          const canKick =
            hasPermission(perms, Permissions.kickMembers) &&
            !self &&
            m.role !== 'owner' &&
            outranks(m.role)
          const canBan =
            hasPermission(perms, Permissions.banMembers) &&
            !self &&
            m.role !== 'owner' &&
            outranks(m.role)
          const canTimeout =
            hasPermission(perms, Permissions.moderateMembers) &&
            !self &&
            m.role !== 'owner' &&
            outranks(m.role)
          const remaining = timeoutRemaining(m.timeoutUntil, now)
          return (
            <li key={m.userId} className="manage-row">
              <Avatar name={user.name} color={user.avatarColor} imageId={user.avatarId} size={32} />
              <div className="manage-row-main">
                <span className="manage-row-title" style={{ color: ROLE_COLORS[m.role] }}>
                  {user.name}
                  {self && <span className="manage-tag">you</span>}
                  {remaining && (
                    <span className="manage-tag timeout-tag" title="Timed out">
                      timed out · {remaining} left
                    </span>
                  )}
                </span>
                <span className="manage-row-sub">Joined {formatTimestamp(m.joinedAt)}</span>
              </div>
              {canChangeRole ? (
                <select
                  className="text-input compact"
                  aria-label={`Role of ${user.name}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() =>
                      api
                        .setMemberRole(server.id, m.userId, e.target.value as ConfigurableRole)
                        .then(() => undefined)
                    )
                  }
                >
                  {[m.role, ...assignable.filter((r) => r !== m.role)].map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="role-pill" style={{ borderColor: ROLE_COLORS[m.role] }}>
                  {ROLE_LABELS[m.role]}
                </span>
              )}
              {canTimeout &&
                (remaining ? (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.setMemberTimeout(server.id, m.userId, null).then(() => undefined)
                      )
                    }
                  >
                    Remove Timeout
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={() => setTimeoutFor(m.userId)}
                  >
                    Timeout
                  </button>
                ))}
              {canKick && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Kick ${user.name} from ${server.name}? They can rejoin with an invite.`
                      )
                    ) {
                      void run(() => api.kickMember(server.id, m.userId))
                    }
                  }}
                >
                  Kick
                </button>
              )}
              {canBan && (
                <button
                  type="button"
                  className="button danger small"
                  disabled={busy}
                  onClick={() => setBanFor(m.userId)}
                >
                  Ban
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {banFor && (
        <div className="modal-backdrop" onMouseDown={() => setBanFor(null)}>
          <form
            ref={banDialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              void run(() =>
                api.banMember(server.id, banFor, reason.trim() || undefined).then(() => undefined)
              ).then((ok) => {
                if (ok) {
                  setBanFor(null)
                  setReason('')
                }
              })
            }}
          >
            <h2>Ban {resolveUser(banFor).name}?</h2>
            <p>
              They are removed now, disconnected from voice, and can&rsquo;t rejoin until unbanned.
            </p>
            <Field label="Reason (optional, visible to moderators)">
              <input
                className="text-input"
                value={reason}
                maxLength={200}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className="modal-footer">
              <button type="button" className="button secondary" onClick={() => setBanFor(null)}>
                Cancel
              </button>
              <button type="submit" className="button danger" disabled={busy}>
                Ban
              </button>
            </div>
          </form>
        </div>
      )}
      {timeoutFor && (
        <div className="modal-backdrop" onMouseDown={() => setTimeoutFor(null)}>
          <form
            ref={timeoutDialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="timeout-title"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              void run(() =>
                api
                  .setMemberTimeout(
                    server.id,
                    timeoutFor,
                    timeoutMinutes,
                    timeoutReason.trim() || undefined
                  )
                  .then(() => undefined)
              ).then((ok) => {
                if (ok) {
                  setTimeoutFor(null)
                  setTimeoutReason('')
                }
              })
            }}
          >
            <h2 id="timeout-title">Time out {resolveUser(timeoutFor).name}?</h2>
            <p>
              They can still read, but can&rsquo;t send messages, react, upload, join or speak in
              voice until the timeout ends. You can remove it early.
            </p>
            <div className="setting-field" role="radiogroup" aria-label="Duration">
              <span className="setting-field-label">Duration</span>
              <div className="timeout-choices">
                {TIMEOUT_CHOICES.map((c) => (
                  <label key={c.minutes} className="checkbox-row">
                    <input
                      type="radio"
                      name="timeout-duration"
                      checked={timeoutMinutes === c.minutes}
                      onChange={() => setTimeoutMinutes(c.minutes)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
            <Field label="Reason (optional, for the audit log)">
              <input
                className="text-input"
                value={timeoutReason}
                maxLength={LIMITS.banReasonMaxLength}
                onChange={(e) => setTimeoutReason(e.target.value)}
              />
            </Field>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setTimeoutFor(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button danger" disabled={busy}>
                Time Out
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}

function InvitesTab(props: {
  api: ApiClient
  server: ApiServer
  meId: string
  perms: number
  revision: number
  resolveUser: (id: string) => User
  onInvite: () => void
}): React.JSX.Element {
  const { api, server, meId, perms, resolveUser } = props
  const [invites, setInvites] = useState<ApiServerInvite[] | null>(null)
  const [now, setNow] = useState(0)
  const { busy, error, run } = useAction()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    api
      .invites(server.id)
      .then((list) => {
        if (cancelled) return
        setInvites(list)
        setNow(Date.now())
      })
      .catch(() => !cancelled && setInvites([]))
    return () => {
      cancelled = true
    }
  }, [api, server.id, props.revision, reload])
  const manage = hasPermission(perms, Permissions.manageInvites)
  return (
    <>
      <h2>Invites</h2>
      <p className="setting-description">
        Codes are shown once when created. Every invite expires; you can also limit how many people
        can use it.
        {manage
          ? ' You can see and revoke everyone’s invites.'
          : ' You can see and revoke your own invites.'}
      </p>
      <div className="manage-toolbar">
        <button type="button" className="button primary" onClick={props.onInvite}>
          Create Invite
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {invites === null ? (
        <p className="setting-description">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="setting-description">No invites yet.</p>
      ) : (
        <ul className="manage-list">
          {invites.map((i) => {
            const expired = i.expiresAt !== null && i.expiresAt <= now
            const exhausted = i.maxUses !== null && i.uses >= i.maxUses
            const state = i.revoked
              ? 'Revoked'
              : expired
                ? 'Expired'
                : exhausted
                  ? 'Used up'
                  : 'Active'
            return (
              <li key={i.id} className={`manage-row${state !== 'Active' ? ' inactive' : ''}`}>
                <div className="manage-row-main">
                  <span className="manage-row-title">
                    {state} · {i.uses}
                    {i.maxUses ? ` / ${i.maxUses}` : ''} uses
                  </span>
                  <span className="manage-row-sub">
                    By {i.createdBy ? resolveUser(i.createdBy).name : 'unknown'} · created{' '}
                    {formatTimestamp(i.createdAt)}
                    {i.expiresAt ? ` · expires ${formatTimestamp(i.expiresAt)}` : ''}
                  </span>
                </div>
                {state === 'Active' && (manage || i.createdBy === meId) && (
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={() =>
                      void run(() => api.revokeInvite(server.id, i.id)).then(() =>
                        setReload((n) => n + 1)
                      )
                    }
                  >
                    Revoke
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function BansTab(props: {
  api: ApiClient
  server: ApiServer
  revision: number
  resolveUser: (id: string) => User
}): React.JSX.Element {
  const { api, server, resolveUser } = props
  const [bans, setBans] = useState<ApiBan[] | null>(null)
  const [reload, setReload] = useState(0)
  const { busy, error, run } = useAction()
  useEffect(() => {
    let cancelled = false
    api
      .bans(server.id)
      .then((list) => !cancelled && setBans(list))
      .catch(() => !cancelled && setBans([]))
    return () => {
      cancelled = true
    }
  }, [api, server.id, props.revision, reload])
  return (
    <>
      <h2>Bans</h2>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {bans === null ? (
        <p className="setting-description">Loading…</p>
      ) : bans.length === 0 ? (
        <p className="setting-description">Nobody is banned.</p>
      ) : (
        <ul className="manage-list">
          {bans.map((b) => (
            <li key={b.userId} className="manage-row">
              <div className="manage-row-main">
                <span className="manage-row-title">{resolveUser(b.userId).name}</span>
                <span className="manage-row-sub">
                  {formatTimestamp(b.createdAt)}
                  {b.bannedBy ? ` by ${resolveUser(b.bannedBy).name}` : ''}
                  {b.reason ? ` — “${b.reason}”` : ''}
                </span>
              </div>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void run(() => api.unbanMember(server.id, b.userId)).then(() =>
                    setReload((n) => n + 1)
                  )
                }
              >
                Unban
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function RolesTab(props: {
  api: ApiClient
  server: ApiServer
  role: ServerRole
  perms: number
  revision: number
}): React.JSX.Element {
  const { api, server, role, perms } = props
  const [roles, setRoles] = useState<ApiRolePermissions[] | null>(null)
  const { busy, error, run } = useAction()
  useEffect(() => {
    let cancelled = false
    api
      .roles(server.id)
      .then((list) => !cancelled && setRoles(list))
      .catch(() => !cancelled && setRoles([]))
    return () => {
      cancelled = true
    }
  }, [api, server.id, props.revision])
  const editable = (r: ConfigurableRole): boolean => ROLE_RANK[role] > ROLE_RANK[r]
  const toggle = (r: ApiRolePermissions, b: number): void => {
    const next = r.permissions ^ b
    void run(async () => {
      const saved = await api.setRolePermissions(server.id, r.role, next)
      setRoles((prev) => prev?.map((x) => (x.role === saved.role ? saved : x)) ?? prev)
    })
  }
  return (
    <>
      <h2>Roles</h2>
      <p className="setting-description">
        What each role can do in this server. The owner always has every permission. You can only
        change roles below your own, and only grant permissions you have yourself. Channels can
        override these (Channels tab).
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {roles === null ? (
        <p className="setting-description">Loading…</p>
      ) : (
        <table className="perm-table">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {roles.map((r) => (
                <th key={r.role} scope="col" style={{ color: ROLE_COLORS[r.role] }}>
                  {ROLE_LABELS[r.role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_INFO.map((p) => (
              <tr key={p.name}>
                <th scope="row">
                  <span className="perm-label">{p.label}</span>
                  <span className="perm-desc">{p.description}</span>
                </th>
                {roles.map((r) => {
                  const on = hasPermission(r.permissions, bit(p.name))
                  const allowed = editable(r.role) && (on || hasPermission(perms, bit(p.name)))
                  return (
                    <td key={r.role}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!allowed || busy}
                        aria-label={`${p.label} for ${ROLE_LABELS[r.role]}`}
                        onChange={() => toggle(r, bit(p.name))}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {roles && (
        <div className="manage-toolbar">
          {roles
            .filter((r) => editable(r.role))
            .map((r) => (
              <button
                key={r.role}
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const saved = await api.setRolePermissions(server.id, r.role, null)
                    setRoles(
                      (prev) => prev?.map((x) => (x.role === saved.role ? saved : x)) ?? prev
                    )
                  })
                }
              >
                Reset {ROLE_LABELS[r.role]} to defaults
              </button>
            ))}
        </div>
      )}
    </>
  )
}

function ChannelsTab(props: {
  api: ApiClient
  server: ApiServer
  role: ServerRole
  perms: number
}): React.JSX.Element {
  const { api, server, role, perms } = props
  const { busy, error, run } = useAction()
  const [name, setName] = useState('')
  const [type, setType] = useState<'text' | 'voice'>('text')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<ApiChannelOverride[] | null>(null)
  const [renaming, setRenaming] = useState('')
  const [userLimit, setUserLimit] = useState(0)
  const channel = server.channels.find((c) => c.id === selected)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    api
      .channelOverrides(selected)
      .then((list) => !cancelled && setOverrides(list))
      .catch(() => !cancelled && setOverrides([]))
    return () => {
      cancelled = true
    }
  }, [api, selected])

  const relevant = PERMISSION_INFO.filter(
    (p) =>
      p.channel &&
      (channel?.type === 'voice'
        ? ['viewChannel', 'connect', 'speak', 'stream'].includes(p.name)
        : !['connect', 'speak', 'stream'].includes(p.name))
  )
  const stateOf = (r: ConfigurableRole, b: number): 'allow' | 'deny' | 'inherit' => {
    const o = overrides?.find((x) => x.role === r)
    if (o && o.allow & b) return 'allow'
    if (o && o.deny & b) return 'deny'
    return 'inherit'
  }
  const setState = (r: ConfigurableRole, b: number, state: 'allow' | 'deny' | 'inherit'): void => {
    if (!selected) return
    const o = overrides?.find((x) => x.role === r) ?? { role: r, allow: 0, deny: 0 }
    const allow = state === 'allow' ? o.allow | b : o.allow & ~b
    const deny = state === 'deny' ? o.deny | b : o.deny & ~b
    void run(async () => {
      const saved = await api.setChannelOverride(selected, r, allow, deny)
      setOverrides((prev) => [...(prev ?? []).filter((x) => x.role !== r), saved])
    })
  }

  return (
    <>
      <h2>Channels</h2>
      {server.defaultNotifications !== undefined && <LayoutEditor api={api} server={server} />}
      <h3>New channel</h3>
      <form
        className="manage-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await api.createChannel(server.id, {
              name: name.trim(),
              type,
              ...(category.trim() ? { category: category.trim() } : {})
            })
            setName('')
          })
        }}
      >
        <input
          className="text-input"
          placeholder="new-channel"
          aria-label="New channel name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="text-input compact"
          value={type}
          aria-label="Channel type"
          onChange={(e) => setType(e.target.value as 'text' | 'voice')}
        >
          <option value="text">Text</option>
          <option value="voice">Voice</option>
        </select>
        <input
          className="text-input compact"
          placeholder={type === 'text' ? 'Text Channels' : 'Voice Channels'}
          aria-label="Category (optional)"
          title="Category (optional)"
          list="channel-categories"
          value={category}
          maxLength={LIMITS.categoryNameMaxLength}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="channel-categories">
          {[...new Set(server.channels.map((c) => c.category))].map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>
          Create Channel
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <h3>Channel details and permissions</h3>
      <div className="channel-manage">
        <ul className="manage-list channel-pick" aria-label="Channels">
          {layoutOf(server.channels).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`channel-pick-item${selected === c.id ? ' active' : ''}`}
                onClick={() => {
                  setSelected(c.id)
                  setRenaming(c.name)
                  setUserLimit(server.channels.find((x) => x.id === c.id)?.userLimit ?? 0)
                  setOverrides(null)
                }}
              >
                {c.type === 'text' ? '#' : '🔊'} {c.name}
              </button>
            </li>
          ))}
        </ul>
        {channel ? (
          <div className="channel-detail">
            <form
              className="manage-toolbar"
              onSubmit={(e) => {
                e.preventDefault()
                void run(() =>
                  api.updateChannel(channel.id, { name: renaming.trim() }).then(() => undefined)
                )
              }}
            >
              <input
                className="text-input"
                aria-label="Channel name"
                value={renaming}
                maxLength={40}
                onChange={(e) => setRenaming(e.target.value)}
              />
              <button
                type="submit"
                className="button secondary"
                disabled={busy || !renaming.trim() || renaming.trim() === channel.name}
              >
                Rename
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete ${channel.type === 'text' ? '#' : ''}${channel.name} and everything in it? This can’t be undone.`
                    )
                  ) {
                    void run(() => api.deleteChannel(channel.id)).then(
                      (ok) => ok && setSelected(null)
                    )
                  }
                }}
              >
                Delete
              </button>
            </form>
            {channel.type === 'voice' && channel.userLimit !== undefined && (
              <form
                className="manage-toolbar"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(() => api.updateChannel(channel.id, { userLimit }).then(() => undefined))
                }}
              >
                <label className="inline-label" htmlFor="voice-user-limit">
                  User limit
                </label>
                <input
                  id="voice-user-limit"
                  className="text-input compact"
                  type="number"
                  min={0}
                  max={LIMITS.voiceUserLimitMax}
                  value={userLimit}
                  onChange={(e) =>
                    setUserLimit(
                      Math.max(
                        0,
                        Math.min(LIMITS.voiceUserLimitMax, Math.floor(Number(e.target.value) || 0))
                      )
                    )
                  }
                  aria-describedby="voice-user-limit-hint"
                />
                <button
                  type="submit"
                  className="button secondary"
                  disabled={busy || userLimit === (channel.userLimit ?? 0)}
                >
                  Save
                </button>
                <span id="voice-user-limit-hint" className="setting-description">
                  {userLimit === 0
                    ? 'No limit.'
                    : `At most ${userLimit} ${userLimit === 1 ? 'person' : 'people'} at once. People who can manage channels can still join.`}
                </span>
              </form>
            )}
            <h3>Permissions in this channel</h3>
            <p className="setting-description">
              “Default” uses the role’s server permissions. Deny <em>View channel</em> for Members
              to make a private staff channel.
            </p>
            {overrides === null ? (
              <p className="setting-description">Loading…</p>
            ) : (
              <table className="perm-table">
                <thead>
                  <tr>
                    <th scope="col">Permission</th>
                    {CONFIG_ROLES.map((r) => (
                      <th key={r} scope="col" style={{ color: ROLE_COLORS[r] }}>
                        {ROLE_LABELS[r]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {relevant.map((p) => (
                    <tr key={p.name}>
                      <th scope="row">
                        <span className="perm-label">{p.label}</span>
                      </th>
                      {CONFIG_ROLES.map((r) => {
                        const b = bit(p.name)
                        const editable = ROLE_RANK[role] > ROLE_RANK[r]
                        return (
                          <td key={r}>
                            <select
                              className={`text-input compact tri ${stateOf(r, b)}`}
                              value={stateOf(r, b)}
                              disabled={!editable || busy}
                              aria-label={`${p.label} for ${ROLE_LABELS[r]}`}
                              onChange={(e) =>
                                setState(r, b, e.target.value as 'allow' | 'deny' | 'inherit')
                              }
                            >
                              <option value="inherit">Default</option>
                              <option value="allow" disabled={!hasPermission(perms, b)}>
                                Allow
                              </option>
                              <option value="deny">Deny</option>
                            </select>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="setting-description channel-detail">
            Select a channel to rename, delete or change its permissions.
          </p>
        )}
      </div>
    </>
  )
}

/** Channel order and categories: edit locally, then save in one step (PUT …/layout). */
function LayoutEditor({ api, server }: { api: ApiClient; server: ApiServer }): React.JSX.Element {
  const original = useMemo(() => layoutOf(server.channels), [server.channels])
  // Local edits start from the server's layout; a server update resets them only when the
  // server-side layout itself changed (tracked by its signature).
  const signature = original.map((e) => `${e.id}:${e.category}`).join('|')
  const [draft, setDraft] = useState<{ base: string; layout: LayoutEntry[] }>({
    base: signature,
    layout: original
  })
  const layout = draft.base === signature ? draft.layout : original
  const setLayout = (next: LayoutEntry[]): void => setDraft({ base: signature, layout: next })
  const [renamingCategory, setRenamingCategory] = useState<{ from: string; to: string } | null>(
    null
  )
  // "New category…" for one channel: typed inline (Electron has no window.prompt).
  const [newCategoryFor, setNewCategoryFor] = useState<{ id: string; name: string } | null>(null)
  const { busy, error, run } = useAction()
  const changed = !sameLayout(layout, original)
  const categories = categoriesOf(layout)

  return (
    <section className="layout-editor" aria-labelledby="layout-title">
      <h3 id="layout-title">Order and categories</h3>
      <p className="setting-description">
        Move channels with the arrows (at the edge of a category they move into the next one),
        rename or reorder categories, then save. Channels you can&rsquo;t see keep their place.
      </p>
      {categories.map((cat, ci) => (
        <div key={cat} className="layout-category">
          <div className="layout-category-header">
            {renamingCategory?.from === cat ? (
              <form
                className="inline-actions"
                onSubmit={(e) => {
                  e.preventDefault()
                  setLayout(renameCategory(layout, cat, renamingCategory.to))
                  setRenamingCategory(null)
                }}
              >
                <input
                  className="text-input compact"
                  aria-label={`New name for ${cat}`}
                  value={renamingCategory.to}
                  maxLength={LIMITS.categoryNameMaxLength}
                  autoFocus
                  onChange={(e) => setRenamingCategory({ from: cat, to: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setRenamingCategory(null)
                    }
                  }}
                />
                <button
                  type="submit"
                  className="button secondary small"
                  disabled={!renamingCategory.to.trim()}
                >
                  OK
                </button>
              </form>
            ) : (
              <>
                <span className="layout-category-name">{cat}</span>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Rename category ${cat}`}
                  title="Rename category"
                  onClick={() => setRenamingCategory({ from: cat, to: cat })}
                >
                  ✎
                </button>
              </>
            )}
            <span className="layout-spacer" />
            <button
              type="button"
              className="icon-button small"
              aria-label={`Move category ${cat} up`}
              disabled={ci === 0}
              onClick={() => setLayout(moveCategory(layout, cat, -1))}
            >
              ▲
            </button>
            <button
              type="button"
              className="icon-button small"
              aria-label={`Move category ${cat} down`}
              disabled={ci === categories.length - 1}
              onClick={() => setLayout(moveCategory(layout, cat, 1))}
            >
              ▼
            </button>
          </div>
          <ul className="layout-channels" aria-label={`Channels in ${cat}`}>
            {layout
              .filter((e) => e.category === cat)
              .map((e) => {
                const index = layout.findIndex((x) => x.id === e.id)
                return (
                  <li key={e.id} className="layout-channel">
                    <span className="layout-channel-name">
                      {e.type === 'text' ? '#' : '🔊'} {e.name}
                    </span>
                    {newCategoryFor?.id === e.id ? (
                      <form
                        className="inline-actions"
                        onSubmit={(ev) => {
                          ev.preventDefault()
                          setLayout(setChannelCategory(layout, e.id, newCategoryFor.name))
                          setNewCategoryFor(null)
                        }}
                      >
                        <input
                          className="text-input compact"
                          aria-label={`New category for ${e.name}`}
                          placeholder="New category"
                          value={newCategoryFor.name}
                          maxLength={LIMITS.categoryNameMaxLength}
                          autoFocus
                          onChange={(ev) => setNewCategoryFor({ id: e.id, name: ev.target.value })}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Escape') {
                              ev.preventDefault()
                              ev.stopPropagation()
                              setNewCategoryFor(null)
                            }
                          }}
                        />
                        <button
                          type="submit"
                          className="button secondary small"
                          disabled={!newCategoryFor.name.trim()}
                        >
                          OK
                        </button>
                      </form>
                    ) : (
                      <select
                        className="text-input compact"
                        aria-label={`Category of ${e.name}`}
                        value={e.category}
                        onChange={(ev) => {
                          const value = ev.target.value
                          if (value === '\u0000new') setNewCategoryFor({ id: e.id, name: '' })
                          else setLayout(setChannelCategory(layout, e.id, value))
                        }}
                      >
                        {categories.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        <option value={'\u0000new'}>New category…</option>
                      </select>
                    )}
                    <button
                      type="button"
                      className="icon-button small"
                      aria-label={`Move ${e.name} up`}
                      disabled={index === 0}
                      onClick={() => setLayout(moveChannel(layout, e.id, -1))}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="icon-button small"
                      aria-label={`Move ${e.name} down`}
                      disabled={index === layout.length - 1}
                      onClick={() => setLayout(moveChannel(layout, e.id, 1))}
                    >
                      ▼
                    </button>
                  </li>
                )
              })}
          </ul>
        </div>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-actions">
        <button
          type="button"
          className="button primary"
          disabled={!changed || busy}
          onClick={() =>
            void run(() =>
              api
                .arrangeChannels(
                  server.id,
                  layout.map((e) => ({ id: e.id, category: e.category }))
                )
                .then(() => undefined)
            )
          }
        >
          {busy ? 'Saving…' : 'Save Order'}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!changed || busy}
          onClick={() => setLayout(original)}
        >
          Undo Changes
        </button>
      </div>
    </section>
  )
}

const AUDIT_LABELS: Record<string, string> = {
  'server.create': 'created the server',
  'server.update': 'updated the server',
  'server.invite_created': 'created an invite',
  'server.invite_revoked': 'revoked an invite',
  'server.join': 'joined',
  'server.leave': 'left',
  'server.kick': 'kicked',
  'server.ban': 'banned',
  'server.unban': 'unbanned',
  'server.role_changed': 'changed the role of',
  'server.role_permissions': 'changed role permissions',
  'server.ownership_transferred': 'transferred ownership to',
  'server.icon_changed': 'changed the server icon',
  'server.icon_removed': 'removed the server icon',
  'server.timeout': 'timed out',
  'server.timeout_removed': 'removed the timeout of',
  'channel.create': 'created a channel',
  'channel.update': 'updated a channel',
  'channel.delete': 'deleted a channel',
  'channel.override': 'changed channel permissions',
  'channel.layout': 'reordered the channels',
  'message.moderator_delete': 'deleted a message by',
  'admin.set_owner': 'was made owner (by an administrator)'
}

function AuditTab(props: {
  api: ApiClient
  server: ApiServer
  revision: number
  resolveUser: (id: string) => User
}): React.JSX.Element {
  const { api, server, resolveUser } = props
  const [events, setEvents] = useState<ApiAuditEvent[] | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .serverAudit(server.id)
      .then((list) => !cancelled && setEvents(list))
      .catch(() => !cancelled && setEvents([]))
    return () => {
      cancelled = true
    }
  }, [api, server.id, props.revision])
  return (
    <>
      <h2>Audit Log</h2>
      {events === null ? (
        <p className="setting-description">Loading…</p>
      ) : events.length === 0 ? (
        <p className="setting-description">Nothing yet.</p>
      ) : (
        <ul className="manage-list audit-list">
          {events.map((e) => (
            <li key={e.id} className="manage-row">
              <div className="manage-row-main">
                <span className="manage-row-title">
                  {e.actorId ? resolveUser(e.actorId).name : 'System'}{' '}
                  {AUDIT_LABELS[e.action] ?? e.action}
                  {e.targetUserId && e.targetUserId !== e.actorId
                    ? ` ${resolveUser(e.targetUserId).name}`
                    : ''}
                  {e.detail && typeof e.detail.to === 'string'
                    ? ` (${String(e.detail.from)} → ${e.detail.to})`
                    : ''}
                  {e.detail && typeof e.detail.name === 'string' ? ` (${e.detail.name})` : ''}
                  {e.action === 'server.timeout' && e.detail && typeof e.detail.minutes === 'number'
                    ? ` for ${timeoutLength(e.detail.minutes)}${
                        typeof e.detail.reason === 'string' ? ` — “${e.detail.reason}”` : ''
                      }`
                    : ''}
                </span>
                <span className="manage-row-sub">{formatTimestamp(e.at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function OwnershipTab(props: {
  api: ApiClient
  server: ApiServer
  meId: string
  members: ApiMember[] | undefined
  resolveUser: (id: string) => User
}): React.JSX.Element {
  const { api, server, meId, resolveUser } = props
  const [target, setTarget] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAction()
  const [done, setDone] = useState(false)
  const candidates = (props.members ?? []).filter(
    (m) => m.userId !== meId && !resolveUser(m.userId).bot
  )
  return (
    <>
      <h2>Transfer Ownership</h2>
      <p className="setting-description">
        The new owner gets full control and you become an Administrator. Only they can give
        ownership back. Enter your password to confirm.
      </p>
      {done ? (
        <p className="form-notice">Ownership transferred.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api.transferOwnership(server.id, target, password)
              setDone(true)
            })
          }}
        >
          <Field label="New owner">
            <select
              className="text-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {resolveUser(m.userId).name} ({ROLE_LABELS[m.role]})
                </option>
              ))}
            </select>
          </Field>
          <PasswordInput
            id="transfer-pw"
            label="Your password"
            value={password}
            autoComplete="current-password"
            onChange={setPassword}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button danger" disabled={busy || !target || !password}>
            Transfer Ownership
          </button>
        </form>
      )}
    </>
  )
}

export default ServerSettingsModal
