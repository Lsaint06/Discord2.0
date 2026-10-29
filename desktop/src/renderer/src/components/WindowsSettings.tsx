/**
 * Milestone 14: Windows behavior (Settings → Notifications): close to tray, start minimized,
 * open at sign-in. Stored by the app on this PC (main process); nothing here is synced.
 */
import { useEffect, useState } from 'react'
import { Toggle } from './SettingsControls'

type LifecycleState = Awaited<ReturnType<NonNullable<typeof window.d2>['lifecycle']['get']>>

function WindowsSettings(): React.JSX.Element | null {
  const bridge = window.d2?.lifecycle
  const [state, setState] = useState<LifecycleState>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void bridge?.get().then((s) => alive && setState(s))
    return () => {
      alive = false
    }
  }, [bridge])

  if (!bridge || !state) return null

  const change = (
    patch: Partial<
      Pick<NonNullable<LifecycleState>, 'closeToTray' | 'startMinimized' | 'launchAtLogin'>
    >
  ): void => {
    setError(null)
    void bridge.set(patch).then((next) => {
      if (next) setState(next)
      else setError('That setting couldn’t be changed.')
    })
  }

  return (
    <>
      <h3 className="settings-subheading">Windows</h3>
      <Toggle
        label="Close to tray"
        description={
          state.trayAvailable
            ? 'The close button hides Discord 2.0 in the notification area so you keep getting messages and calls. Quit from the tray icon to exit.'
            : 'Not available: Windows didn’t give the app a tray icon.'
        }
        checked={state.closeToTray && state.trayAvailable}
        onChange={(closeToTray) => state.trayAvailable && change({ closeToTray })}
      />
      <Toggle
        label="Start minimized"
        description="Open in the background (in the tray when “Close to tray” is on, otherwise minimized)."
        checked={state.startMinimized}
        onChange={(startMinimized) => change({ startMinimized })}
      />
      <Toggle
        label="Open when Windows starts"
        description={
          state.loginSupported
            ? 'Starts Discord 2.0 in the background when you sign in to Windows.'
            : 'Only available in an installed or portable build (not when running from source).'
        }
        checked={state.launchAtLogin && state.loginSupported}
        onChange={(launchAtLogin) => state.loginSupported && change({ launchAtLogin })}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export default WindowsSettings
