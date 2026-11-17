import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { RefObject } from 'react'
import {
  AlertCircle, Bug, Check, ChevronDown, FlaskConical, GitBranch, History,
  ListTodo, PanelBottomClose, PanelBottomOpen, Play, RefreshCw, Search, Square, TerminalSquare, Trash2, X,
} from 'lucide-react'
import { TerminalPane } from '../../components/TerminalPane'
import { UnifiedDiffView } from '../../components/UnifiedDiffView'
import {
  displayName, joinPath, relativePath,
  type CoverageFile, type CoverageProfile, type FileEntry, type GitFileHistoryEntry,
  type ReplaceFileResult,
} from '../../lib/api'
import type { DiagnosticEntry } from '../../lib/lsp'
import type { LocalHistoryEntry } from '../../lib/localHistory'
import { coveragePercent } from '../../lib/coverage'
import { parseAnsiLine, findOutputReferences, resolveOutputReference } from '../../lib/outputParsing'
import { iconButton } from '../helpers'
import { LOCAL_HISTORY_LABELS } from '../constants'
import { SearchPane } from './SearchPane'
import { DebugPane } from './DebugPane'
import { GitLogPane, MergeResolverPane } from './GitPanes'
import { TodoPane } from './TodoPane'
import { UsagesPane, type UsageItem } from './UsagesPane'
import type { DapThread } from '../../lib/debug/dapClient'
import type { DebugConsoleLine, DebuggerFrame, DebuggerState, DebuggerVariable, WatchEntry } from '../hooks/useDebugger'
import type {
  FileHistorySource, GitFileHistoryView, OpenFile, OutputLine, PanelView, TaskOptions, TestResult,
} from '../types'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface BottomPanelProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  panelOpen: boolean
  setPanelOpen: (value: boolean | ((current: boolean) => boolean)) => void
  panelView: PanelView
  setPanelView: (value: PanelView) => void
  terminalFontSize: number
  runningTask: string | null
  runTask: (task: string, options?: TaskOptions) => void | Promise<unknown>
  lastTestOptionsRef: RefObject<TaskOptions>
  output: OutputLine[]
  setOutput: (value: OutputLine[]) => void
  testResults: TestResult[]
  testPassed: number
  testFailed: number
  testPackages: Array<[string, TestResult[]]>
  testOutput: OutputLine[]
  testOutputByCase: Map<string, OutputLine[]>
  coverageProfile: CoverageProfile | null
  packageDirectory: (packageName: string) => string | null
  runSelection: (task: 'run' | 'test' | 'build', options?: TaskOptions) => void
  jumpToTest: (packageName: string, testName: string) => Promise<void>
  rerunTest: (packageName: string, testName: string) => Promise<void>
  diagnostics: DiagnosticEntry[]
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
  gitDiff: { path: string; staged: boolean; content: string } | null
  openFile: (path: string) => Promise<boolean>
  gitFileHistory: GitFileHistoryView | null
  fileHistorySource: FileHistorySource
  setFileHistorySource: (value: FileHistorySource) => void
  localHistoryEntries: LocalHistoryEntry[]
  selectedLocalHistoryEntry: LocalHistoryEntry | null
  setSelectedLocalHistoryId: (value: number | null) => void
  selectedLocalDiff: string
  selectedHistoryEntry: GitFileHistoryEntry | null
  openGitFileCommitDiff: (entry: GitFileHistoryEntry) => Promise<void>
  projectFiles: FileEntry[]
  openDocuments: OpenFile[]
  searchRevision: number
  onReplaced: (results: ReplaceFileResult[]) => Promise<void>
  debugState: DebuggerState
  debugFrames: DebuggerFrame[]
  debugSelectedFrameIndex: number
  debugSelectFrame: (index: number) => void
  debugVariables: DebuggerVariable[]
  debugExpandVariable: (groupIndex: number, path: number[]) => Promise<void>
  debugConsole: DebugConsoleLine[]
  debugControl: (command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'disconnect', threadId?: number) => Promise<void>
  debugCurrentThreadId: number | null
  /** Goroutine switcher, watch expressions, and REPL evaluation. */
  debugThreads: DapThread[]
  debugSelectThread: (threadId: number) => Promise<void>
  debugWatches: WatchEntry[]
  debugAddWatch: (expression: string) => void
  debugRemoveWatch: (id: number) => void
  debugEvaluateRepl: (expression: string) => Promise<void>
  dlvInstalled: boolean
  installDlv: () => void
  startDebug: () => void
  /** Find Usages results (identifier + references) shown in the usages tab. */
  usages: { identifier: string; items: UsageItem[] } | null
  usagesBusy: boolean
  gitGraph: import('../../lib/api').GitGraphCommit[]
  gitGraphLoading: boolean
  refreshGitGraph: () => Promise<void>
  mergeConflicts: string[]
  mergeResolverPath: string | null
  openMergeResolver: (path: string) => void
  mergeResolved: () => void
  refreshGit: (workspace: string, options?: { refreshIgnored?: boolean }) => Promise<void>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

