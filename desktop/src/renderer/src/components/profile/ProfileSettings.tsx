import { useRef, useState } from 'react'
import type { User } from '../../types'
import type { ProfilePatch } from '../../net/api'
import { LIMITS, type ApiMe, type ProfileImageKind } from '../../net/protocol'
import { accentChoices } from '../../data/defaults'
import { Field } from '../SettingsControls'
import ProfileCard from './ProfileCard'
import ImageCropper from './ImageCropper'
import { checkProfileImageFile, PROFILE_IMAGE_ACCEPT } from '../../lib/profileMedia'

interface ProfileSettingsProps {
  me: ApiMe
  onSave: (patch: ProfilePatch) => Promise<string | null>
  onUpload: (
    kind: ProfileImageKind,
    image: Blob,
    onProgress: (fraction: number) => void
  ) => Promise<string | null>
  onRemove: (kind: ProfileImageKind) => Promise<string | null>
}

interface Draft {
  displayName: string
  pronouns: string
  bio: string
  accentColor: string | null
  avatarColor: string
}

const draftFrom = (me: ApiMe): Draft => ({
  displayName: me.displayName,
  pronouns: me.pronouns ?? '',
  bio: me.bio ?? '',
  accentColor: me.accentColor,
  avatarColor: me.avatarColor
})

/** Profile editor with a live preview. Text fields are saved together; images immediately. */
function ProfileSettings({
  me,
  onSave,
  onUpload,
  onRemove
}: ProfileSettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(me))
  const [base, setBase] = useState<Draft>(() => draftFrom(me))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [cropping, setCropping] = useState<{ kind: ProfileImageKind; file: File } | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProfileImageKind | null>(null)
  const avatarInput = useRef<HTMLInputElement>(null)
  const bannerInput = useRef<HTMLInputElement>(null)

  // Another device changed the profile and nothing is being edited here: follow it.
  const incoming = draftFrom(me)
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  if (!dirty && JSON.stringify(incoming) !== JSON.stringify(base)) {
    setBase(incoming)
    setDraft(incoming)
  }

  const set = (patch: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setMessage(null)
  }

  const bioLines = draft.bio.split('\n').length
  const nameInvalid = draft.displayName.trim().length === 0
  const bioInvalid = draft.bio.length > LIMITS.bioMaxLength || bioLines > LIMITS.bioMaxLines

  const save = async (): Promise<void> => {
    if (!dirty || saving || nameInvalid || bioInvalid) return
    setSaving(true)
    const patch: ProfilePatch = {}
    if (draft.displayName !== base.displayName) patch.displayName = draft.displayName.trim()
    if (draft.pronouns !== base.pronouns) patch.pronouns = draft.pronouns.trim() || null
    if (draft.bio !== base.bio) patch.bio = draft.bio.trim() || null
    if (draft.accentColor !== base.accentColor) patch.accentColor = draft.accentColor
    if (draft.avatarColor !== base.avatarColor) patch.avatarColor = draft.avatarColor
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
    customStatus: me.ownCustomStatus
  }

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

          {(dirty || message) && (
            <div className={`save-bar${message?.error ? ' error' : ''}`} role="status">
              <span>{message ? message.text : 'You have unsaved changes.'}</span>
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
        <ProfileCard user={preview} variant="preview" />
      </div>

      {cropping && (
        <ImageCropper
          file={cropping.file}
          kind={cropping.kind}
          onCancel={() => setCropping(null)}
          onConfirm={async (image, onProgress) => {
            const error = await onUpload(cropping.kind, image, onProgress)
            if (!error) setCropping(null)
            return error
          }}
        />
      )}
    </div>
  )
}

export default ProfileSettings
