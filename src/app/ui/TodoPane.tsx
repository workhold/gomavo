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
  /** Live editor buffers override the corresponding disk search results. */
  openDocuments?: Array<{ path: string; content: string }>
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
}

const TODO_PATTERN = '\\b(?:TODO|FIXME|XXX|HACK)\\b'
const TODO_MARKER = /\b(?:TODO|FIXME|XXX|HACK)\b/gi
const EMPTY_DOCUMENTS: Array<{ path: string; content: string }> = []

function snippetAround(source: string, column: number): string {
  const chars = Array.from(source)
  if (chars.length <= 400) return source
  const start = Math.max(0, column - 1 - 200)
  const end = Math.min(start + 400, chars.length)
  return `${start ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}

function scanOpenDocuments(documents: Array<{ path: string; content: string }>, root: string): Map<string, SearchFileResult> {
  const results = new Map<string, SearchFileResult>()
  for (const document of documents) {
    if (!document.path.startsWith(`${root}/`)) continue
    const matches: SearchFileResult['matches'] = []
    for (const [lineIndex, source] of document.content.split(/\r?\n/).entries()) {
      for (const marker of source.matchAll(TODO_MARKER)) {
        const column = Array.from(source.slice(0, marker.index)).length + 1
        matches.push({ line: lineIndex + 1, column, length: marker[0].length, lineText: snippetAround(source, column) })
        if (matches.length >= 500) break
      }
      if (matches.length >= 500) break
    }
    results.set(document.path, { path: document.path, matches })
  }
  return results
}

function highlightedLine(source: string) {
  return source.split(/(\b(?:TODO|FIXME|XXX|HACK)\b)/gi).map((part, index) =>
    /^(?:TODO|FIXME|XXX|HACK)$/i.test(part) ? <span className="todo-keyword" key={index}>{part}</span> : part)
}

/** TODO tool window: project-wide scan of TODO/FIXME/XXX/HACK comments. */
export function TodoPane(props: TodoPaneProps) {
  const { t, root, revision, active, openDocuments = EMPTY_DOCUMENTS, navigateTo } = props
  const [diskResults, setDiskResults] = useState<SearchFileResult[]>([])
  const [openResults, setOpenResults] = useState<Map<string, SearchFileResult>>(new Map())
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const requestRef = useRef(0)
  const scannedRootRef = useRef(false)
  const visibleOpenPathsRef = useRef<Set<string>>(new Set())

  const scan = useCallback(async () => {
    if (!root) return
    const request = ++requestRef.current
    setScanning(true)
    setError(null)
    try {
      const found = await command<SearchFileResult[]>('search_in_files', {
        root,
        query: TODO_PATTERN,
        options: { regex: true, caseSensitive: false, wholeWord: false, includeIgnored: false },
      })
      if (request === requestRef.current) {
        setDiskResults(found)
        if (!scannedRootRef.current) {
          setExpanded(new Set(found.slice(0, 5).map((file) => file.path)))
          scannedRootRef.current = true
        }
      }
    } catch (cause) {
      if (request === requestRef.current) {
        setDiskResults([])
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (request === requestRef.current) setScanning(false)
    }
  }, [root])

  const openPaths = openDocuments.map((document) => document.path).sort().join('\0')
  useEffect(() => {
    requestRef.current += 1
    setDiskResults([])
    setOpenResults(new Map())
    setExpanded(new Set())
    setError(null)
    setScanning(false)
    scannedRootRef.current = false
    visibleOpenPathsRef.current = new Set()
  }, [root])
  useEffect(() => { if (active) void scan() }, [active, revision, openPaths, scan])
  useEffect(() => {
    if (!active || !root) return
    const timer = window.setTimeout(() => setOpenResults(scanOpenDocuments(openDocuments, root)), 180)
    return () => window.clearTimeout(timer)
  }, [active, openDocuments, root])

  const results = useMemo(() => {
    const merged = new Map(diskResults.map((file) => [file.path, file]))
    for (const [path, file] of openResults) {
      if (file.matches.length) merged.set(path, file)
      else merged.delete(path)
    }
    return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path))
  }, [diskResults, openResults])

  useEffect(() => {
    const visible = new Set([...openResults.values()].filter((file) => file.matches.length).map((file) => file.path))
    const newlyVisible = [...visible].filter((path) => !visibleOpenPathsRef.current.has(path))
    visibleOpenPathsRef.current = visible
    if (newlyVisible.length) setExpanded((current) => {
      const next = new Set(current)
      for (const path of newlyVisible) next.add(path)
      return next
    })
  }, [openResults])

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
            <span className="todo-line-text">{highlightedLine(match.lineText.trim())}</span>
            <small>:{match.line}</small>
          </button>)}
        </div>
      })}
    </div>
  </div>
}
