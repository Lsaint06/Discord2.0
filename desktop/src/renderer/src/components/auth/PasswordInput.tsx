import { useState } from 'react'
import { EyeIcon, EyeOffIcon } from '../Icons'

interface PasswordInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'current-password' | 'new-password'
  hint?: string
  invalid?: boolean
  autoFocus?: boolean
}

/** Password field with a show/hide toggle. Works with password managers (autocomplete hints). */
function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  invalid,
  autoFocus
}: PasswordInputProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div className="setting-field">
      <label className="setting-field-label" htmlFor={id}>
        {label}
      </label>
      <div className={`password-field${invalid ? ' invalid' : ''}`}>
        <input
          id={id}
          className="text-input"
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          maxLength={256}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-button password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      </div>
      {hint && (
        <span id={`${id}-hint`} className={`field-hint${invalid ? ' error' : ' muted'}`}>
          {hint}
        </span>
      )}
    </div>
  )
}

export default PasswordInput
