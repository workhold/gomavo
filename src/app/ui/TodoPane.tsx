import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ListTodo, RefreshCw } from 'lucide-react'
import { command, relativePath, type SearchFileResult } from '../../lib/api'
import { iconButton } from '../helpers'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface TodoPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  /** Bumps whenever the workspace changed on disk; re-scans when it does. */
  revision: number
  /** True while the TODO tab is visible; rescans when it turns on. */
  active: boolean
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
}

const TODO_PATTERN = '(TODO|FIXME|XXX|HACK)(\\(|:|\\s)'

/** TODO tool window: project-wide scan of TODO/FIXME/XXX/HACK comments. */
export function TodoPane(props: TodoPaneProps) {
  const { t, root, revision, active, navigateTo } = props
  const [results, setResults] = useState<SearchFileResult[]>([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const requestRef = useRef(0)

  const scan = useCallback(async () => {
    if (!root) return
    const request = ++requestRef.current
    setScanning(true)
    setError(null)
    try {
      const found = await command<SearchFileResult[]>('search_in_files', {
        root,
        query: TODO_PATTERN,
        options: { regex: true, caseSensitive: true, wholeWord: false, includeIgnored: false },
      })
      if (request === requestRef.current) {
        setResults(found)
        setExpanded(new Set(found.slice(0, 5).map((file) => file.path)))
      }
    } catch (cause) {
      if (request === requestRef.current) {
        setResults([])
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (request === requestRef.current) setScanning(false)
    }
  }, [root])

  useEffect(() => { if (active) void scan() }, [active, revision, scan])

  const total = useMemo(() => results.reduce((count, file) => count + file.matches.length, 0), [results])

  return <div className="todo-pane">
    <div className="todo-toolbar">
      <span className="todo-summary"><ListTodo size={14} />{t('{count} 个 TODO', { count: total })}</span>
      {iconButton(t('刷新'), RefreshCw, () => void scan(), scanning || !root)}
    </div>
    {error && <div className="todo-error" role="alert">{error}</div>}
    {!error && !results.length && !scanning && <div className="panel-empty">{t('没有找到 TODO 注释。')}</div>}
    <div className="todo-list">
      {results.map((file) => {
        const open = expanded.has(file.path)
        const relative = root ? relativePath(root, file.path) : file.path
        return <div key={file.path}>
          <button className="todo-file-row" type="button" onClick={() => setExpanded((current) => {
            const next = new Set(current)
            if (next.has(file.path)) next.delete(file.path)
            else next.add(file.path)
            return next
          })} aria-expanded={open}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{relative}</span>
            <small>{file.matches.length}</small>
          </button>
          {open && file.matches.map((match) => <button
            className="todo-item-row" type="button"
            key={`${match.line}-${match.column}`}
            onClick={() => void navigateTo({ path: file.path, line: match.line, column: match.column })}
            title={relative}
          >
            <span className="todo-line-text">{match.lineText.trim()}</span>
            <small>:{match.line}</small>
          </button>)}
        </div>
      })}
    </div>
  </div>
}