const MIN_PANEL_HEIGHT = 160
const DEFAULT_PANEL_HEIGHT = 246
const PANEL_HEIGHT_STORAGE_KEY = 'gomavo.bottomPanel.height'

function savedPanelHeight(): number {
  try {
    const value = Number(localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY))
    return Number.isFinite(value) && value >= MIN_PANEL_HEIGHT ? value : DEFAULT_PANEL_HEIGHT
  } catch {
    return DEFAULT_PANEL_HEIGHT
  }
}

/** One console line with ANSI colors and clickable file:line references. */
function OutputText(props: { line: OutputLine; root: string | null; projectFiles: FileEntry[]; navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean> }) {
  const { line, root, projectFiles, navigateTo } = props
  const paths = projectFiles.map((entry) => entry.path)
  const references = useMemo(() => findOutputReferences(line.text), [line.text])
  const nodes: ReactNode[] = []
  let consumed = 0
  for (const reference of references) {
    const match = line.text.indexOf(reference.text, consumed)
    if (match < 0) continue
    if (match > consumed) nodes.push(...parseAnsiLine(line.text.slice(consumed, match)).map((span, index) => <span className={span.className} key={`t${consumed}-${index}`}>{span.text}</span>))
    const resolved = resolveOutputReference(reference, root, paths)
    nodes.push(resolved
      ? <button
        className="output-reference"
        key={`r${match}`}
        type="button"
        title={resolved}
        onClick={() => void navigateTo({ path: resolved, line: reference.paths[0].line, column: reference.paths[0].column ?? 1 })}
      >{reference.text}</button>
      : <span key={`r${match}`}>{reference.text}</span>)
    consumed = match + reference.text.length
  }
  if (consumed < line.text.length) nodes.push(...parseAnsiLine(line.text.slice(consumed)).map((span, index) => <span className={span.className} key={`t${consumed}-${index}`}>{span.text}</span>))
  return <>{nodes}</>
}

interface TestTreeNode {
  name: string
  fullName: string
  status: TestResult['status'] | null
  elapsed?: number
  children: Map<string, TestTreeNode>
  leaf: boolean
}

/** Build a subtest tree from `TestFoo/sub_case` style names. */
function buildTestTree(results: TestResult[]): TestTreeNode[] {
  const root: TestTreeNode = { name: '', fullName: '', status: null, children: new Map(), leaf: false }
  for (const result of results) {
    if (result.name === '(package)') continue
    const segments = result.name.split('/')
    let node = root
    let prefix = ''
    for (let depth = 0; depth < segments.length; depth += 1) {
      prefix = prefix ? `${prefix}/${segments[depth]}` : segments[depth]
      let child = node.children.get(segments[depth])
      if (!child) {
        child = { name: segments[depth], fullName: prefix, status: null, children: new Map(), leaf: depth === segments.length - 1 }
        node.children.set(segments[depth], child)
      }
      node = child
    }
    node.status = result.status
    node.elapsed = result.elapsed
    node.leaf = true
  }
  const aggregate = (node: TestTreeNode): void => {
    if (node.children.size) {
      const statuses = [...node.children.values()].map((child) => aggregate(child) ?? child.status)
      node.status = statuses.includes('fail') ? 'fail' : statuses.every((status) => status === 'pass') ? 'pass' : node.status
    }
  }
  const children = [...root.children.values()]
  for (const child of children) aggregate(child)
  return children
}

