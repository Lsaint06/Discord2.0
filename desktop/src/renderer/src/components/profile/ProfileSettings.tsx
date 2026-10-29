import { useRef, useState, type ReactNode } from 'react'
import type { User } from '../../types'
import type { ProfilePatch } from '../../net/api'
import {
  AVATAR_DECORATIONS,
  BANNER_PRESETS,
  LIMITS,
  NAME_STYLES,
  PROFILE_EFFECTS,
  type ApiMe,
  type ApiProfileStyle,
  type ProfileImageKind
} from '../../net/protocol'
import { accentChoices } from '../../data/defaults'
import { Field } from '../SettingsControls'
import Avatar from '../Avatar'
import ProfileCard, { StyledName } from './ProfileCard'
import ImageCropper, { type CropRect } from './ImageCropper'
import BannerArt from './BannerArt'
import ProfileEffect from './ProfileEffect'
import { checkProfileImageFile, PROFILE_IMAGE_ACCEPT } from '../../lib/profileMedia'
import {
  BANNER_INFO,
  cleanStyle,
  DECORATION_INFO,
  EFFECT_INFO,
  EMPTY_STYLE,
  GRADIENT_PRESETS,
  gradientColors,
  NAME_STYLE_INFO,
  sameStyle
} from '../../lib/profileStyle'
import { useProfileMotion } from '../../lib/profileMotion'

interface ProfileSettingsProps {
  me: ApiMe
  onSave: (patch: ProfilePatch) => Promise<string | null>
  onUpload: (
    kind: ProfileImageKind,
    image: Blob,
    onProgress: (fraction: number) => void,
    crop?: CropRect
  ) => Promise<string | null>
  onRemove: (kind: ProfileImageKind) => Promise<string | null>
  /** Milestone 14: the server stores profile styles and animated images (API 6). */
  customizationSupported?: boolean
}

interface Draft {
  displayName: string
  pronouns: string
  bio: string
  accentColor: string | null
  avatarColor: string
  style: ApiProfileStyle
}

const styleOf = (me: ApiMe): ApiProfileStyle => ({ ...EMPTY_STYLE, ...(me.profileStyle ?? {}) })

const draftFrom = (me: ApiMe): Draft => ({
  displayName: me.displayName,
  pronouns: me.pronouns ?? '',
  bio: me.bio ?? '',
  accentColor: me.accentColor,
  avatarColor: me.avatarColor,
  style: styleOf(me)
})

const sameDraft = (a: Draft, b: Draft): boolean =>
  JSON.stringify({ ...a, style: null }) === JSON.stringify({ ...b, style: null }) &&
  sameStyle(a.style, b.style)

