import { useState } from 'react'
import {
  ArrowUpFromLine, Bug, ChevronDown, ChevronRight, CircleDot, CornerDownRight, Eye, Play, Plus,
  Square, StepForward, X,
} from 'lucide-react'
import { iconButton } from '../helpers'
import type { Locale, MessageKey } from '../../lib/i18n'
import type { DapThread } from '../../lib/debug/dapClient'
import type { DebugConsoleLine, DebuggerFrame, DebuggerState, DebuggerVariable, WatchEntry } from '../hooks/useDebugger'

export interface DebugPaneProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  debugState: DebuggerState
  frames: DebuggerFrame[]
  selectedFrameIndex: number
  selectFrame: (index: number) => void
  variables: DebuggerVariable[]
  expandVariable: (groupIndex: number, path: number[]) => Promise<void>
  consoleLines: DebugConsoleLine[]
  control: (command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'disconnect', threadId?: number) => Promise<void>
  currentThreadId: number | null
  /** Goroutine/thread list shown while stopped; clicking one switches context. */
  threads: DapThread[]
  selectThread: (threadId: number) => Promise<void>
  watches: WatchEntry[]
  addWatch: (expression: string) => void
  removeWatch: (id: number) => void
  evaluateRepl: (expression: string) => Promise<void>
  /** Null when Delve is not installed; the pane offers a one-click install. */
  dlvInstalled: boolean
  installDlv: () => void
  startDebug: () => void
}

function VariableNode(props: {
  variable: DebuggerVariable
  groupIndex: number
  path: number[]
  depth: number
  expand: (groupIndex: number, path: number[]) => Promise<void>
}) {
  const { variable, groupIndex, path, depth, expand } = props
  const expandable = variable.variablesReference > 0
  const open = variable.expanded === true
  return <div className="debug-variable" style={{ paddingLeft: depth * 12 }}>
    <button className="debug-variable-row" type="button" disabled={!expandable} onClick={() => { if (expandable) void expand(groupIndex, path) }}>
      {expandable ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="debug-variable-dot" />}
      <span className="debug-variable-name">{variable.name}</span>
      <span className="debug-variable-value" title={variable.value}>{variable.value}</span>
    </button>
    {open && (variable.children ?? []).map((child, index) => (
      <VariableNode key={`${child.name}-${index}`} variable={child} groupIndex={groupIndex} path={[...path, index]} depth={depth + 1} expand={expand} />
    ))}
  </div>
}