function TestTreeNodes(props: {
  nodes: TestTreeNode[]
  packageName: string
  depth: number
  runningTask: string | null
  jumpToTest: (packageName: string, testName: string) => Promise<void>
  rerunTest: (packageName: string, testName: string) => Promise<void>
  onSelectCase: (packageName: string, fullName: string) => void
}) {
  const { nodes, packageName, depth, runningTask, jumpToTest, rerunTest, onSelectCase } = props
  return <>{nodes.map((node) => {
    const children = [...node.children.values()]
    return <div key={node.fullName}>
      <div className={`test-tree-row test-case ${node.status === 'fail' ? 'failed' : node.status === 'pass' ? 'passed' : ''}`} style={{ paddingLeft: depth * 14 }}>
        {children.length ? <ChevronDown size={12} className="test-subtoggle" /> : <span className="test-indent" />}
        {node.status === 'fail' ? <X size={14} /> : node.status === 'pass' ? <Check size={14} /> : node.status === 'skip' ? <Square size={12} /> : <Play size={13} />}
        <button type="button" className="test-source-link" onClick={() => { onSelectCase(packageName, node.fullName); void jumpToTest(packageName, node.fullName) }} title={node.fullName}>{node.name}</button>
        {node.elapsed !== undefined && <small>{node.elapsed.toFixed(2)}s</small>}
        <button type="button" className="test-rerun" title={`重跑 ${node.fullName}`} disabled={!!runningTask} onClick={() => void rerunTest(packageName, node.fullName)}><Play size={12} /></button>
      </div>
      {children.length ? <TestTreeNodes nodes={children} packageName={packageName} depth={depth + 1} runningTask={runningTask} jumpToTest={jumpToTest} rerunTest={rerunTest} onSelectCase={onSelectCase} /> : null}
    </div>
  })}</>
}

