import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor/editor/editor.api'
import { fileLanguage } from '../lib/api'
import { parseUnifiedDiff, sideBySideRows, type DiffLine, type SideBySideRow } from '../lib/unifiedDiff'
import './UnifiedDiffView.css'

type Props = {
  diff: string
  emptyMessage?: string
  ariaLabel?: string
  className?: string
  /** Source file path, used to highlight syntax inside changed lines. */
  path?: string
  /** Overrides language inferred from path (for custom file types). */
  language?: string
}

const ROW_HEIGHT = 20
const VIRTUALIZATION_THRESHOLD = 2500
const OVERSCAN_ROWS = 30

type Fragment = { text: string; kind?: string }

function diffLanguage(path?: string, language?: string): string {
  return language || fileLanguage(path ?? '')
}

function splitMatches(source: string, expression: RegExp, classify: (value: string) => string | undefined): Fragment[] {
  const fragments: Fragment[] = []
  let previous = 0
  for (const match of source.matchAll(expression)) {
    const offset = match.index
    if (offset > previous) fragments.push({ text: source.slice(previous, offset) })
    fragments.push({ text: match[0], kind: classify(match[0]) })
    previous = offset + match[0].length
  }
  if (previous < source.length) fragments.push({ text: source.slice(previous) })
  return fragments
}

function customFragments(source: string, language: string): Fragment[] {
  if (language === 'gitignore') {
    if (/^\s*#/.test(source)) return [{ text: source, kind: 'comment' }]
    return splitMatches(source, /!|\*\*|\*|\?|\[[^\]]+\]|\//g, (value) => value === '!' ? 'keyword' : 'pattern')
  }
  if (language === 'gomod' || language === 'gosum') {
    if (/^\s*\/\//.test(source)) return [{ text: source, kind: 'comment' }]
    const directive = language === 'gomod' ? /^(\s*)(module|go|toolchain|godebug|require|replace|exclude|retract|use|tool|ignore)\b/.exec(source) : null
    const start = directive ? directive[0].length : 0
    const fragments: Fragment[] = directive ? [
      { text: directive[1] }, { text: directive[2], kind: 'keyword' },
    ] : []
    return fragments.concat(splitMatches(source.slice(start), /\/\/.*$|"(?:\\.|[^"\\])*"|=>|\bh1:[A-Za-z0-9+/=]+|\bv\d+\.\d+\.\d+(?:[-+][\w.]+)?|\b\d+\.\d+(?:\.\d+)?\b|[\w.-]+(?:\/[\w.~+-]+)+/g, (value) => {
      if (value.startsWith('//')) return 'comment'
      if (value.startsWith('h1:')) return 'hash'
      if (value.startsWith('"') || value.includes('/')) return 'string'
      if (value === '=>') return 'operator'
      return 'number'
    }))
  }
  return []
}

function tokenKind(type: string): string | undefined {
  if (type.includes('comment')) return 'comment'
  if (type.includes('string') || type.includes('regexp')) return 'string'
  if (type.includes('keyword')) return 'keyword'
  if (type.includes('number')) return 'number'
  if (type.includes('function')) return 'function'
  if (type.includes('type')) return 'type'
  if (type.includes('tag')) return 'tag'
  if (type.includes('attribute')) return 'attribute'
  if (type.includes('operator')) return 'operator'
  return undefined
}

