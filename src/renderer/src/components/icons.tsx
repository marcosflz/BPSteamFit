import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function baseProps(props: IconProps): IconProps {
  return {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props
  }
}

export function GamepadIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.4 7.5h11.2a4.4 4.4 0 0 1 4.3 5.2l-.7 3.7a2.6 2.6 0 0 1-4.5 1.3l-1.5-1.7h-6.4l-1.5 1.7a2.6 2.6 0 0 1-4.5-1.3l-.7-3.7a4.4 4.4 0 0 1 4.3-5.2Z" />
      <path d="M8 10v3M6.5 11.5h3M15.5 11h.01M17.5 13h.01" />
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 5.5v13l10-6.5-10-6.5Z" />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3.5 7.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z" />
      <path d="M3.5 7.5V6a2 2 0 0 1 2-2H10l2 2h4" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M20 11a8 8 0 0 0-14.9-3.9M4 5v5h5M4 13a8 8 0 0 0 14.9 3.9M20 19v-5h-5" />
    </svg>
  )
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m14.5 5-7 7 7 7M7.5 12H21" />
    </svg>
  )
}

export function DiscIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3.5h.01M12 20.5h.01" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  )
}

export function KeyboardIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M7 13h.01M10 13h.01M13 13h.01M16 13h.01M8 15.5h8" />
    </svg>
  )
}

export function ImageIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 5-5 3.5 3.5L16 12l4 4" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 3.5 21 20H3L12 3.5Z" />
      <path d="M12 9v5M12 17.2h.01" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}
