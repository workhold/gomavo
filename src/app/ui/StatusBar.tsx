import { useState, Fragment } from 'react'
import { AlertCircle, Check, ChevronRight, RefreshCw } from 'lucide-react'
import { displayName, fileLanguage, joinPath, relativePath } from '../../lib/api'
import { displayedLineEnding, isWorkspaceFile } from '../helpers'
import type { LspState, OpenFile } from '../types'
import type { MessageKey } from '../../lib/i18n'
import type { ToolVersions } from '../../lib/api'
import type { PanelView } from '../types'

export interface StatusBarProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  root: string | null
  activeFile: OpenFile | null
  dirtyCount: number
  problemCount: number
  lspState: LspState
  lspError: string | null
  /** Tail of gopls stderr, so failures show their real cause. */
  goplsLog: string[]
  formatError: (cause: unknown) => string
  runningTask: string | null
  runTask: (task: string) => void | Promise<unknown>
  setLspEpoch: (value: (current: number) => number) => void
  cursor: { line: number; column: number }
  versions: ToolVersions | null
  setPanelView: (value: PanelView) => void
  setPanelOpen: (value: boolean | ((current: boolean) => boolean)) => void
  /** Symbol enclosing the cursor; rendered as the last clickable crumb. */
  activeSymbol: { name: string; line: number } | null
  /** Reveals a workspace path in the project tree. */
  revealTreePath: (path: string) => void
  jumpToLine: (line: number) => void
}

export function StatusBar(props: StatusBarProps) {
  const { t, root, activeFile, dirtyCount, problemCount, lspState, lspError, goplsLog, formatError, runningTask, runTask, setLspEpoch, cursor, versions, setPanelView, setPanelOpen, activeSymbol, revealTreePath, jumpToLine } = props
  const [lspPopoverOpen, setLspPopoverOpen] = useState(false)
  const errorDetail = lspError ? formatError(lspError) : ''
  const tooltip = errorDetail || (goplsLog.length ? goplsLog[goplsLog.length - 1] : '')
  // Clickable crumbs: root → each directory → file → enclosing symbol.
  const relative = root && activeFile && isWorkspaceFile(root, activeFile.path) ? relativePath(root, activeFile.path) : null
  const segments = relative ? relative.split('/') : []
  return <footer className="statusbar">
    <div className="status-left status-breadcrumbs">
      {root && <button type="button" className="status-crumb" title={root} onClick={() => revealTreePath(root)}>{displayName(root)}</button>}
      {segments.map((segment, index) => {
        const path = segments.slice(0, index + 1).reduce((parent, part) => joinPath(parent, part), root!)
        return <Fragment key={`seg${index}`}>
          <ChevronRight size={12} />
          <button type="button" className={`status-crumb ${index === segments.length - 1 ? 'file' : ''}`} title={path} onClick={() => revealTreePath(path)}>{segment}</button>
        </Fragment>
      })}
      {activeSymbol && activeFile && <>
        <ChevronRight size={12} />
        <button type="button" className="status-crumb symbol" title={`${activeSymbol.name}:${activeSymbol.line}`} onClick={() => jumpToLine(activeSymbol.line)}>{activeSymbol.name}</button>
      </>}
      {dirtyCount > 0 && <span className="status-unsaved">● {t('{count} 未保存', { count: dirtyCount })}</span>}
    </div>
    <div className="status-right">
      {problemCount ? <button type="button" onClick={() => { setPanelView('problems'); setPanelOpen(true) }}><AlertCircle size={13} />{problemCount}</button> : <span className="status-good"><Check size={13} /></span>}
      <span className={`lsp-status ${lspState}`} title={tooltip}>
        <button type="button" className="lsp-status-button" onClick={() => setLspPopoverOpen((value) => !value)}>
          <span className="lsp-dot" />{lspState === 'ready' ? 'gopls' : lspState === 'starting' ? t('gopls 启动中') : lspState === 'missing' ? t('gopls 未安装') : lspState === 'error' ? t('gopls 错误') : 'gopls'}
        </button>
        {lspPopoverOpen && <div className="lsp-popover" onClick={(event) => event.stopPropagation()}>
          <div className="lsp-popover-title">
            <strong>gopls</strong>
            <span>{versions?.gopls ?? t('未安装')}</span>
            <button type="button" title={t('重启 gopls')} onClick={() => { setLspEpoch((value) => value + 1); setLspPopoverOpen(false) }}><RefreshCw size={12} /></button>
          </div>
          {lspError && <div className="lsp-popover-error" role="alert">{errorDetail}</div>}
          <div className="lsp-popover-log">{goplsLog.length
            ? goplsLog.map((line, index) => <div key={index}>{line}</div>)
            : <div className="lsp-popover-empty">{t('gopls 没有输出日志。')}</div>}</div>
          <div className="lsp-popover-actions">
            <button type="button" disabled={!!runningTask} onClick={() => { void runTask('install_gopls'); setLspPopoverOpen(false) }}>{versions?.gopls ? t('升级到最新版') : t('安装 gopls')}</button>
          </div>
        </div>}
      </span>
      {root && lspState === 'missing' && <button className="status-install" type="button" disabled={!!runningTask} onClick={() => void runTask('install_gopls')}>{t('安装')}</button>}
      {root && lspState === 'error' && <button className="status-install" type="button" onClick={() => setLspEpoch((value) => value + 1)}>{t('重启')}</button>}
      <span className="status-separator" /><span>{activeFile ? `${cursor.line}:${cursor.column}` : ''}</span><span>{activeFile?.binary ? 'HEX' : displayedLineEnding(activeFile)}</span><span>{activeFile?.binary ? 'BINARY' : 'UTF-8'}</span><span>{activeFile?.binary ? 'PLAIN TEXT' : activeFile ? fileLanguage(activeFile.path).toUpperCase() : 'Go'}</span><span>{versions?.go?.match(/go\d+\.\d+(?:\.\d+)?/)?.[0] ?? (versions?.go ? 'Go' : t('Go 未安装'))}</span>
    </div>
  </footer>
}