/** Debugger tool window: controls, goroutines, call stack, watches, variables, and console. */
export function DebugPane(props: DebugPaneProps) {
  const {
    t, debugState, frames, selectedFrameIndex, selectFrame, variables, expandVariable, consoleLines,
    control, currentThreadId, threads, selectThread, watches, addWatch, removeWatch, evaluateRepl,
    dlvInstalled, installDlv, startDebug,
  } = props
  const [watchDraft, setWatchDraft] = useState('')
  const [replDraft, setReplDraft] = useState('')
  const idle = debugState === 'idle'
  const running = debugState === 'running'
  const stopped = debugState === 'stopped'
  const submitWatch = () => { addWatch(watchDraft); setWatchDraft('') }
  const submitRepl = () => { if (!replDraft.trim()) return; void evaluateRepl(replDraft); setReplDraft('') }
  return <div className="debug-pane">
    <div className="debug-toolbar">
      <span className={`debug-state ${debugState}`}>
        <Bug size={13} />
        {idle ? t('未在调试')
          : debugState === 'starting' ? t('启动调试中…')
            : running ? t('运行中')
              : stopped ? t('已暂停')
                : t('停止中…')}
      </span>
      <div className="debug-controls">
        {iconButton(t('继续'), Play, () => void control('continue', currentThreadId ?? undefined), !stopped)}
        {iconButton(t('单步跳过'), StepForward, () => void control('next', currentThreadId ?? undefined), !stopped)}
        {iconButton(t('单步进入'), CornerDownRight, () => void control('stepIn', currentThreadId ?? undefined), !stopped)}
        {iconButton(t('单步跳出'), ArrowUpFromLine, () => void control('stepOut', currentThreadId ?? undefined), !stopped)}
        {iconButton(t('暂停'), CircleDot, () => void control('pause', currentThreadId ?? undefined), !running)}
        {iconButton(t('停止调试'), Square, () => void control('disconnect'), idle)}
      </div>
    </div>
    {idle && !dlvInstalled && <div className="debug-install-hint" role="status">
      <span>{t('未检测到 Delve (dlv)。安装后即可使用断点调试。')}</span>
      <button type="button" onClick={installDlv}>{t('安装 Delve')}</button>
    </div>}
    {idle && dlvInstalled && !frames.length && <div className="debug-install-hint" role="status">
      <span>{t('在行号左侧点击设置断点，然后按 ⌃D 或点击调试按钮启动。')}</span>
      <button type="button" onClick={startDebug}>{t('调试当前上下文')}</button>
    </div>}
    <div className={`debug-columns${threads.length > 1 ? ' has-goroutines' : ''}`}>
      {threads.length > 1 && <div className="debug-goroutines">
        <div className="debug-column-title">{t('Goroutines')}</div>
        {threads.map((thread) => <button
          className={`debug-frame ${thread.id === currentThreadId ? 'selected' : ''}`}
          type="button"
          key={thread.id}
          onClick={() => void selectThread(thread.id)}
          title={thread.name}
        >
          <strong>{thread.name || `goroutine ${thread.id}`}</strong>
        </button>)}
      </div>}
      <div className="debug-stack">
        <div className="debug-column-title">{t('调用栈')}</div>
        {frames.length ? frames.map((frame, index) => <button
          className={`debug-frame ${index === selectedFrameIndex ? 'selected' : ''}`}
          type="button"
          key={`${frame.id}-${index}`}
          onClick={() => selectFrame(index)}
          title={frame.source?.path ?? frame.name}
        >
          <strong>{frame.name}</strong>
          <small>{frame.source?.name ?? ''}:{frame.line}</small>
        </button>) : <div className="debug-empty">{t('暂停时显示调用栈。')}</div>}
      </div>
      <div className="debug-variables">
        <div className="debug-column-title">{t('变量')}</div>
        {variables.length ? variables.map((group, groupIndex) => <div className="debug-scope" key={group.name}>
          <div className="debug-scope-name">{group.name}</div>
          {(group.children ?? []).map((child, index) => (
            <VariableNode key={`${child.name}-${index}`} variable={child} groupIndex={groupIndex} path={[index]} depth={1} expand={expandVariable} />
          ))}
        </div>) : <div className="debug-empty">{t('暂停时显示变量。')}</div>}
        <div className="debug-watches">
          <div className="debug-column-title">{t('监视')}</div>
          {watches.map((entry) => <div className={`debug-watch-row ${entry.failed ? 'failed' : ''}`} key={entry.id}>
            <Eye size={12} />
            <span className="debug-variable-name">{entry.expression}</span>
            <span className="debug-variable-value" title={entry.value}>{entry.value}</span>
            <button type="button" title={t('移除监视')} aria-label={t('移除监视')} onClick={() => removeWatch(entry.id)}><X size={11} /></button>
          </div>)}
          <div className="debug-watch-input">
            <input
              value={watchDraft}
              placeholder={t('输入表达式，回车添加监视…')}
              aria-label={t('监视表达式')}
              onChange={(event) => setWatchDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitWatch() }}
            />
            <button type="button" title={t('添加监视')} aria-label={t('添加监视')} disabled={!watchDraft.trim()} onClick={submitWatch}><Plus size={12} /></button>
          </div>
        </div>
      </div>
      <div className="debug-console">
        <div className="debug-column-title">{t('调试控制台')}</div>
        {consoleLines.length ? consoleLines.map((line) => <div className={`debug-console-line ${line.category}`} key={line.id}>{line.text}</div>) : <div className="debug-empty">{t('Delve 输出将显示在这里。')}</div>}
        {stopped && <form className="debug-repl" onSubmit={(event) => { event.preventDefault(); submitRepl() }}>
          <input
            value={replDraft}
            placeholder={t('表达式求值，如 x + 1 或 len(items)…')}
            aria-label={t('调试控制台求值')}
            onChange={(event) => setReplDraft(event.target.value)}
          />
          <button type="submit" title={t('求值')} aria-label={t('求值')} disabled={!replDraft.trim()}><Play size={12} /></button>
        </form>}
      </div>
    </div>
  </div>
}
