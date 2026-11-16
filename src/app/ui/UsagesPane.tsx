import { useEffect, useMemo, useState } from 'react'
import { Crosshair } from 'lucide-react'
import { command } from '../../lib/api'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface UsageItem {
  path: string
  line: number
  column: number
}

export interface UsagesPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  /** Identifier whose usages are shown; null clears the pane. */
  identifier: string | null
  usages: UsageItem[]
  busy: boolean
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
}

type Group = { path: string; items: Array<UsageItem & { lineText?: string }> }

/** Find Usages tool window: references grouped by file, with source-line preview. */
export function UsagesPane(props: UsagesPaneProps) {
  const { t, identifier, usages, busy, navigateTo } = props
  const [lineTexts, setLineTexts] = useState<Record<string, string>>({})

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, UsageItem[]>()
    for (const usage of usages) {
      const list = map.get(usage.path) ?? []
      list.push(usage)
      map.set(usage.path, list)
    }
    return [...map.entries()].map(([path, items]) => ({
      path,
      items: items
        .sort((a, b) => a.line - b.line)
        .map((item) => ({ ...item, lineText: lineTexts[`${item.path}:${item.line}`] })),
    }))
  }, [lineTexts, usages])

  // Fetch one-line previews for files not yet loaded. Open-tab content is
  // preferred by the caller when it seeds lineTexts; here we read from disk.
  useEffect(() => {
    if (!identifier || !usages.length) return
    let cancelled = false
    const missing = new Set(usages.map((usage) => `${usage.path}:${usage.line}`))
    void (async () => {
      const byFile = new Map<string, number[]>()
      for (const usage of usages) {
        if (lineTexts[`${usage.path}:${usage.line}`] !== undefined) missing.delete(`${usage.path}:${usage.line}`)
        else byFile.set(usage.path, [...(byFile.get(usage.path) ?? []), usage.line])
      }
      const next: Record<string, string> = {}
      for (const [path, lines] of byFile) {
        try {
          const content = await command<string>('read_file', { path })
          const all = content.split('\n')
          for (const line of lines) next[`${path}:${line}`] = all[line - 1] ?? ''
        } catch { /* external or unreadable files show without a preview */ }
      }
      if (!cancelled && Object.keys(next).length) setLineTexts((current) => ({ ...current, ...next }))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identifier, usages])

  if (!identifier) return <div className="panel-empty">{t('使用 ⇧F7 查找光标处符号的引用。')}</div>
  return <div className="usages-pane">
    <div className="usages-header">
      <Crosshair size={14} />
      <strong>{identifier}</strong>
      <span>{t('{count} 个引用', { count: usages.length })}</span>
      {busy && <span className="running-indicator" />}
    </div>
    {!busy && !usages.length && <div className="panel-empty">{t('没有找到引用。')}</div>}
    <div className="usages-list">
      {groups.map((group) => <div key={group.path} className="usages-file">
        <div className="usages-file-name" title={group.path}>{group.path.split('/').at(-1)}<small>{group.items.length}</small></div>
        {group.items.map((item, index) => <button
          className="usages-row" type="button"
          key={`${item.line}-${item.column}-${index}`}
          onClick={() => void navigateTo({ path: item.path, line: item.line, column: item.column })}
        >
          <small>:{item.line}</small>
          <span className="usages-line-text">{item.lineText?.trim() ?? '…'}</span>
        </button>)}
      </div>)}
    </div>
  </div>
}
