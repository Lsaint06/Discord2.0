import { useCallback, useEffect, useRef, useState } from 'react'
import { useDialog } from '../../hooks/useDialog'
import { LIMITS, PROFILE_IMAGE_SIZES, type ProfileImageKind } from '../../net/protocol'
import {
  clampCrop,
  coverScale,
  initialCrop,
  MAX_ZOOM,
  MIN_ZOOM,
  sourceRect,
  zoomCrop,
  type CropState,
  type Size
} from '../../lib/crop'
import { CloseIcon } from '../Icons'
import { isAnimatedImageFile } from '../../lib/animatedImage'

/** The server's upload limit for profile images (bytes). */
const MAX_UPLOAD_BYTES = LIMITS.profileImageMaxBytes

export interface CropRect {
  left: number
  top: number
  width: number
  height: number
}

const FRAMES: Record<ProfileImageKind, Size> = {
  avatar: { width: 300, height: 300 },
  banner: { width: 500, height: 200 }
}

interface ImageCropperProps {
  file: File
  kind: ProfileImageKind
  onCancel: () => void
  /**
   * Upload the image; resolves to an error message or null on success. For an animated
   * original (kept animated), crop is the chosen area in source pixels.
   */
  onConfirm: (
    image: Blob,
    onProgress: (fraction: number) => void,
    crop?: CropRect
  ) => Promise<string | null>
  /** Milestone 14: the server keeps animations (otherwise the first frame is used). */
  allowAnimated?: boolean
}

interface Loaded {
  image: HTMLImageElement
  url: string
  size: Size
}

