import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { UserSettings } from '../types'
import { ApiError } from '../net/api'
import type { ApiVoiceToken } from '../net/protocol'
import { MediaSession, type MediaPreferences, type MediaSnapshot } from '../media/MediaSession'

function describeVoiceError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'voice_unavailable') return 'Voice is not configured on this server.'
    if (err.isNetwork) return 'Cannot reach the server.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Voice error.'
}

function isFatalVoiceError(err: unknown): boolean {
  // Retrying won't fix auth, permission, missing-channel or voice-disabled errors.
  return err instanceof ApiError && [400, 401, 403, 404, 503].includes(err.status)
}

interface UseVoiceOptions {
  fetchToken: (channelId: string) => Promise<ApiVoiceToken>
  settings: UserSettings
}

export interface Voice {
  session: MediaSession
  state: MediaSnapshot
}

/**
 * Owns one MediaSession for the signed-in workspace and keeps it in sync with settings.
 * Mic state (mute/deafen/push-to-talk) is pushed by the caller via session.setMicState().
 */
export function useVoice({ fetchToken, settings }: UseVoiceOptions): Voice {
  const prefs: MediaPreferences = useMemo(
    () => ({
      inputDeviceId: settings.inputDeviceId,
      outputDeviceId: settings.outputDeviceId,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      inputVolume: settings.inputVolume,
      outputVolume: settings.outputVolume,
      userVolumes: settings.userVolumes,
      streamVolumes: settings.streamVolumes,
      // The manual noise gate only applies in voice-activity mode.
      inputSensitivityDb:
        settings.inputSensitivityAuto || settings.inputMode === 'push-to-talk'
          ? null
          : settings.inputSensitivityDb
    }),
    [
      settings.inputDeviceId,
      settings.outputDeviceId,
      settings.echoCancellation,
      settings.noiseSuppression,
      settings.autoGainControl,
      settings.inputVolume,
      settings.outputVolume,
      settings.userVolumes,
      settings.streamVolumes,
      settings.inputSensitivityAuto,
      settings.inputMode,
      settings.inputSensitivityDb
    ]
  )

  const [session] = useState(
    () =>
      new MediaSession(
        { describeError: describeVoiceError, isFatalError: isFatalVoiceError },
        prefs
      )
  )

  useEffect(() => {
    session.setTokenSource(fetchToken)
  }, [session, fetchToken])

  useEffect(() => {
    session.activate()
    if (import.meta.env.DEV) {
      // Dev-only handle for manual verification (e.g. __d2Media.isCapturing()).
      ;(window as unknown as { __d2Media?: MediaSession }).__d2Media = session
    }
    return () => {
      void session.deactivate()
    }
  }, [session])

  useEffect(() => {
    session.setPreferences(prefs)
  }, [session, prefs])

  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { session, state }
}
