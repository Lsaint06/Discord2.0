import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({
  size = 20,
  children,
  ...rest
}: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function HashIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 3 8 21M16 3l-2 18M4.5 8.5h16M3.5 15.5h16" />
    </Svg>
  )
}

export function SpeakerIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
    </Svg>
  )
}

export function MicIcon({
  slashed,
  ...props
}: IconProps & { slashed?: boolean }): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      {slashed && <path className="icon-slash" d="M3.5 3.5l17 17" />}
    </Svg>
  )
}

export function HeadphonesIcon({
  slashed,
  ...props
}: IconProps & { slashed?: boolean }): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 16v-4a8 8 0 0 1 16 0v4" />
      <rect x="3" y="14" width="4.5" height="6.5" rx="1.5" fill="currentColor" />
      <rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5" fill="currentColor" />
      {slashed && <path className="icon-slash" d="M3.5 3.5l17 17" />}
    </Svg>
  )
}

export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle
        cx="12"
        cy="12"
        r="7.6"
        strokeWidth={3.2}
        strokeDasharray="3.4 2.57"
        strokeLinecap="butt"
      />
      <circle cx="12" cy="12" r="5.2" strokeWidth={2.2} />
    </Svg>
  )
}

export function MembersIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M16.5 14.2A5 5 0 0 1 21.5 19" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

export function BellIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Svg>
  )
}

export function PinIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5z" />
      <path d="M12 13v7.5" />
    </Svg>
  )
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m20 20-5-5" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

export function SmileIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4 4 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.6} />
    </Svg>
  )
}

export function SendIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 12 20 4l-5 16-3-7z" fill="currentColor" />
    </Svg>
  )
}

export function HangUpIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path
        d="M3 14.5c5-5 13-5 18 0l-2.2 2.6-3.3-1.2V13a9 9 0 0 0-7 0v2.9l-3.3 1.2z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  )
}

export function SignalIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 19v-3M10 19v-7M15 19V9M20 19V5" />
    </Svg>
  )
}

export function CompassIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" />
    </Svg>
  )
}

export function ScreenShareIcon({
  slashed,
  ...props
}: IconProps & { slashed?: boolean }): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      {slashed ? (
        <path className="icon-slash" d="M3.5 3.5l17 17" />
      ) : (
        <path d="M12 13.5v-6M9 10l3-3 3 3" />
      )}
    </Svg>
  )
}

export function FullscreenIcon({
  exit,
  ...props
}: IconProps & { exit?: boolean }): React.JSX.Element {
  return (
    <Svg {...props}>
      {exit ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </Svg>
  )
}

export function PopOutIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function ExpandIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
    </Svg>
  )
}

export function ChartIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 20V4M4 20h16M8 16l4-5 3 3 5-6" />
    </Svg>
  )
}

export function EyeIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />
    </Svg>
  )
}

/** Original Discord 2.0 mark: two overlapping chat bubbles. */
export function LogoIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props} strokeWidth={1.8}>
      <path
        d="M4 5.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M17.5 9H20a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-.5v2.5l-3-2.5H12" />
    </Svg>
  )
}
