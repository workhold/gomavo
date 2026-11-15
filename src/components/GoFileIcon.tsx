import type { SVGProps } from 'react'

type GoFileIconProps = SVGProps<SVGSVGElement> & { size?: number | string }

/** A compact, original gopher-inspired mark for Go source files. */
export function GoFileIcon({ size = 16, className, ...props }: GoFileIconProps) {
  return <svg
    {...props}
    className={`go-file-icon${className ? ` ${className}` : ''}`}
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="3.5" cy="8.6" r="2.15" fill="#2588B8" />
    <circle cx="16.5" cy="8.6" r="2.15" fill="#2588B8" />
    <path d="M3.1 10.1C3.1 5.8 5.95 3.9 10 3.9s6.9 1.9 6.9 6.2v3.2c0 3.1-2.45 4.9-6.9 4.9s-6.9-1.8-6.9-4.9v-3.2Z" fill="#48B7DD" stroke="#207CA9" strokeWidth=".7" />
    <ellipse cx="7.25" cy="8.35" rx="2.25" ry="2.65" fill="#F7FCFF" />
    <ellipse cx="12.75" cy="8.35" rx="2.25" ry="2.65" fill="#F7FCFF" />
    <circle cx="7.7" cy="8.6" r=".9" fill="#173B58" />
    <circle cx="12.3" cy="8.6" r=".9" fill="#173B58" />
    <ellipse cx="10" cy="13.15" rx="2" ry="1.25" fill="#BDE8F4" />
    <path d="M9.3 13.8h1.4v2.05a.7.7 0 0 1-1.4 0V13.8Z" fill="#F7FCFF" />
    <path d="M10 13.9v1.75" stroke="#7EAFCA" strokeWidth=".45" />
    <ellipse cx="10" cy="12.7" rx=".55" ry=".4" fill="#28789E" />
  </svg>
}

/** Go test files keep the Go mark and gain a small run badge. */
export function GoTestFileIcon({ size = 16, className, ...props }: GoFileIconProps) {
  return <svg
    {...props}
    className={`go-file-icon go-test-file-icon${className ? ` ${className}` : ''}`}
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <GoFileIcon size={17} x={0} y={0} />
    <circle cx="14.9" cy="14.9" r="4.35" fill="#2B2D30" />
    <circle cx="14.9" cy="14.9" r="3.55" fill="#67B878" />
    <path d="m13.8 12.9 3.1 2-3.1 2v-4Z" fill="#17251B" />
  </svg>
}