/** A row of selectable tiles (one choice, plus "None"). Arrow keys move between tiles. */
function TileGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  render,
  name,
  disabled
}: {
  label: string
  options: readonly T[]
  value: T | null
  onChange: (value: T | null) => void
  render: (option: T, active: boolean) => ReactNode
  name: (option: T) => string
  disabled?: boolean
}): React.JSX.Element {
  const [hot, setHot] = useState<T | null>(null)
  const all: (T | null)[] = [null, ...options]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, all.indexOf(value))
  return (
    <div className="studio-tiles" role="radiogroup" aria-label={label}>
      {all.map((option, index) => {
        const selected = option === value
        return (
          <button
            key={option ?? 'none'}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option ? name(option) : 'None'}
            title={option ? name(option) : 'None'}
            tabIndex={index === current ? 0 : -1}
            className={`studio-tile${selected ? ' selected' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option)}
            onPointerEnter={() => setHot(option)}
            onPointerLeave={() => setHot(null)}
            onFocus={() => setHot(option)}
            onBlur={() => setHot(null)}
            onKeyDown={(e) => {
              const step =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0
              if (!step) return
              e.preventDefault()
              const next = Math.min(all.length - 1, Math.max(0, index + step))
              refs.current[next]?.focus()
            }}
          >
            {option ? (
              render(option, hot === option)
            ) : (
              <span className="studio-none" aria-hidden="true">
                ⃠
              </span>
            )}
            <span className="studio-tile-label">{option ? name(option) : 'None'}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Profile editor ("Profile Studio") with a live preview. Text and style are saved together. */
function ProfileSettings({
  me,
  onSave,
  onUpload,
  onRemove,
  customizationSupported = false
}: ProfileSettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(me))
  const [base, setBase] = useState<Draft>(() => draftFrom(me))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [cropping, setCropping] = useState<{ kind: ProfileImageKind; file: File } | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProfileImageKind | null>(null)
  const [replay, setReplay] = useState(0)
  const avatarInput = useRef<HTMLInputElement>(null)
  const bannerInput = useRef<HTMLInputElement>(null)
  const motion = useProfileMotion()

  // Another device changed the profile and nothing is being edited here: follow it.
  const incoming = draftFrom(me)
  const dirty = !sameDraft(draft, base)
  if (!dirty && !sameDraft(incoming, base)) {
    setBase(incoming)
    setDraft(incoming)
  }

  const set = (patch: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setMessage(null)
  }
  const setStyle = (patch: Partial<ApiProfileStyle>): void => {
    setDraft((d) => ({ ...d, style: { ...d.style, ...patch } }))
    setMessage(null)
  }

  const bioLines = draft.bio.split('\n').length
  const nameInvalid = draft.displayName.trim().length === 0
  const bioInvalid = draft.bio.length > LIMITS.bioMaxLength || bioLines > LIMITS.bioMaxLines
  const styleChanged = !sameStyle(draft.style, base.style)

  const save = async (): Promise<void> => {
    if (!dirty || saving || nameInvalid || bioInvalid) return
    setSaving(true)
    const patch: ProfilePatch = {}
    if (draft.displayName !== base.displayName) patch.displayName = draft.displayName.trim()
    if (draft.pronouns !== base.pronouns) patch.pronouns = draft.pronouns.trim() || null
    if (draft.bio !== base.bio) patch.bio = draft.bio.trim() || null
    if (draft.accentColor !== base.accentColor) patch.accentColor = draft.accentColor
    if (draft.avatarColor !== base.avatarColor) patch.avatarColor = draft.avatarColor
    if (styleChanged && customizationSupported) patch.profileStyle = cleanStyle(draft.style)
    if (Object.keys(patch).length === 0) {
      setSaving(false)
      setMessage({ error: true, text: 'This server can’t save profile styles yet.' })
      return
    }
    const error = await onSave(patch)
    setSaving(false)
    if (error) {
      setMessage({ error: true, text: error })
    } else {
      // The server's (normalized) values arrive with the account update and replace these.
      setBase(draft)
      setMessage({ error: false, text: 'Profile saved' })
    }
  }

  const pick = (kind: ProfileImageKind, file: File | undefined): void => {
    if (!file) return
    const problem = checkProfileImageFile(file)
    setImageError(problem)
    if (!problem) setCropping({ kind, file })
  }

  const remove = async (kind: ProfileImageKind): Promise<void> => {
    setRemoving(kind)
    setImageError(await onRemove(kind))
    setRemoving(null)
  }

  const preview: User = {
    id: me.id,
    name: draft.displayName.trim() || me.username,
    username: me.username,
    avatarColor: draft.avatarColor,
    status: me.statusPreference === 'invisible' ? 'offline' : me.statusPreference,
    avatarId: me.avatarId,
    bannerId: me.bannerId,
    accentColor: draft.accentColor,
    bio: draft.bio.trim() || null,
    pronouns: draft.pronouns.trim() || null,
    createdAt: me.createdAt,
    customStatus: me.ownCustomStatus,
    profileStyle: cleanStyle(draft.style),
    avatarAnimated: me.avatarAnimated === true,
    bannerAnimated: me.bannerAnimated === true
  }
  const colors = gradientColors(draft.style)
  const locked = !customizationSupported

  return (
    <div className="profile-settings">
      <div className="profile-settings-form">
        <Field label="Profile Picture">
          <div className="inline-buttons">
            <button
              type="button"
              className="button primary"
              onClick={() => avatarInput.current?.click()}
            >
              {me.avatarId ? 'Change Picture' : 'Upload Picture'}
            </button>
            {me.avatarId && (
              <button
                type="button"
                className="button secondary"
                onClick={() => void remove('avatar')}
                disabled={removing === 'avatar'}
              >
                {removing === 'avatar' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          <input
            ref={avatarInput}
            type="file"
            accept={PROFILE_IMAGE_ACCEPT}
            hidden
            onChange={(e) => {
              pick('avatar', e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </Field>

        <Field label="Profile Banner">
          <div className="inline-buttons">
            <button
              type="button"
              className="button primary"
              onClick={() => bannerInput.current?.click()}
            >
              {me.bannerId ? 'Change Banner' : 'Upload Banner'}
            </button>
            {me.bannerId && (
              <button
                type="button"
                className="button secondary"
                onClick={() => void remove('banner')}
                disabled={removing === 'banner'}
              >
                {removing === 'banner' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          <input
            ref={bannerInput}
            type="file"
            accept={PROFILE_IMAGE_ACCEPT}
            hidden
            onChange={(e) => {
              pick('banner', e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <span className="field-hint muted">
            PNG, JPEG, WebP or GIF. Pictures are cropped square, banners 5:2. Location and camera
            data are removed.
            {customizationSupported
              ? ' Animated GIF/WebP stay animated (up to 10 MB, 300 frames).'
              : ' Animated pictures keep only their first frame on this server.'}
          </span>
        </Field>
        {imageError && (
          <p className="form-error" role="alert">
            {imageError}
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field label="Display Name">
            <input
              className="text-input"
              type="text"
              value={draft.displayName}
              maxLength={LIMITS.displayNameMaxLength}
              aria-invalid={nameInvalid}
              onChange={(e) => set({ displayName: e.target.value })}
            />
            <span className="field-hint muted">
              Shown to everyone. Your username @{me.username} never changes.
            </span>
          </Field>

          <Field label="Pronouns">
            <input
              className="text-input"
              type="text"
              value={draft.pronouns}
              maxLength={LIMITS.pronounsMaxLength}
              placeholder="Add your pronouns"
              onChange={(e) => set({ pronouns: e.target.value })}
            />
          </Field>

          <Field label="About Me">
            <textarea
              className="text-input bio-input"
              value={draft.bio}
              rows={4}
              maxLength={LIMITS.bioMaxLength + 20}
              placeholder="Tell people a little about yourself"
              aria-invalid={bioInvalid}
              aria-describedby="bio-count"
              onChange={(e) => set({ bio: e.target.value })}
            />
            <span id="bio-count" className={`field-hint${bioInvalid ? ' error' : ' muted'}`}>
              {draft.bio.length}/{LIMITS.bioMaxLength}
              {bioLines > LIMITS.bioMaxLines ? ` · at most ${LIMITS.bioMaxLines} lines` : ''}
            </span>
          </Field>

          <Field label="Profile Color">
            <div className="swatches">
              <button
                type="button"
                className={`swatch default${draft.accentColor === null ? ' selected' : ''}`}
                onClick={() => set({ accentColor: null })}
                aria-label="Default profile color"
                aria-pressed={draft.accentColor === null}
                title="Default (matches your avatar)"
              />
              {accentChoices.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch${draft.accentColor === color ? ' selected' : ''}`}
                  style={{ background: color }}
                  onClick={() => set({ accentColor: color })}
                  aria-label={`Profile color ${color}`}
                  aria-pressed={draft.accentColor === color}
                />
              ))}
              <label className="swatch custom" title="Custom color">
                <span className="sr-only">Custom profile color</span>
                <input
                  type="color"
                  value={draft.accentColor ?? draft.avatarColor}
                  onChange={(e) => set({ accentColor: e.target.value })}
                />
              </label>
            </div>
            <span className="field-hint muted">Used for your banner when you don’t have one.</span>
          </Field>

          <Field label="Avatar Color">
            <div className="swatches">
              {accentChoices.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch${draft.avatarColor === color ? ' selected' : ''}`}
                  style={{ background: color }}
                  onClick={() => set({ avatarColor: color })}
                  aria-label={`Avatar color ${color}`}
                  aria-pressed={draft.avatarColor === color}
                />
              ))}
            </div>
            <span className="field-hint muted">Behind your initials when you have no picture.</span>
          </Field>

          <div className="studio-section">
            <div className="studio-heading">
              <h3>Profile Studio</h3>
              <span className="studio-free">Free for everyone</span>
            </div>
            {locked && (
              <p className="studio-locked" role="note">
                This server doesn’t store profile styles yet, so these can be previewed but not
                saved. They work once the server is updated (API 6).
              </p>
            )}

            <Field label="Profile Theme">
              <div className="gradient-presets" role="group" aria-label="Gradient presets">
                <button
                  type="button"
                  className={`gradient-preset none${colors.length === 0 ? ' selected' : ''}`}
                  aria-pressed={colors.length === 0}
                  onClick={() => setStyle({ colors: [] })}
                >
                  None
                </button>
                {GRADIENT_PRESETS.map((preset) => {
                  const selected =
                    JSON.stringify(preset.colors) === JSON.stringify(colors) &&
                    preset.angle === draft.style.angle
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      className={`gradient-preset${selected ? ' selected' : ''}`}
                      style={{
                        background: `linear-gradient(${preset.angle}deg, ${preset.colors.join(', ')})`
                      }}
                      aria-pressed={selected}
                      aria-label={`${preset.name} gradient`}
                      title={preset.name}
                      onClick={() => setStyle({ colors: preset.colors, angle: preset.angle })}
                    />
                  )
                })}
              </div>
              <div className="gradient-custom">
                {colors.map((color, i) => (
                  <label key={i} className="gradient-stop">
                    <span className="sr-only">Gradient color {i + 1}</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => {
                        const next = [...colors]
                        next[i] = e.target.value
                        setStyle({ colors: next })
                      }}
                    />
                    {colors.length > 1 && (
                      <button
                        type="button"
                        className="gradient-stop-remove"
                        aria-label={`Remove color ${i + 1}`}
                        onClick={() => setStyle({ colors: colors.filter((_, j) => j !== i) })}
                      >
                        ×
                      </button>
                    )}
                  </label>
                ))}
                {colors.length < 3 && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() =>
                      setStyle({
                        colors: [...colors, colors.length === 0 ? '#5865f2' : '#ec4899']
                      })
                    }
                  >
                    {colors.length === 0 ? 'Custom gradient' : 'Add color'}
                  </button>
                )}
              </div>
              {colors.length > 1 && (
                <label className="gradient-angle">
                  <span>Direction — {draft.style.angle}°</span>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={359}
                    step={1}
                    value={draft.style.angle}
                    onChange={(e) => setStyle({ angle: Number(e.target.value) })}
                  />
                </label>
              )}
              <span className="field-hint muted">
                Your card and banner use it. Text sits on solid panels, so it stays readable.
              </span>
            </Field>

            <Field label="Banner Art">
              <TileGroup
                label="Banner art"
                options={BANNER_PRESETS}
                value={draft.style.banner}
                onChange={(banner) => setStyle({ banner })}
                name={(id) => BANNER_INFO[id].name}
                render={(id, active) => (
                  <span className="studio-banner">
                    <BannerArt id={id} animate={motion && active} />
                  </span>
                )}
              />
              <span className="field-hint muted">
                {me.bannerId
                  ? 'Shown when you remove your banner picture.'
                  : 'An animated banner in place of a picture.'}
              </span>
            </Field>

            <Field label="Avatar Decoration">
              <TileGroup
                label="Avatar decoration"
                options={AVATAR_DECORATIONS}
                value={draft.style.decoration}
                onChange={(decoration) => setStyle({ decoration })}
                name={(id) => DECORATION_INFO[id].name}
                render={(id, active) => (
                  <span className="studio-avatar">
                    <Avatar
                      name={preview.name}
                      color={preview.avatarColor}
                      imageId={me.avatarId}
                      animatedImage={me.avatarAnimated === true}
                      size={44}
                      decoration={id}
                      motion={active ? 'active' : 'still'}
                    />
                  </span>
                )}
              />
            </Field>

            <Field label="Profile Effect">
              <TileGroup
                label="Profile effect"
                options={PROFILE_EFFECTS}
                value={draft.style.effect}
                onChange={(effect) => {
                  setStyle({ effect })
                  setReplay((r) => r + 1)
                }}
                name={(id) => EFFECT_INFO[id].name}
                render={(id, active) => (
                  <span className="studio-effect">
                    {/* A still frame until you hover/focus the tile; then it plays. */}
                    <ProfileEffect
                      id={id}
                      run={active && motion ? 1 : 0}
                      still={!(active && motion)}
                    />
                  </span>
                )}
              />
              <span className="field-hint muted">
                Plays for a few seconds when someone opens your profile, and again when they hover
                it.
              </span>
            </Field>

            <Field label="Name Style">
              <TileGroup
                label="Name style"
                options={NAME_STYLES}
                value={draft.style.nameStyle ?? null}
                onChange={(nameStyle) => setStyle({ nameStyle })}
                name={(id) => NAME_STYLE_INFO[id].name}
                render={(id) => (
                  <span className="studio-name">
                    <StyledName
                      user={{
                        accentColor: draft.accentColor,
                        profileStyle: { ...draft.style, nameStyle: id }
                      }}
                    >
                      {preview.name}
                    </StyledName>
                  </span>
                )}
              />
            </Field>

            <button
              type="button"
              className="button link"
              disabled={sameStyle(draft.style, EMPTY_STYLE)}
              onClick={() => setStyle({ ...EMPTY_STYLE })}
            >
              Remove all customization
            </button>
          </div>

          {(dirty || message) && (
            <div className={`save-bar${message?.error ? ' error' : ''}`} role="status">
              <span>
                {message
                  ? message.text
                  : locked && styleChanged
                    ? 'Profile styles can’t be saved on this server yet.'
                    : 'You have unsaved changes.'}
              </span>
              {dirty && (
                <>
                  <button
                    type="button"
                    className="button link"
                    onClick={() => {
                      setDraft(base)
                      setMessage(null)
                    }}
                    disabled={saving}
                  >
                    Reset
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={saving || nameInvalid || bioInvalid}
                  >
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </>
              )}
            </div>
          )}
        </form>
      </div>

      <div className="profile-settings-preview">
        <span className="setting-field-label">Preview</span>
        <ProfileCard user={preview} variant="preview" replayKey={replay} />
        {preview.profileStyle?.effect && (
          <button
            type="button"
            className="button secondary small studio-replay"
            onClick={() => setReplay((r) => r + 1)}
            disabled={!motion}
          >
            Replay effect
          </button>
        )}
      </div>

      {cropping && (
        <ImageCropper
          file={cropping.file}
          kind={cropping.kind}
          allowAnimated={customizationSupported}
          onCancel={() => setCropping(null)}
          onConfirm={async (image, onProgress, crop) => {
            const error = await onUpload(cropping.kind, image, onProgress, crop)
            if (!error) setCropping(null)
            return error
          }}
        />
      )}
    </div>
  )
}

export default ProfileSettings
