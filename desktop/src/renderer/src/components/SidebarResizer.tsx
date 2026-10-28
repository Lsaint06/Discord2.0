import { useRef } from 'react'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  sidebarWidthForKey
} from '../lib/sidebarWidth'

interface SidebarResizerProps {
  width: number
  /** Live while dragging. */
  onResize: (width: number) => void
}

/**
 * Drag handle on the right edge of the channel / conversation sidebar. Keyboard: focus it, then
 * ← → (Shift for bigger steps), Home / End; double-click resets the width.
 */
function SidebarResizer({ width, onResize }: SidebarResizerProps): React.JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { startX: e.clientX, startWidth: width }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        onResize(clampSidebarWidth(d.startWidth + (e.clientX - d.startX)))
      }}
      onPointerUp={(e) => {
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const next = sidebarWidthForKey(width, e.key, e.shiftKey)
        if (next === null) return
        e.preventDefault()
        onResize(next)
      }}
    />
  )
}

export default SidebarResizer
