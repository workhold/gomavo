import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { Command, Search } from 'lucide-react'
import type { Locale, MessageKey } from '../../lib/i18n'
import type { PaletteMode } from '../types'

export type PaletteItem = {
  label: string
  hint: string
  action: () => void
  icon: ComponentType<{ size?: number | string; className?: string; strokeWidth?: number | string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  ignored?: boolean
}

export interface PaletteProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  paletteMode: PaletteMode
  paletteQuery: string
  setPaletteQuery: (value: string) => void
  paletteSelection: number
  setPaletteSelection: (value: number | ((current: number) => number)) => void
  items: PaletteItem[]
  closePalette: () => void
}

export function Palette(props: PaletteProps) {
  const { t, locale, paletteMode, paletteQuery, setPaletteQuery, paletteSelection, setPaletteSelection, items, closePalette } = props

  useEffect(() => {
    document.getElementById(`palette-option-${paletteSelection}`)?.scrollIntoView({ block: 'nearest' })
  }, [items.length, paletteSelection])

  return <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette() }}>
    <div
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label={t(paletteMode === 'files' ? '搜索项目文件…' : paletteMode === 'actions' ? '查找操作…' : '随处搜索')}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { event.preventDefault(); event.currentTarget.querySelector('input')?.focus() }
      }}
    >
      <div className="palette-input">
        <Search size={19} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-label={t(paletteMode === 'files' ? '搜索项目文件…' : paletteMode === 'actions' ? '查找操作…' : '随处搜索…')}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={items.length ? `palette-option-${Math.min(paletteSelection, items.length - 1)}` : undefined}
          value={paletteQuery}
          onChange={(event) => { setPaletteQuery(event.target.value); setPaletteSelection(0) }}
          placeholder={t(paletteMode === 'files' ? '搜索项目文件…' : paletteMode === 'actions' ? '查找操作…' : '随处搜索…')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteSelection((value) => Math.min(value + 1, Math.max(0, items.length - 1))) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteSelection((value) => Math.max(0, value - 1)) }
            else if (event.key === 'Enter' && items[paletteSelection]) { event.preventDefault(); items[paletteSelection].action(); closePalette() }
          }}
        />
        <kbd aria-hidden="true">ESC</kbd>
      </div>
      <div className="palette-list" id="palette-results" role="listbox" aria-label={t(paletteMode === 'files' ? '项目文件' : paletteMode === 'actions' ? '操作' : '随处搜索')}>
        {items.length ? items.map((item, index) => <button
          className={`${index === paletteSelection ? 'selected' : ''} ${item.ignored ? 'git-ignored' : ''}`}
          type="button"
          role="option"
          id={`palette-option-${index}`}
          aria-selected={index === paletteSelection}
          tabIndex={-1}
          key={`${item.label}-${index}`}
          title={`${item.label}${item.hint ? ` · ${item.hint}` : ''}${item.ignored ? ` · ${locale === 'zh-CN' ? 'Git 已忽略' : 'Ignored by Git'}` : ''}`}
          onMouseEnter={() => setPaletteSelection(index)}
          onClick={() => { item.action(); closePalette() }}
        >
          <span className="palette-result-icon"><item.icon size={17} aria-hidden="true" /></span>
          <span className="palette-result-label">{item.label}</span>
          <small>{item.hint}</small>
        </button>) : <div className="palette-none">{t('没有匹配的文件或命令')}</div>}
      </div>
      <div className="palette-footer"><Command size={13} aria-hidden="true" />{t(paletteMode === 'files' ? '项目文件' : paletteMode === 'actions' ? '操作' : '随处搜索')}<span>{t('↑↓ 选择 · ↵ 执行')}</span></div>
    </div>
  </div>
}