export function BottomPanel(props: BottomPanelProps) {
  const {
    t, locale, root, panelOpen, setPanelOpen, panelView, setPanelView, terminalFontSize, runningTask, runTask,
    lastTestOptionsRef, output, setOutput, testResults, testPassed, testFailed, testPackages, testOutput,
    testOutputByCase, coverageProfile, packageDirectory, runSelection, jumpToTest, rerunTest, diagnostics,
    navigateTo, gitDiff, openFile, gitFileHistory, fileHistorySource, setFileHistorySource,
    localHistoryEntries, selectedLocalHistoryEntry, setSelectedLocalHistoryId, selectedLocalDiff,
    selectedHistoryEntry, openGitFileCommitDiff, projectFiles, openDocuments, searchRevision, onReplaced,
    debugState, debugFrames, debugSelectedFrameIndex, debugSelectFrame, debugVariables,
    debugExpandVariable, debugConsole, debugControl, debugCurrentThreadId, dlvInstalled, installDlv, startDebug,
    debugThreads, debugSelectThread, debugWatches, debugAddWatch, debugRemoveWatch, debugEvaluateRepl,
    usages, usagesBusy,
    gitGraph, gitGraphLoading, refreshGitGraph, mergeConflicts, mergeResolverPath, openMergeResolver,
    mergeResolved, refreshGit, notify, formatError,
  } = props
  const [selectedCase, setSelectedCase] = useState<{ packageName: string; fullName: string } | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const latestHeightRef = useRef<number | null>(null)
  const [panelHeight, setPanelHeight] = useState(savedPanelHeight)
  const [maxPanelHeight, setMaxPanelHeight] = useState(1200)

  useEffect(() => {
    const parent = panelRef.current?.parentElement
    if (!parent) return
    const updateMaximum = () => {
      // Reserve the tab bar and a useful editing area while resizing.
      const maximum = Math.max(MIN_PANEL_HEIGHT, parent.clientHeight - 226)
      setMaxPanelHeight(maximum)
      setPanelHeight((height) => Math.min(height, maximum))
    }
    updateMaximum()
    const observer = new ResizeObserver(updateMaximum)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const savePanelHeight = (height: number) => {
    try { localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(height)) } catch { /* Storage is optional. */ }
  }
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, y: event.clientY, height: panelRef.current?.getBoundingClientRect().height ?? panelHeight }
    latestHeightRef.current = null
  }
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const height = Math.max(MIN_PANEL_HEIGHT, Math.min(maxPanelHeight, drag.height + drag.y - event.clientY))
    latestHeightRef.current = height
    setPanelHeight(height)
  }
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    savePanelHeight(latestHeightRef.current ?? panelRef.current?.getBoundingClientRect().height ?? panelHeight)
    latestHeightRef.current = null
  }
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (event.key === 'ArrowUp') next = panelHeight + (event.shiftKey ? 50 : 10)
    else if (event.key === 'ArrowDown') next = panelHeight - (event.shiftKey ? 50 : 10)
    else if (event.key === 'Home') next = MIN_PANEL_HEIGHT
    else if (event.key === 'End') next = maxPanelHeight
    else return
    event.preventDefault()
    const height = Math.max(MIN_PANEL_HEIGHT, Math.min(maxPanelHeight, next))
    setPanelHeight(height)
    savePanelHeight(height)
  }
  const coverageFiles = useMemo(() => {
    if (!coverageProfile || !root) return []
    const paths = projectFiles.map((entry) => entry.path)
    const resolved: Array<{ path: string; file: CoverageFile }> = []
    for (const file of coverageProfile.files) {
      // Profile paths are absolute for workspace files; suffix-match otherwise.
      const absolute = file.path.startsWith('/') ? file.path : `${root}/${file.path}`
      const match = paths.includes(absolute) ? absolute
        : paths.find((candidate) => candidate.endsWith(`/${file.path}`))
      if (match) resolved.push({ path: match, file })
    }
    return resolved
  }, [coverageProfile, projectFiles, root])
  const totalCoverage = coverageFiles.length
    ? Math.round(coverageFiles.reduce((total, entry) => total + coveragePercent(entry.file.blocks), 0) / coverageFiles.length)
    : null

  const tab = (view: PanelView, label: string, icon: ReactNode, extra?: ReactNode) => <button
    className={panelView === view ? 'selected' : ''} type="button"
    onClick={() => { setPanelView(view); setPanelOpen(true) }}
  >{icon}{label}{extra}</button>

  return <section ref={panelRef} className={`bottom-panel ${panelOpen ? '' : 'collapsed'}`} aria-label={t('底部工具窗口')} style={panelOpen ? { height: Math.min(panelHeight, maxPanelHeight) } : undefined}>
    {panelOpen && <div
      className="panel-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label={locale === 'zh-CN' ? '调整底部工具窗口高度' : 'Resize bottom tool window'}
      aria-orientation="horizontal"
      aria-valuemin={MIN_PANEL_HEIGHT}
      aria-valuemax={maxPanelHeight}
      aria-valuenow={Math.min(panelHeight, maxPanelHeight)}
      title={locale === 'zh-CN' ? '上下拖动调整高度；方向键微调' : 'Drag vertically to resize; use arrow keys to adjust'}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onKeyDown={resizeWithKeyboard}
    />}
    <div className="panel-tabs">
      {tab('output', t('Run'), <Play size={14} />, runningTask ? <span className="running-indicator" /> : null)}
      {tab('tests', t('Test Results'), <FlaskConical size={14} />, testResults.length > 0 ? <span className="panel-count">{testPassed + testFailed}</span> : null)}
      {tab('search', t('Search'), <Search size={14} />)}
      {tab('usages', t('查找用法'), <Search size={14} />, usages ? <span className="panel-count">{usages.items.length}</span> : null)}
      {tab('todo', 'TODO', <ListTodo size={14} />)}
      {tab('debug', t('Debug'), <Bug size={14} />, debugState !== 'idle' ? <span className="running-indicator" /> : null)}
      {tab('terminal', t('Terminal'), <TerminalSquare size={14} />)}
      {tab('problems', t('Problems'), <AlertCircle size={14} />, diagnostics.length > 0 ? <span className="panel-count">{diagnostics.length}</span> : null)}
      {gitGraph.length > 0 ? tab('log', t('Git 日志'), <GitBranch size={14} />) : null}
      {mergeConflicts.length > 0 ? tab('merge', t('合并冲突'), <GitBranch size={14} />, <span className="panel-count">{mergeConflicts.length}</span>) : null}
      {gitDiff && <button className={panelView === 'diff' ? 'selected' : ''} type="button" onClick={() => { setPanelView('diff'); setPanelOpen(true) }}><GitBranch size={14} />Diff · {displayName(gitDiff.path)}</button>}
      {gitFileHistory && <button className={panelView === 'history' ? 'selected' : ''} type="button" onClick={() => { setPanelView('history'); setPanelOpen(true) }}><History size={14} />{t('文件历史')} · {displayName(gitFileHistory.path)}</button>}
      <div className="panel-tabs-spacer" />
      {panelView === 'output' && iconButton(t('清空输出'), Trash2, () => setOutput([]))}
      {panelView === 'tests' && iconButton(t('重新运行测试'), RefreshCw, () => void runTask('test', lastTestOptionsRef.current), !root || !!runningTask)}
      {iconButton(t(panelOpen ? '收起工具窗口' : '展开工具窗口'), panelOpen ? PanelBottomClose : PanelBottomOpen, () => setPanelOpen((value) => !value))}
    </div>
    <div className="panel-body">
      <div className={`panel-page ${panelView === 'terminal' ? 'visible' : ''}`}><TerminalPane root={root} visible={panelOpen && panelView === 'terminal'} locale={locale} fontSize={terminalFontSize} /></div>
      <div className={`panel-page output-page ${panelView === 'output' ? 'visible' : ''}`}>{output.length
        ? output.map((line) => <div className={`output-line ${line.stream}`} key={line.id}><OutputText line={line} root={root} projectFiles={projectFiles} navigateTo={navigateTo} /></div>)
        : <div className="panel-empty">{t('运行或编译项目后，结果将在这里显示。')}</div>}</div>
      <div className={`panel-page search-page ${panelView === 'search' ? 'visible' : ''}`}>
        <SearchPane t={t} locale={locale} root={root} revision={searchRevision} navigateTo={navigateTo} onReplaced={onReplaced} />
      </div>
      <div className={`panel-page ${panelView === 'usages' ? 'visible' : ''}`}>
        <UsagesPane t={t} locale={locale} identifier={usages?.identifier ?? null} usages={usages?.items ?? []} busy={usagesBusy} navigateTo={navigateTo} />
      </div>
      <div className={`panel-page ${panelView === 'todo' ? 'visible' : ''}`}>
        <TodoPane t={t} locale={locale} root={root} revision={searchRevision} active={panelView === 'todo' && panelOpen} openDocuments={openDocuments} navigateTo={navigateTo} />
      </div>
      <div className={`panel-page debug-page ${panelView === 'debug' ? 'visible' : ''}`}>
        <DebugPane
          t={t} locale={locale} debugState={debugState} frames={debugFrames}
          selectedFrameIndex={debugSelectedFrameIndex} selectFrame={debugSelectFrame}
          variables={debugVariables} expandVariable={debugExpandVariable}
          consoleLines={debugConsole} control={debugControl} currentThreadId={debugCurrentThreadId}
          threads={debugThreads} selectThread={debugSelectThread}
          watches={debugWatches} addWatch={debugAddWatch} removeWatch={debugRemoveWatch}
          evaluateRepl={debugEvaluateRepl}
          dlvInstalled={dlvInstalled} installDlv={installDlv} startDebug={startDebug}
        />
      </div>
      <div className={`panel-page git-log-page ${panelView === 'log' ? 'visible' : ''}`}>
        <GitLogPane t={t} locale={locale} root={root} commits={gitGraph} loading={gitGraphLoading} refresh={refreshGitGraph} />
      </div>
      <div className={`panel-page merge-page ${panelView === 'merge' ? 'visible' : ''}`}>
        <MergeResolverPane
          t={t} locale={locale} root={root} path={mergeResolverPath} conflicts={mergeConflicts}
          onResolved={mergeResolved} openConflict={openMergeResolver} refreshGit={refreshGit}
          notify={notify} formatError={formatError}
        />
      </div>
      <div className={`panel-page tests-page ${panelView === 'tests' ? 'visible' : ''}`}>
        <div className="test-runner">
          <div className="test-tree">
            <div className="test-summary"><FlaskConical size={14} /><strong>{t('All Tests')}</strong><span className="test-summary-stats">{testFailed > 0 && <em className="failed">{t('{count} failed', { count: testFailed })}</em>}{testPassed > 0 && <em className="passed">{t('{count} passed', { count: testPassed })}</em>}{totalCoverage !== null && <em className="coverage">{t('覆盖率 {percent}%', { percent: totalCoverage })}</em>}</span></div>
            {coverageFiles.length > 0 && <div className="coverage-list">
              {coverageFiles.slice(0, 12).map(({ path, file }) => <button
                className="coverage-row" type="button" key={path}
                onClick={() => void navigateTo({ path, line: 1, column: 1 })}
                title={path}
              ><span>{root ? relativePath(root, path) : path}</span><b className={coveragePercent(file.blocks) >= 60 ? 'good' : 'low'}>{coveragePercent(file.blocks)}%</b></button>)}
            </div>}
            {testPackages.length ? testPackages.map(([packageName, results]) => {
              const packageStatus = results.find((result) => result.name === '(package)')?.status ?? (results.some((result) => result.status === 'fail') ? 'fail' : results.every((result) => result.status === 'pass') ? 'pass' : 'run')
              const tree = buildTestTree(results)
              return <div key={packageName}>
                <div className={`test-tree-row package ${packageStatus === 'fail' ? 'failed' : packageStatus === 'pass' ? 'passed' : ''}`} title={packageName}><ChevronDown size={13} />{packageStatus === 'fail' ? <X size={14} /> : packageStatus === 'pass' ? <Check size={14} /> : <Play size={13} />}<span>{packageName.split('/').at(-1) || packageName}</span><button type="button" className="test-rerun" title={`重跑 ${packageName}`} disabled={!packageDirectory(packageName) || !!runningTask} onClick={() => { const directory = packageDirectory(packageName); if (directory) runSelection('test', { scope: 'package', targetPath: directory, label: `测试 ${packageName}` }) }}><Play size={12} /></button></div>
                <TestTreeNodes
                  nodes={tree} packageName={packageName} depth={1} runningTask={runningTask}
                  jumpToTest={jumpToTest} rerunTest={rerunTest}
                  onSelectCase={(pkg, fullName) => setSelectedCase({ packageName: pkg, fullName })}
                />
              </div>
            }) : <div className="panel-empty">{t('运行测试后，这里会显示测试树与结果。')}</div>}
          </div>
          <div className="test-console">
            <div className="test-console-title">
              {t('Console')}
              {selectedCase && <button type="button" className="test-case-clear" onClick={() => setSelectedCase(null)}>{selectedCase.fullName} ✕</button>}
            </div>
            {(() => {
              const lines = selectedCase ? testOutputByCase.get(`${selectedCase.packageName}::${selectedCase.fullName}`) : null
              return lines?.length ? lines.map((line) => <div className={`output-line ${line.stream}`} key={line.id}><OutputText line={line} root={root} projectFiles={projectFiles} navigateTo={navigateTo} /></div>)
                : selectedCase ? <div className="panel-empty">{t('该用例没有输出。')}</div>
                  : testOutput.length ? testOutput.map((line) => <div className={`output-line ${line.stream}`} key={line.id}><OutputText line={line} root={root} projectFiles={projectFiles} navigateTo={navigateTo} /></div>)
                    : <div className="panel-empty">{t('测试输出将显示在这里。')}</div>
            })()}
          </div>
        </div>
      </div>
      <div className={`panel-page problems-page ${panelView === 'problems' ? 'visible' : ''}`}>{diagnostics.length ? diagnostics.map((item, index) => <button className="problem-row" type="button" key={`${item.path}-${item.line}-${index}`} onClick={() => void navigateTo({ path: item.path, line: item.line, column: item.column })}><AlertCircle size={15} className={item.severity} /><span className="problem-message">{item.message}</span><span className="problem-location">{root ? relativePath(root, item.path) : item.path}:{item.line}</span></button>) : <div className="panel-empty"><Check size={17} />{t('当前没有诊断问题')}</div>}</div>
      <div className={`panel-page git-diff-page ${panelView === 'diff' ? 'visible' : ''}`}>{gitDiff ? <><div className="git-diff-heading"><strong>{gitDiff.path}</strong><span>{gitDiff.staged ? t('已暂存') : t('工作区更改')}</span><button type="button" onClick={() => void openFile(joinPath(root!, gitDiff.path))}>{t('打开文件')}</button></div><UnifiedDiffView diff={gitDiff.content} path={gitDiff.path} emptyMessage={t('没有可显示的文本差异。')} ariaLabel={t('提交差异')} /></> : null}</div>
      <div className={`panel-page git-history-page ${panelView === 'history' ? 'visible' : ''}`}>{gitFileHistory ? <>
        <div className="git-history-column">
          <div className="git-history-heading" title={gitFileHistory.path}><History size={14} /><span>{gitFileHistory.path}</span></div>
          <div className="file-history-sources" role="tablist" aria-label={t('文件历史')}>
            <button type="button" role="tab" aria-selected={fileHistorySource === 'local'} className={fileHistorySource === 'local' ? 'selected' : ''} title={t('本次会话的修改记录')} onClick={() => setFileHistorySource('local')}>{t('本地修改')}<small>{localHistoryEntries.length}</small></button>
            <button type="button" role="tab" aria-selected={fileHistorySource === 'git'} className={fileHistorySource === 'git' ? 'selected' : ''} onClick={() => setFileHistorySource('git')}>{t('Git 提交')}{!gitFileHistory.loading && !gitFileHistory.error && <small>{gitFileHistory.entries.length}</small>}</button>
          </div>
          {fileHistorySource === 'local' ? <div className="git-history-list" role="tabpanel">
            {localHistoryEntries.length ? localHistoryEntries.map((entry) => <button className={`git-history-entry local-history-entry ${selectedLocalHistoryEntry?.id === entry.id ? 'selected' : ''}`} type="button" key={entry.id} aria-pressed={selectedLocalHistoryEntry?.id === entry.id} onClick={() => setSelectedLocalHistoryId(entry.id)}>
              <span className="git-history-subject">{t(LOCAL_HISTORY_LABELS[entry.kind])}{entry.line ? ` · ${t('第 {line} 行', { line: entry.line })}` : ''}</span>
              <span className="git-history-meta"><span>{t('本次会话的修改记录')}</span><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>
            </button>) : <div className="git-history-message">{t('最近没有本地修改')}</div>}
          </div> : <div className="git-history-list" role="tabpanel">
            {gitFileHistory.loading ? <div className="git-history-message">{t('加载文件历史…')}</div> : gitFileHistory.error ? <div className="git-history-message error" role="alert">{gitFileHistory.error}</div> : gitFileHistory.entries.length ? gitFileHistory.entries.map((entry) => <button className={`git-history-entry ${gitFileHistory.selectedHash === entry.hash ? 'selected' : ''}`} type="button" key={entry.hash} aria-pressed={gitFileHistory.selectedHash === entry.hash} title={`${entry.hash} · ${entry.author} · ${entry.date}`} onClick={() => void openGitFileCommitDiff(entry)}><span className="git-history-subject">{entry.subject}</span><span className="git-history-meta"><strong>{entry.shortHash}</strong><span>{entry.author}</span><time dateTime={entry.date}>{entry.date.slice(0, 10)}</time></span></button>) : <div className="git-history-message">{t('没有提交历史')}</div>}
          </div>}
        </div>
        <div className="git-history-diff">
          {fileHistorySource === 'local' ? <>
            {selectedLocalHistoryEntry && <div className="git-diff-heading"><strong>{t(LOCAL_HISTORY_LABELS[selectedLocalHistoryEntry.kind])}</strong><span>{new Date(selectedLocalHistoryEntry.at).toLocaleString(locale)}</span><span>{t('编辑差异')}</span></div>}
            {selectedLocalHistoryEntry ? <UnifiedDiffView diff={selectedLocalDiff} path={gitFileHistory.path} emptyMessage={t('没有可显示的文本差异。')} ariaLabel={t('编辑差异')} /> : <div className="git-history-message">{t('选择修改以查看差异')}</div>}
          </> : <>
            {selectedHistoryEntry && <div className="git-diff-heading"><strong>{selectedHistoryEntry.subject}</strong><span>{selectedHistoryEntry.shortHash}</span><span>{t('提交差异')}</span></div>}
            {gitFileHistory.diffLoading ? <div className="git-history-message">{t('加载提交差异…')}</div> : gitFileHistory.diffError ? <div className="git-history-message error" role="alert">{gitFileHistory.diffError}</div> : gitFileHistory.diff !== null ? <UnifiedDiffView diff={gitFileHistory.diff} path={gitFileHistory.path} emptyMessage={t('没有可显示的文本差异。')} ariaLabel={t('提交差异')} /> : <div className="git-history-message">{t('选择提交以查看差异')}</div>}
          </>}
        </div>
      </> : null}</div>
    </div>
  </section>
}
