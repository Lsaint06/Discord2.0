import { useEffect, useState } from 'react'
import { Field } from '../SettingsControls'

const percent = (factor: number): string => `${Math.round(factor * 100)}%`

/**
 * Interface scale for this device. Uses Chromium's page zoom through the main process, so
 * everything (text, buttons, dialogs) re-lays out at the new size. Hidden outside the desktop app.
 */
function AppScaleControl(): React.JSX.Element | null {
  const api = window.d2?.uiZoom
  const [factor, setFactor] = useState<number | null>(null)
  const [steps, setSteps] = useState<number[]>([])
  const [defaultFactor, setDefaultFactor] = useState(1)

  useEffect(() => {
    if (!api) return
    let alive = true
    void api.get().then((state) => {
      if (!alive || !state) return
      setFactor(state.factor)
      setSteps(state.steps)
      setDefaultFactor(state.defaultFactor)
    })
    const off = api.onChange((next) => setFactor(next))
    return () => {
      alive = false
      off()
    }
  }, [api])

  if (!api || factor === null || steps.length === 0) return null
  const index = Math.max(0, steps.indexOf(factor))

  return (
    <Field label={`App Scale — ${percent(factor)}`}>
      <div className="app-scale-row">
        <input
          className="slider"
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={index}
          aria-label="App scale"
          aria-valuetext={percent(factor)}
          onChange={(e) => void api.set(steps[Number(e.target.value)])}
        />
        <button
          type="button"
          className="button secondary small"
          disabled={factor === defaultFactor}
          onClick={() => void api.set(defaultFactor)}
        >
          Reset
        </button>
      </div>
      <p className="setting-description">
        Makes the whole app larger or smaller, including buttons and dialogs. Shortcuts: Ctrl + = to
        enlarge, Ctrl + − to shrink, Ctrl + 0 to reset.
      </p>
    </Field>
  )
}

export default AppScaleControl
