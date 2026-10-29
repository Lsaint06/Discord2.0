import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaSession, MediaSnapshot, VoiceParticipant } from '../../media/MediaSession'
import type { CameraState } from '../../media/CameraController'
import CameraButton from './CameraButton'
import CallStage from './CallStage'
import VideoTile, { type TilePerson } from './VideoTile'

// Server-side rendering runs the real components in Node (no DOM, no effects): it checks what
// each state renders — labels, disabled reasons, tiles — without a LiveKit room.

const camera = (status: CameraState['status'], extra: Partial<CameraState> = {}): CameraState => ({
  status,
  presetId: 'balanced',
  ...extra
})

const participant = (
  identity: string,
  extra: Partial<VoiceParticipant> = {}
): VoiceParticipant => ({
  identity,
  isLocal: false,
  speaking: false,
  micEnabled: true,
  deafened: false,
  sharingScreen: false,
  sharingAudio: false,
  cameraOn: false,
  ...extra
})

const person = (p: VoiceParticipant): TilePerson => ({
  identity: p.identity,
  name: p.identity === 'me' ? 'Ava' : p.identity[0].toUpperCase() + p.identity.slice(1),
  avatarColor: '#5865f2',
  isLocal: p.isLocal,
  speaking: p.speaking,
  muted: !p.micEnabled,
  deafened: p.deafened
})

const session = { getCameraTrack: () => undefined } as unknown as MediaSession

function stage(participants: VoiceParticipant[], available = true): string {
  const state = {
    status: 'connected',
    participants,
    camera: camera('off'),
    streamRevision: 0
  } as unknown as MediaSnapshot
  return renderToStaticMarkup(
    <CallStage
      session={session}
      state={state}
      person={person}
      channelName="Lounge"
      mirror
      hideSelf={false}
      overlayEnabled={false}
      cameraAvailability={available ? { ok: true } : { ok: false, reason: 'No Video permission.' }}
      onToggleCamera={() => undefined}
      onToggleHideSelf={() => undefined}
      onToggleOverlay={() => undefined}
      onWatchStream={() => undefined}
      onClose={() => undefined}
    />
  )
}

describe('CameraButton states', () => {
  const render = (state: CameraState, ok = true, round = false): string =>
    renderToStaticMarkup(
      <CameraButton
        camera={state}
        availability={ok ? { ok: true } : { ok: false, reason: 'Join a voice channel first.' }}
        onToggle={() => undefined}
        round={round}
      />
    )

  it('is off, pressable and labelled by default', () => {
    const html = render(camera('off'))
    expect(html).toContain('data-camera="off"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="Turn on camera"')
    expect(html).not.toContain('disabled')
  })

  it('shows live, starting and failed distinctly', () => {
    const on = render(camera('on'))
    expect(on).toContain('data-camera="on"')
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain('camera-live-dot')
    expect(render(camera('starting'))).toContain('Starting camera… (click to cancel)')
    expect(render(camera('error', { error: 'x' }))).toContain('Camera failed — try again')
  })

  it('is disabled with the reason when unavailable, but can still turn a live camera off', () => {
    const off = render(camera('off'), false)
    expect(off).toContain('data-camera="unavailable"')
    expect(off).toContain('disabled=""')
    expect(off).toContain('Join a voice channel first.')
    const live = render(camera('on'), false)
    expect(live).not.toContain('disabled=""')
    expect(live).toContain('Turn off camera')
  })

  it('round variant is icon-only', () => {
    const html = render(camera('off'), true, true)
    expect(html).toContain('call-round-button')
    expect(html).not.toContain('<span>Camera</span>')
  })
})

describe('VideoTile', () => {
  it('shows the avatar placeholder and an accessible label until video plays', () => {
    const html = renderToStaticMarkup(
      <VideoTile
        person={{ ...person(participant('ben')), muted: true, speaking: true }}
        track={undefined}
        mirror={false}
        onFocus={() => undefined}
      />
    )
    expect(html).toContain('video-tile speaking')
    expect(html).toContain('aria-label="Ben’s camera, speaking, muted, Camera starting"')
    expect(html).toContain('video-tile-placeholder')
    expect(html).toContain('data-frames="none"')
    expect(html).toContain('Focus on Ben’s camera')
  })

  it('marks your own tile and only mirrors when asked', () => {
    const me = person(participant('me', { isLocal: true }))
    expect(renderToStaticMarkup(<VideoTile person={me} track={undefined} mirror />)).toContain(
      'video-tile-video mirrored'
    )
    const plain = renderToStaticMarkup(<VideoTile person={me} track={undefined} mirror={false} />)
    expect(plain).not.toContain('mirrored')
    expect(plain).toContain('Ava (you)')
  })
})

describe('CallStage', () => {
  it('explains the empty state and lists everyone without a camera', () => {
    const html = stage([participant('me', { isLocal: true }), participant('ben')])
    expect(html).toContain('No cameras on')
    expect(html).toContain('Nobody has their camera on yet')
    expect(html).toContain('It stays off until you press the camera button.')
    expect(html).toContain('Ava (you)')
    expect(html).toContain('In voice without a camera')
  })

  it('gives the reason when cameras are unavailable here', () => {
    expect(stage([participant('ben')], false)).toContain('No Video permission.')
  })

  it('shows one tile per camera, yours first, and offers live streams', () => {
    const html = stage([
      participant('ben', { cameraOn: true }),
      participant('me', { isLocal: true, cameraOn: true }),
      participant('cy', { sharingScreen: true })
    ])
    expect(html).toContain('2 cameras on')
    // Unmeasured (no layout in SSR) the grid shows one tile per page; sizes are covered in
    // lib/gallery.test.ts. Your own camera comes first.
    const tiles = [...html.matchAll(/data-identity="([^"]+)"/g)].map((m) => m[1])
    expect(tiles[0]).toBe('me')
    expect(html).toContain('Watch Cy’s stream')
    expect(html).toContain('Hide my self-view')
  })
})
