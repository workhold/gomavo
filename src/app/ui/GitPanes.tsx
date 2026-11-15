import { useEffect, useMemo, useState } from 'react'
import { Check, GitMerge, RefreshCw, X } from 'lucide-react'
import { command, joinPath, type GitGraphCommit } from '../../lib/api'
import { computeGraphRows } from '../../lib/gitGraph'
import { findConflictBlocks, applyResolutions, type ConflictResolution } from '../../lib/conflicts'
import { iconButton } from '../helpers'
import type { Locale, MessageKey } from '../../lib/i18n'

const ROW_HEIGHT = 30
const LANE_WIDTH = 14
const COLORS = ['#7DB1F0', '#7DC989', '#D9B783', '#D693CB', '#69BDF1', '#B3AE60', '#54C5D0', '#E39971']

export interface GitLogPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  commits: GitGraphCommit[]
  loading: boolean
  refresh: () => Promise<void>
}

/** The Git log graph: lane columns drawn from the computed edge moves. */
export function GitLogPane(props: GitLogPaneProps) {
  const { t, locale, commits, loading, refresh } = props
  const rows = useMemo(() => computeGraphRows(commits), [commits])
  return <div className="git-log-pane">
    <div className="git-log-toolbar">
      <strong>{t('Git 日志')}</strong>
      <small>{commits.length ? (locale === 'zh-CN' ? `${commits.length} 个提交` : `${commits.length} commits`) : ''}</small>
      {iconButton(t('刷新'), RefreshCw, () => void refresh(), loading)}
    </div>
    <div className="git-log-list">
      {loading ? <div className="git-log-empty">{t('加载提交图…')}</div>
        : commits.length ? commits.map((commit, index) => {
          const row = rows[index]
          return <div className="git-log-row" key={commit.hash} title={`${commit.hash}\n${commit.author} · ${commit.date}`}>
            <svg className="git-log-graph" width={Math.max(2, (Math.max(row.column, ...row.edges.flatMap((edge) => [edge.from, edge.to])) + 1)) * LANE_WIDTH + 6} height={ROW_HEIGHT} aria-hidden="true">
              {row.edges.map((edge, edgeIndex) => {
                const color = COLORS[edge.from % COLORS.length]
                return <path
                  key={edgeIndex}
                  d={`M ${edge.from * LANE_WIDTH + 7} ${edge.fromNode ? ROW_HEIGHT / 2 : 0} L ${edge.to * LANE_WIDTH + 7} ${ROW_HEIGHT}`}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                />
              })}
              <circle cx={row.column * LANE_WIDTH + 7} cy={ROW_HEIGHT / 2} r={4.5}
                fill={commit.isHead ? '#F75464' : COLORS[row.column % COLORS.length]}
                stroke="#1b1c1e" strokeWidth={1.5} />
            </svg>
            <div className="git-log-meta">
              <span className="git-log-subject">{commit.subject}</span>
              <span className="git-log-refs">{commit.refs.map((reference) => <em key={reference} className={reference.includes('HEAD') ? 'head' : ''}>{reference.replace('HEAD -> ', '')}</em>)}</span>
              <span className="git-log-author">{commit.author}</span>
              <time>{commit.date.slice(0, 10)}</time>
              <strong className="git-log-hash">{commit.shortHash}</strong>
            </div>
          </div>
        }) : <div className="git-log-empty">{t('没有提交历史')}</div>}
    </div>
  </div>
}

export interface MergeResolverPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  path: string | null
  conflicts: string[]
  onResolved: () => void
  openConflict: (path: string) => void
  refreshGit: (workspace: string, options?: { refreshIgnored?: boolean }) => Promise<void>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

/** Three-way conflict resolution over `<<<<<<<` blocks in one file. */
export function MergeResolverPane(props: MergeResolverPaneProps) {
  const { t, root, path, conflicts, onResolved, openConflict, refreshGit, notify, formatError } = props
  const [content, setContent] = useState<string | null>(null)
  const [choices, setChoices] = useState<ConflictResolution[]>([])
  const [busy, setBusy] = useState(false)

  const blocks = useMemo(() => (content ? findConflictBlocks(content) : []), [content])

  // Load the conflicted file whenever the target changes.
  useEffect(() => {
    if (!path || !root) return
    let cancelled = false
    setBusy(true)
    void (async () => {
      try {
        const absolute = joinPath(root, path)
        const loaded = await command<string>('read_file', { path: absolute })
        if (cancelled) return
        setContent(loaded)
        setChoices(findConflictBlocks(loaded).map(() => 'both' as ConflictResolution))
      } catch (cause) {
        if (!cancelled) notify(formatError(cause), 'error')
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [formatError, notify, path, root])

  if (!path) {
    return <div className="merge-pane">
      <div className="merge-toolbar"><strong>{t('解决合并冲突')}</strong></div>
      {conflicts.length ? <>
        <div className="merge-hint">{t('以下文件存在冲突：')}</div>
        <div className="merge-file-list">
          {conflicts.map((conflict) => <button key={conflict} type="button" className="merge-file" onClick={() => openConflict(conflict)}><GitMerge size={14} />{conflict}</button>)}
        </div>
      </> : <div className="merge-hint">{t('当前没有需要解决的冲突。')}</div>}
    </div>
  }

  const applyAll = async () => {
    if (!root || content === null || !path) return
    setBusy(true)
    try {
      const resolved = applyResolutions(content, choices)
      const absolute = joinPath(root, path)
      await command('write_file', { path: absolute, content: resolved, expectedContent: content })
      await command('git_stage', { root, path })
      await refreshGit(root)
      notify(t('已解决并暂存 {name}', { name: path }))
      onResolved()
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setBusy(false) }
  }

  return <div className="merge-pane">
    <div className="merge-toolbar">
      <strong>{t('解决合并冲突')}</strong>
      <span title={path}>{path}</span>
      {blocks.length ? `${blocks.length} ${t('处冲突')}` : t('没有冲突标记')}
      {iconButton(t('应用并暂存'), Check, () => void applyAll(), busy || !blocks.length)}
      {iconButton(t('关闭'), X, onResolved, busy)}
    </div>
    <div className="merge-blocks">
      {blocks.map((block, index) => <div className="merge-block" key={block.startLine}>
        <div className="merge-block-choices">
          {(['ours', 'theirs', 'both', 'none'] as const).map((choice) => <button
            key={choice}
            type="button"
            className={choices[index] === choice ? 'selected' : ''}
            onClick={() => setChoices((current) => current.map((value, item) => item === index ? choice : value))}
          >{choice === 'ours' ? t('保留当前') : choice === 'theirs' ? t('保留传入') : choice === 'both' ? t('两者都保留') : t('都删除')}</button>)}
        </div>
        <div className="merge-sides">
          <pre className="merge-side ours">{content?.split('\n').slice(block.oursStart - 1, block.oursEnd).join('\n')}</pre>
          <pre className="merge-side theirs">{content?.split('\n').slice(block.theirsStart - 1, block.theirsEnd).join('\n')}</pre>
        </div>
      </div>)}
      {!blocks.length && <div className="merge-hint">{t('该文件中没有冲突标记。')}</div>}
    </div>
  </div>
}
