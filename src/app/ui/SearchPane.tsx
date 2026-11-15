import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, Search, WholeWord } from 'lucide-react'
import {
  command, displayName, relativePath,
  type ReplaceFileResult, type SearchFileResult, type SearchOptions,
} from '../../lib/api'
import { iconButton } from '../helpers'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface SearchPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  /** Re-render hook: search results may reference files changed by a replace. */
  revision: number
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
  onReplaced: (results: ReplaceFileResult[]) => Promise<void>
}

type OptionKey = 'caseSensitive' | 'wholeWord' | 'regex' | 'includeIgnored'

/** Project-wide Find in Files with optional replace, backed by search_in_files. */
export function SearchPane(props: SearchPaneProps) {
  const { t, locale, root, revision, navigateTo, onReplaced } = props
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [options, setOptions] = useState<SearchOptions>({ regex: false, caseSensitive: false, wholeWord: false, includeIgnored: false })
  const [results, setResults] = useState<SearchFileResult[]>([])
  const [searching, setSearching] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showReplace, setShowReplace] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const searchRequestRef = useRef(0)
  const queryInputRef = useRef<HTMLInputElement | null>(null)

  const totalMatches = useMemo(() => results.reduce((total, file) => total + file.matches.length, 0), [results])

  const runSearch = useCallback(async () => {
    if (!root || !query.trim() || searching) return
    const request = ++searchRequestRef.current
    setSearching(true)
    setError(null)
    try {
      const found = await command<SearchFileResult[]>('search_in_files', { root, query, options })
      if (request === searchRequestRef.current) {
        setResults(found)
        setExpanded(new Set(found.slice(0, 3).map((file) => file.path)))
      }
    } catch (cause) {
      if (request === searchRequestRef.current) {
        setResults([])
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (request === searchRequestRef.current) setSearching(false)
    }
  }, [options, query, root, searching])

  // Re-run the last search when the workspace index changed after a replace.
  useEffect(() => {
    if (revision > 0 && query) void runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const replaceAll = useCallback(async (event?: FormEvent) => {
    event?.preventDefault()
    if (!root || !query.trim() || replacing) return
    const request = ++searchRequestRef.current
    setReplacing(true)
    setError(null)
    try {
      const replaced = await command<ReplaceFileResult[]>('replace_in_files', {
        root, query, replacement, options,
      })
      if (request !== searchRequestRef.current) return
      await onReplaced(replaced)
      const count = replaced.reduce((total, file) => total + file.replacements, 0)
      setResults((current) => current.map((file) => {
        const change = replaced.find((item) => item.path === file.path)
        return change ? { ...file, matches: [] } : file
      }).filter((file) => file.matches.length))
      const tr = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
      if (count > 0) setResults([])
      setError(count === 0 ? tr('没有匹配可替换。', 'No matches to replace.') : null)
    } catch (cause) {
      if (request === searchRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === searchRequestRef.current) setReplacing(false)
    }
  }, [locale, onReplaced, query, replacing, replacement, root, options])

  const toggleOption = (key: OptionKey) => setOptions((current) => ({ ...current, [key]: !current[key] }))

  const optionButton = (key: OptionKey, Icon: typeof CaseSensitive, label: string) => <button
    type="button"
    className={`search-option ${options[key] ? 'active' : ''}`}
    title={label}
    aria-pressed={options[key]}
    onClick={() => toggleOption(key)}
  ><Icon size={14} strokeWidth={2} /></button>

  return <div className="search-pane">
    <form className="search-controls" onSubmit={(event) => { event.preventDefault(); void runSearch() }}>
      <div className="search-input-row">
        <Search size={14} />
        <input
          ref={queryInputRef}
          autoFocus
          value={query}
          placeholder={t('在项目中查找…')}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('在项目中查找…')}
        />
        <button type="button" className={`search-option ${showReplace ? 'active' : ''}`} title={t('替换')} aria-pressed={showReplace} onClick={() => setShowReplace((value) => !value)}><Replace size={14} /></button>
        {optionButton('caseSensitive', CaseSensitive, t('区分大小写'))}
        {optionButton('wholeWord', WholeWord, t('全字匹配'))}
        {optionButton('regex', Regex, t('正则表达式'))}
        {optionButton('includeIgnored', ChevronDown, t('包含已忽略文件'))}
      </div>
      {showReplace && <div className="search-input-row replace-row">
        <Replace size={14} />
        <input
          value={replacement}
          placeholder={t('替换为…')}
          aria-label={t('替换为…')}
          onChange={(event) => setReplacement(event.target.value)}
        />
        {iconButton(t('全部替换'), ReplaceAll, () => void replaceAll(), !root || !query.trim() || replacing)}
      </div>}
    </form>
    {error && <div className="search-status error" role="alert">{error}</div>}
    {!error && query && !searching && (results.length
      ? <div className="search-status">{locale === 'zh-CN' ? `在 ${results.length} 个文件中找到 ${totalMatches} 处匹配` : `${totalMatches} matches in ${results.length} files`}</div>
      : <div className="search-status">{t('没有找到匹配。')}</div>)}
    <div className="search-results" role="list">
      {results.map((file) => {
        const relative = root ? relativePath(root, file.path) : file.path
        const open = expanded.has(file.path)
        return <div key={file.path} role="listitem">
          <button className="search-file" type="button" onClick={() => setExpanded((current) => {
            const next = new Set(current)
            if (next.has(file.path)) next.delete(file.path)
            else next.add(file.path)
            return next
          })}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <strong>{displayName(file.path)}</strong>
            <small>{relative}</small>
            <span className="search-file-count">{file.matches.length}</span>
          </button>
          {open && file.matches.map((match, index) => <button
            className="search-match"
            type="button"
            key={`${match.line}-${match.column}-${index}`}
            onClick={() => void navigateTo({ path: file.path, line: match.line, column: match.column })}
          >
            <span className="search-match-position">{match.line}:{match.column}</span>
            <span className="search-match-text">{match.lineText.trim()}</span>
          </button>)}
        </div>
      })}
    </div>
  </div>
}