function ImageCropper({
  file,
  kind,
  onCancel,
  onConfirm,
  allowAnimated = false
}: ImageCropperProps): React.JSX.Element {
  const frame = FRAMES[kind]
  /** The picked file is an animated GIF/WebP (null while checking). */
  const [animated, setAnimated] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void isAnimatedImageFile(file).then(
      (yes) => !cancelled && setAnimated(yes),
      () => !cancelled && setAnimated(false)
    )
    return () => {
      cancelled = true
    }
  }, [file])
  const keepAnimation = Boolean(animated && allowAnimated)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [crop, setCrop] = useState<CropState | null>(null)
  /** The picked image can't be used at all (unreadable, too small). */
  const [blocked, setBlocked] = useState<string | null>(null)
  /** The last upload attempt failed (can be retried). */
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight }
      const min =
        kind === 'avatar'
          ? { width: LIMITS.avatarMinSize, height: LIMITS.avatarMinSize }
          : { width: LIMITS.bannerMinWidth, height: LIMITS.bannerMinHeight }
      if (size.width < min.width || size.height < min.height) {
        setBlocked(`This image is too small. Use at least ${min.width}×${min.height} pixels.`)
      }
      setLoaded({ image: img, url, size })
      setCrop(initialCrop(size, FRAMES[kind]))
      frameRef.current?.focus()
    }
    img.onerror = () => setBlocked('This image can’t be opened. Try a different file.')
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file, kind])

  const dialogRef = useDialog<HTMLDivElement>({ onClose: busy ? undefined : onCancel })

  const size = loaded?.size
  const update = useCallback(
    (fn: (state: CropState, image: Size) => CropState) => {
      if (!size) return
      setCrop((prev) => (prev ? fn(prev, size) : prev))
    },
    [size]
  )

  const zoomBy = (delta: number): void =>
    update((state, image) => zoomCrop(image, frame, state, state.zoom + delta))

  const confirm = async (): Promise<void> => {
    if (!loaded || !crop || busy || blocked) return
    if (keepAnimation) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`Animated pictures can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)
        return
      }
      // Animations are cropped by the server (every frame); send the original and the area.
      const { sx, sy, sw, sh } = sourceRect(loaded.size, frame, crop)
      const left = Math.max(0, Math.floor(sx))
      const top = Math.max(0, Math.floor(sy))
      const area: CropRect = {
        left,
        top,
        width: Math.min(loaded.size.width - left, Math.round(sw)),
        height: Math.min(loaded.size.height - top, Math.round(sh))
      }
      setBusy(true)
      setError(null)
      setProgress(0)
      const failure = await onConfirm(file, setProgress, area)
      setBusy(false)
      if (failure) setError(failure)
      return
    }
    setBusy(true)
    setError(null)
    setProgress(0)
    const out = PROFILE_IMAGE_SIZES[kind].full
    const canvas = document.createElement('canvas')
    canvas.width = out.width
    canvas.height = out.height
    const ctx = canvas.getContext('2d')
    let blob: Blob | null = null
    if (ctx) {
      ctx.imageSmoothingQuality = 'high'
      const { sx, sy, sw, sh } = sourceRect(loaded.size, frame, crop)
      ctx.drawImage(loaded.image, sx, sy, sw, sh, 0, 0, out.width, out.height)
      // Re-encoding here also drops the photo's metadata (location, camera…) before upload.
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92))
    }
    if (!blob) {
      setBusy(false)
      setError('Your system couldn’t prepare the image.')
      return
    }
    const failure = await onConfirm(blob, setProgress)
    setBusy(false)
    if (failure) setError(failure)
  }

  const title = kind === 'avatar' ? 'Edit profile picture' : 'Edit banner'
  const scale = size && crop ? coverScale(size, frame) * crop.zoom : 1

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div
        ref={dialogRef}
        className={`modal cropper-modal cropper-${kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onCancel}
          aria-label="Close"
          disabled={busy}
        >
          <CloseIcon size={18} />
        </button>
        <h2>{title}</h2>
        <p className="modal-subtitle">Drag to reposition. Scroll or use the slider to zoom.</p>
        {animated && (
          <p className="cropper-note" role="note">
            {allowAnimated
              ? 'Animated picture — the animation is kept. People see it move when they hover over you or open your profile.'
              : 'This server keeps only the first frame of animated pictures.'}
          </p>
        )}

        <div
          ref={frameRef}
          className={`cropper-frame cropper-${kind}`}
          style={{ width: frame.width, height: frame.height }}
          tabIndex={0}
          role="application"
          aria-label="Image position. Arrow keys move the image, plus and minus zoom, Enter applies."
          onPointerDown={(e) => {
            if (!crop || busy) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, startX: crop.x, startY: crop.y }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            update((state, image) =>
              clampCrop(image, frame, {
                ...state,
                x: d.startX + e.clientX - d.x,
                y: d.startY + e.clientY - d.y
              })
            )
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => zoomBy(e.deltaY < 0 ? 0.1 : -0.1)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 10
            const moves: Record<string, [number, number]> = {
              ArrowLeft: [step, 0],
              ArrowRight: [-step, 0],
              ArrowUp: [0, step],
              ArrowDown: [0, -step]
            }
            const move = moves[e.key]
            if (move) {
              e.preventDefault()
              update((state, image) =>
                clampCrop(image, frame, { ...state, x: state.x + move[0], y: state.y + move[1] })
              )
            } else if (e.key === '+' || e.key === '=') {
              e.preventDefault()
              zoomBy(0.1)
            } else if (e.key === '-') {
              e.preventDefault()
              zoomBy(-0.1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void confirm()
            }
          }}
        >
          {loaded && crop && (
            <img
              src={loaded.url}
              alt=""
              draggable={false}
              style={{
                width: loaded.size.width * scale,
                height: loaded.size.height * scale,
                transform: `translate(${crop.x}px, ${crop.y}px)`
              }}
            />
          )}
          {!loaded && !blocked && <div className="spinner" aria-label="Loading image" />}
          <div className="cropper-mask" aria-hidden="true" />
        </div>

        <label className="cropper-zoom">
          <span className="sr-only">Zoom</span>
          <span aria-hidden="true">−</span>
          <input
            type="range"
            className="slider"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={crop?.zoom ?? 1}
            disabled={!crop || busy}
            onChange={(e) =>
              update((state, image) => zoomCrop(image, frame, state, Number(e.target.value)))
            }
          />
          <span aria-hidden="true">+</span>
        </label>

        {(blocked || error) && (
          <p className="form-error" role="alert">
            {blocked ?? error}
          </p>
        )}
        {busy && (
          <div
            className="upload-progress"
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void confirm()}
            disabled={!crop || busy || Boolean(blocked)}
          >
            {busy ? (progress >= 1 ? 'Processing…' : 'Uploading…') : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ImageCropper