function fallbackFragments(source: string, language: string): Fragment[] {
  if (language === 'markdown') {
    if (/^\s*#{1,6}\s/.test(source)) return [{ text: source, kind: 'keyword' }]
    return splitMatches(source, /`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*/g, (value) => value.startsWith('`') ? 'string' : 'keyword')
  }
  if (language === 'html') {
    return splitMatches(source, /<!--.*?-->|<\/?[A-Za-z][^>]*>|"(?:\\.|[^"\\])*"/g, (value) => value.startsWith('<!--') ? 'comment' : value.startsWith('<') ? 'tag' : 'string')
  }
  if (language === 'go' || language === 'typescript' || language === 'javascript') {
    return splitMatches(source, /\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|function|go|goto|if|import|interface|let|map|new|package|range|return|select|struct|switch|type|var|class|export|extends|async|await|from|of|try|catch|throw|public|private)\b|\b\d+(?:\.\d+)?\b/g, (value) => {
      if (value.startsWith('//') || value.startsWith('/*')) return 'comment'
      if (/^["'`]/.test(value)) return 'string'
      if (/^\d/.test(value)) return 'number'
      return 'keyword'
    })
  }
  if (language === 'json' || language === 'yaml' || language === 'ini' || language === 'css') {
    return splitMatches(source, /(?:#|\/\/|;).*?$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|undefined|yes|no)\b|\b\d+(?:\.\d+)?\b|[\w.-]+(?=\s*[:=])/g, (value) => {
      if (/^(#|\/\/|;)/.test(value)) return 'comment'
      if (/^["']/.test(value)) return 'string'
      if (/^\d/.test(value)) return 'number'
      if (/^(true|false|null|undefined|yes|no)$/.test(value)) return 'keyword'
      return 'attribute'
    })
  }
  return [{ text: source }]
}

function syntaxFragments(source: string, language: string): Fragment[] {
  if (!source || language === 'plaintext') return [{ text: source }]
  try {
    const tokens = monaco.editor.tokenize(source, language)[0] ?? []
    if (tokens.some((token) => tokenKind(token.type))) return tokens.map((token, index) => ({
      text: source.slice(token.offset, tokens[index + 1]?.offset ?? source.length),
      kind: tokenKind(token.type),
    }))
  } catch {
    // Plain text remains useful when an optional language provider is missing.
  }
  if (language === 'gomod' || language === 'gosum' || language === 'gitignore') return customFragments(source, language)
  return fallbackFragments(source, language)
}

function DiffRow({ line, language, tokenizationVersion }: { line: DiffLine; language: string; tokenizationVersion: number }) {
  const sourceLine = line.kind === 'addition' || line.kind === 'deletion' || line.kind === 'context'
  const fragments = useMemo(() => sourceLine ? syntaxFragments(line.text.slice(1), language) : [], [language, line.text, sourceLine, tokenizationVersion])
  return <div className={`unified-diff-row ${line.kind}`}>
    <span className="unified-diff-gutter" aria-hidden="true">{line.oldLine ?? ''}</span>
    <span className="unified-diff-gutter" aria-hidden="true">{line.newLine ?? ''}</span>
    <span className="unified-diff-code">{sourceLine ? <><span className="unified-diff-prefix">{line.text[0]}</span>{fragments.map((fragment, index) => <span className={fragment.kind ? `unified-diff-token ${fragment.kind}` : undefined} key={index}>{fragment.text}</span>)}</> : line.text || ' '}</span>
  </div>
}

function SideCell({ line, language, tokenizationVersion }: { line: DiffLine | null; language: string; tokenizationVersion: number }) {
  const source = line?.text.slice(1) ?? ''
  const fragments = useMemo(() => syntaxFragments(source, language), [source, language, tokenizationVersion])
  return <div className={`side-diff-cell ${line?.kind ?? 'blank'}`}>
    <span className="unified-diff-gutter" aria-hidden="true">{line?.kind === 'addition' ? line.newLine : line?.oldLine ?? ''}</span>
    <span className="unified-diff-code">{fragments.map((fragment, index) => <span className={fragment.kind ? `unified-diff-token ${fragment.kind}` : undefined} key={index}>{fragment.text}</span>)}</span>
  </div>
}

function SideRow({ row, language, tokenizationVersion }: { row: SideBySideRow; language: string; tokenizationVersion: number }) {
  return row.kind === 'header'
    ? <div className={`side-diff-header ${row.line.kind}`}>{row.line.text || ' '}</div>
    : <div className="side-diff-row"><SideCell line={row.old} language={language} tokenizationVersion={tokenizationVersion} /><SideCell line={row.next} language={language} tokenizationVersion={tokenizationVersion} /></div>
}

const VIEW_KEY = 'gomavo.diffView'
function savedMode(): 'unified' | 'side' {
  try { return localStorage.getItem(VIEW_KEY) === 'side' ? 'side' : 'unified' } catch { return 'unified' }
}

/** Scrollable, read-only unified diff shared by Git and local file history. */
export function UnifiedDiffView({ diff, emptyMessage, ariaLabel, className, path, language }: Props) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [mode, setMode] = useState<'unified' | 'side'>(savedMode)
  const sideRows = useMemo(() => sideBySideRows(lines), [lines])
  const syntaxLanguage = useMemo(() => diffLanguage(path, language), [path, language])
  const [tokenizationVersion, setTokenizationVersion] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)

  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
      scrollRef.current.scrollLeft = 0
    }
    setScrollTop(0)
  }, [diff])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const updateHeight = () => setViewportHeight(element.clientHeight || 600)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (syntaxLanguage === 'plaintext') return
    let cancelled = false
    // Monaco loads many built-in language tokenizers on first use. Trigger that
    // load so a diff opened before its editor still receives syntax colors.
    void monaco.editor.colorize('', syntaxLanguage, { tabSize: 4 }).then(() => {
      if (!cancelled) setTokenizationVersion((version) => version + 1)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [syntaxLanguage])

  const rowCount = mode === 'side' ? sideRows.length : lines.length
  const virtual = rowCount > VIRTUALIZATION_THRESHOLD
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS) : 0
  const end = virtual ? Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS) : rowCount
  const visibleLines = virtual ? lines.slice(start, end) : lines
  const visibleSideRows = virtual ? sideRows.slice(start, end) : sideRows

  // Reserve horizontal space for the widest line even when that row is outside
  // the virtualized window, so horizontal scrolling does not jump on scroll.
  const maxColumns = useMemo(() => lines.reduce((width, line) => Math.max(width, line.text.replace(/\t/g, '    ').length), 0), [lines])
  const contentWidth = `max(100%, calc(84px + ${maxColumns}ch))`

  const changeMode = (next: 'unified' | 'side') => {
    setMode(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* Keep the in-memory choice. */ }
  }

  return <div className={`diff-view-shell${className ? ` ${className}` : ''}`}>
    <div className="diff-view-toolbar" role="group" aria-label="Diff layout">
      <button type="button" className={mode === 'unified' ? 'selected' : ''} aria-pressed={mode === 'unified'} onClick={() => changeMode('unified')}>{document.documentElement.lang === 'zh-CN' ? '单列' : 'Unified'}</button>
      <button type="button" className={mode === 'side' ? 'selected' : ''} aria-pressed={mode === 'side'} onClick={() => changeMode('side')}>{document.documentElement.lang === 'zh-CN' ? '两列对比' : 'Side by side'}</button>
    </div>
    <div
    ref={scrollRef}
    className="unified-diff-view"
    role="region"
    aria-label={ariaLabel}
    onScroll={virtual ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
  >
    {lines.length ? mode === 'unified' ? <div className="unified-diff-content" style={{ minWidth: contentWidth }}>
      {virtual && <div aria-hidden="true" style={{ height: start * ROW_HEIGHT }} />}
      {visibleLines.map((line, index) => <DiffRow key={start + index} line={line} language={syntaxLanguage} tokenizationVersion={tokenizationVersion} />)}
      {virtual && <div aria-hidden="true" style={{ height: (lines.length - end) * ROW_HEIGHT }} />}
    </div> : <div className="side-diff-content" style={{ minWidth: `max(100%, calc(92px + ${maxColumns * 2}ch))` }}>
      {virtual && <div aria-hidden="true" style={{ height: start * ROW_HEIGHT }} />}
      {visibleSideRows.map((row, index) => <SideRow key={start + index} row={row} language={syntaxLanguage} tokenizationVersion={tokenizationVersion} />)}
      {virtual && <div aria-hidden="true" style={{ height: (sideRows.length - end) * ROW_HEIGHT }} />}
    </div> : <div className="unified-diff-empty">{emptyMessage ?? 'No text diff to display.'}</div>}
    </div>
  </div>
}
