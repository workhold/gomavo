import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface DropdownOption<V extends string = string> {
  value: V
  label: string
}

export interface DropdownProps<V extends string = string> {
  value: V
  options: DropdownOption<V>[]
  onChange: (value: V) => void
  /** Accessible label; also used as the placeholder title. */
  ariaLabel: string
  className?: string
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right'
}

/** App-styled select replacement: button + popover with keyboard navigation. */
export function Dropdown<V extends string = string>(props: DropdownProps<V>) {
  const { value, options, onChange, ariaLabel, className, tooltipPlacement } = props
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  useLayoutEffect(() => {
    if (open) setHighlight(Math.max(0, options.findIndex((option) => option.value === value)))
  }, [open, options, value])

  const commit = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  return <div className={`dropdown ${className ?? ''}`} ref={rootRef}>
    <button
      type="button"
      className="dropdown-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      title={tooltipPlacement ? undefined : current?.label ?? ariaLabel}
      data-tooltip={tooltipPlacement ? ariaLabel : undefined}
      data-tooltip-placement={tooltipPlacement}
      onClick={() => setOpen((current_) => !current_)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) { setOpen(true); return }
          setHighlight((index) => {
            const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0)
            return next
          })
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (open) commit(highlight)
        } else if (event.key === 'Escape') {
          setOpen(false)
        }
      }}
    >
      <span>{current?.label ?? ariaLabel}</span>
      <ChevronDown size={12} />
    </button>
    {open && <div className="dropdown-menu" role="listbox" aria-label={ariaLabel}>
      {options.map((option, index) => <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={option.value === value}
        className={`dropdown-item ${index === highlight ? 'highlight' : ''} ${option.value === value ? 'selected' : ''}`}
        onMouseEnter={() => setHighlight(index)}
        onClick={() => commit(index)}
      >
        <span>{option.label}</span>
        {option.value === value && <Check size={13} />}
      </button>)}
    </div>}
  </div>
}
