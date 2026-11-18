import { useState } from 'react'
import {
  Activity, AppWindow, Braces, Bug, Check, ChevronDown, Code2, Download, FlaskConical, FolderOpen,
  FolderPlus, GitBranch, GitMerge, Hammer, MoreHorizontal, Package, Play, Save, Search, Settings2,
  ShieldAlert, Square, Wrench,
} from 'lucide-react'
import { command, displayName } from '../../lib/api'
import { Dropdown } from './Dropdown'
import { iconButton } from '../helpers'
import type { DebuggerState } from '../hooks/useDebugger'
import type { RunConfiguration } from '../../lib/preferences'
import type { LspState, OpenFile, TaskOptions } from '../types'
import type { MessageKey, Locale } from '../../lib/i18n'

export interface TitleBarProps {
  locale: Locale
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  isMac: boolean
  root: string | null
  projectMenuOpen: boolean
  setProjectMenuOpen: (value: boolean | ((current: boolean) => boolean)) => void
  openEmptyWindow: () => Promise<void>
  openNewProject: () => Promise<void>
  chooseWorkspace: () => Promise<void>
  git: { branch: string } | null
  gitError: string | null
  gitBranches: { name: string; current: boolean }[]
  branchBusy: boolean
  branchMenu: boolean
  setBranchMenu: (value: boolean | ((current: boolean) => boolean)) => void
  changeBranch: (name: string, create?: boolean) => Promise<void>
  newBranchName: string
  setNewBranchName: (value: string) => void
  refreshGit: (workspace: string, options?: { refreshIgnored?: boolean }) => Promise<void>
  /** Merge one local branch into the current branch. */
  gitMerge: (name: string) => Promise<void>
  runConfig: 'run' | 'test' | 'build'
  setRunConfig: (value: 'run' | 'test' | 'build') => void
  runOptions: TaskOptions
  setRunOptions: (value: TaskOptions) => void
  configMenu: boolean
  setConfigMenu: (value: boolean | ((current: boolean) => boolean)) => void
  moduleMenu: boolean
  setModuleMenu: (value: boolean | ((current: boolean) => boolean)) => void
  activeFile: OpenFile | null
  activeTestDeclarations: { startLine: number; endLine: number }[]
  cursor: { line: number; column: number }
  runEditorContext: (line?: number, fileFallback?: boolean) => boolean
  runningTask: string | null
  runTask: (task: string, options?: TaskOptions) => void | Promise<unknown>
  activePath: string | null
  saveFile: (path: string) => Promise<boolean>
  formatOnSave: boolean
  lspState: LspState
  openPalette: () => void
  setSettingsSection: (value: 'editor' | 'plugins') => void
  setSettingsOpen: (value: boolean) => void
  setLocale: (value: Locale) => void
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  /** Saved run configurations and the debugger entry points. */
  savedRunConfigurations: RunConfiguration[]
  onSelectRunConfiguration: (id: string) => void
  onEditRunConfigurations: () => void
  debugState: DebuggerState
  debugCurrentContext: () => void
  debugStop: () => void
  runWithCoverage: () => void
  recentProjects: string[]
  openRecentProject: (path: string) => Promise<void>
  /** Adds a dependency via `go get <module>`. */
  onGoGet: (module: string) => void
  onVulncheck: () => void
}

export function TitleBar(props: TitleBarProps) {
  const {
    locale, t, root, projectMenuOpen, setProjectMenuOpen, openEmptyWindow, openNewProject, chooseWorkspace,
    git, gitError, gitBranches, branchBusy, branchMenu, setBranchMenu, changeBranch, newBranchName, setNewBranchName, refreshGit, gitMerge,
    runConfig, setRunConfig, runOptions, setRunOptions, configMenu, setConfigMenu, moduleMenu, setModuleMenu,
    activeFile, activeTestDeclarations, cursor, runEditorContext, runningTask, runTask, activePath, saveFile,
    formatOnSave, lspState, openPalette, setSettingsSection, setSettingsOpen, setLocale, notify, formatError,
    savedRunConfigurations, onSelectRunConfiguration, onEditRunConfigurations,
    debugState, debugCurrentContext, debugStop, runWithCoverage, recentProjects, openRecentProject, onGoGet, onVulncheck,
  } = props
  const [goGetModule, setGoGetModule] = useState('')
  return <header className="titlebar" data-tauri-drag-region>
    <div className="title-left" data-tauri-drag-region>
      <span className="traffic-lights" aria-hidden="true"><i /><i /><i /></span>
      <div className="project-menu-anchor"><button className="project-widget" type="button" title={locale === 'zh-CN' ? '项目操作' : 'Project actions'} aria-expanded={projectMenuOpen} onClick={(event) => { event.stopPropagation(); setProjectMenuOpen((current) => !current) }}>
        <span className="brand-mark">Go</span><span className="project-name">{root ? displayName(root) : 'GoMavo'}</span><ChevronDown size={13} />
      </button>{projectMenuOpen && <div className="menu-popover project-menu" onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => void openEmptyWindow()}><AppWindow size={14} />{t('新建窗口')}</button><div className="menu-divider" role="separator" /><button type="button" onClick={() => void openNewProject()}><FolderPlus size={14} />{locale === 'zh-CN' ? '新建项目…' : 'New Project…'}</button><button type="button" onClick={() => void chooseWorkspace()}><FolderOpen size={14} />{locale === 'zh-CN' ? '打开项目…' : 'Open Project…'}</button>{recentProjects.length > 0 && <>
        <div className="menu-divider" role="separator" />
        <div className="menu-title">{t('最近项目')}</div>
        {recentProjects.slice(0, 6).map((path) => <button type="button" key={path} title={path} onClick={() => void openRecentProject(path)}><FolderOpen size={14} />{displayName(path)}</button>)}
      </>}</div>}</div>
      <div className="branch-menu-anchor"><button className="vcs-widget" type="button" title={t('切换 Git 分支')} disabled={!root || !!gitError} onClick={(event) => { event.stopPropagation(); if (root) void refreshGit(root, { refreshIgnored: true }); setBranchMenu((current) => !current) }}><GitBranch size={16} /><span>{git?.branch || 'Git'}</span><ChevronDown size={12} /></button>
        {branchMenu && <div className="menu-popover branch-menu" onClick={(event) => event.stopPropagation()}><div className="menu-title">{t('Git 分支')}</div><div className="branch-list">{gitBranches.map((branch) => <div key={branch.name} className={`branch-row ${branch.current ? 'current' : ''}`}>
          <button type="button" className="branch-switch" disabled={branch.current || branchBusy} onClick={() => void changeBranch(branch.name)}>{branch.current ? <Check size={14} /> : <GitBranch size={14} />}<span>{branch.name}</span></button>
          {!branch.current && <button type="button" className="branch-merge" title={t('合并到当前分支')} aria-label={t('合并到当前分支')} disabled={branchBusy} onClick={() => void gitMerge(branch.name)}><GitMerge size={13} /></button>}
        </div>)}</div><div className="menu-divider" /><form className="branch-create" onSubmit={(event) => { event.preventDefault(); if (newBranchName.trim()) void changeBranch(newBranchName.trim(), true) }}><label htmlFor="new-branch-name">{t('新建并切换分支')}</label><div><input id="new-branch-name" value={newBranchName} onChange={(event) => setNewBranchName(event.target.value)} placeholder="feature/name" /><button type="submit" disabled={!newBranchName.trim() || branchBusy}>{t('创建')}</button></div></form></div>}
      </div>
    </div>
    <div className="title-drag-region" data-tauri-drag-region aria-hidden="true" />
    <div className="run-widget">
      <div className="run-config-anchor"><button className="run-configuration" type="button" disabled={!root} onClick={(event) => { event.stopPropagation(); setConfigMenu((current) => !current) }}><span className="run-config-icon"><Braces size={14} /></span><span>{runOptions.label ?? (runConfig === 'run' ? 'go run .' : runConfig === 'test' ? 'go test ./...' : 'go build ./...')}</span><ChevronDown size={12} /></button>
        {configMenu && <div className="menu-popover config-menu" onClick={(event) => event.stopPropagation()}>
          {savedRunConfigurations.length > 0 && <>
            <div className="menu-title">{t('已保存的配置')}</div>
            {savedRunConfigurations.map((config) => <button type="button" key={config.id} onClick={() => { onSelectRunConfiguration(config.id); setConfigMenu(false) }}><Play size={14} /><span>{config.name}</span><small>{config.kind === 'test' ? 'go test' : config.kind === 'build' ? 'go build' : 'go run'}{config.race ? ' · -race' : ''}</small></button>)}
            <div className="menu-divider" />
          </>}
          <button type="button" onClick={() => { setRunConfig('run'); setRunOptions({}); setConfigMenu(false) }}><Play size={14} /><span>{t('运行项目根包')}</span><small>go run .</small></button>
          {activeFile?.path.endsWith('.go') && <button type="button" onClick={() => { setRunConfig('run'); setRunOptions({ scope: 'file', targetPath: activeFile.path, label: `go run ${displayName(activeFile.path)}` }); setConfigMenu(false) }}><Play size={14} /><span>{t('运行当前 Go 包')}</span><small>{displayName(activeFile.path)}</small></button>}
          <div className="menu-divider" />
          <button type="button" onClick={() => { setRunConfig('test'); setRunOptions({ scope: 'workspace' }); setConfigMenu(false) }}><FlaskConical size={14} /><span>{t('运行全部测试')}</span><small>go test ./...</small></button>
          <button type="button" onClick={() => { runWithCoverage(); setConfigMenu(false) }}><FlaskConical size={14} /><span>{t('带覆盖率运行测试')}</span><small>-cover</small></button>
          {activeFile?.path.endsWith('_test.go') && activeTestDeclarations.some((item) => item.startLine <= cursor.line && cursor.line <= item.endLine) && <button type="button" onClick={() => { runEditorContext(); setConfigMenu(false) }}><FlaskConical size={14} /><span>{t('运行光标处测试方法')}</span><small>⌃R</small></button>}
          {activeFile?.path.endsWith('_test.go') && <button type="button" onClick={() => { setRunConfig('test'); setRunOptions({ scope: 'file', targetPath: activeFile.path, label: `go test ${displayName(activeFile.path)}` }); setConfigMenu(false) }}><FlaskConical size={14} /><span>{t('运行当前文件测试')}</span><small>{displayName(activeFile.path)}</small></button>}
          {activeFile?.path.endsWith('.go') && <button type="button" onClick={() => { setRunConfig('test'); setRunOptions({ scope: 'package', targetPath: activeFile.path.slice(0, -displayName(activeFile.path).length - 1), label: `go test ${displayName(activeFile.path)}` }); setConfigMenu(false) }}><FlaskConical size={14} /><span>{t('测试当前包')}</span><small>{displayName(activeFile.path)}</small></button>}
          <div className="menu-divider" />
          <button type="button" onClick={() => { setRunConfig('build'); setRunOptions({}); setConfigMenu(false) }}><Hammer size={14} /><span>{t('编译全部包')}</span><small>go build ./...</small></button>
          <div className="menu-divider" />
          <button type="button" onClick={() => { onEditRunConfigurations(); setConfigMenu(false) }}><Settings2 size={14} /><span>{t('编辑运行配置…')}</span></button>
        </div>}
      </div>
      <button className="run-play" type="button" title={t('运行当前配置')} aria-label={t('运行当前配置')} disabled={!root || !!runningTask} onClick={() => void runTask(runConfig, runOptions)}><Play size={19} strokeWidth={2} /></button>
      {debugState === 'idle'
        ? <button className="run-debug" type="button" title={t('调试当前上下文')} aria-label={t('调试当前上下文')} disabled={!root} onClick={debugCurrentContext}><Bug size={17} /></button>
        : <button className="run-stop" type="button" title={t('停止调试')} aria-label={t('停止调试')} onClick={debugStop}><Square size={16} fill="currentColor" /></button>}
      {runningTask ? <button className="run-stop" type="button" title={t('停止任务')} aria-label={t('停止任务')} onClick={() => void command('task_cancel', { id: runningTask }).catch((cause) => notify(formatError(cause), 'error'))}><Square size={16} fill="currentColor" /></button> : null}
      <div className="module-menu-anchor"><button className="run-more" type="button" title={t('更多 Go 操作')} aria-label={t('更多 Go 操作')} disabled={!root} onClick={(event) => { event.stopPropagation(); setModuleMenu((current) => !current) }}><MoreHorizontal size={18} /></button>
        {moduleMenu && <div className="menu-popover module-menu" onClick={(event) => event.stopPropagation()}><div className="menu-title">{t('Go 工具')}</div><button type="button" onClick={() => void runTask('mod_tidy')}><Wrench size={14} /><span>{t('整理依赖')}</span><small>go mod tidy</small></button><button type="button" onClick={() => void runTask('mod_download')}><Download size={14} /><span>{t('下载依赖')}</span><small>go mod download</small></button><form className="menu-inline-form" onSubmit={(event) => { event.preventDefault(); if (goGetModule.trim()) { onGoGet(goGetModule.trim()); setGoGetModule(''); setModuleMenu(false) } }}><Download size={14} /><input value={goGetModule} onChange={(event) => setGoGetModule(event.target.value)} placeholder={t('go get 模块路径…')} aria-label={t('go get 模块路径…')} /><button type="submit" disabled={!goGetModule.trim() || !!runningTask}>{t('添加')}</button></form><div className="menu-divider" /><button type="button" onClick={() => { onVulncheck(); setModuleMenu(false) }}><ShieldAlert size={14} /><span>{t('依赖漏洞检查')}</span><small>govulncheck ./...</small></button><div className="menu-divider" /><button type="button" onClick={() => void runTask('fmt')}><Code2 size={14} /><span>{t('格式化代码')}</span><small>go fmt ./...</small></button><button type="button" onClick={() => void runTask('vet')}><Activity size={14} /><span>{t('静态检查')}</span><small>go vet ./...</small></button></div>}
      </div>
    </div>
    <div className="title-actions" data-tauri-drag-region>
      {iconButton(t('测试项目'), FlaskConical, () => void runTask('test'), !root || !!runningTask)}
      {iconButton(t('编译项目'), Hammer, () => void runTask('build'), !root || !!runningTask)}
      {iconButton(t('保存文件'), Save, () => { if (activePath) void saveFile(activePath) }, !activeFile || (activeFile.content === activeFile.savedContent && !(formatOnSave && activeFile.path.endsWith('.go') && lspState === 'ready')))}
      {iconButton(t('随处搜索'), Search, () => openPalette())}
      {iconButton(t('插件'), Package, () => { setSettingsSection('plugins'); setSettingsOpen(true) })}
      {iconButton(t('设置'), Settings2, () => { setSettingsSection('editor'); setSettingsOpen(true) })}
      <Dropdown className="language-select" ariaLabel={t('界面语言')} value={locale} options={[{ value: 'zh-CN', label: '中文' }, { value: 'en-US', label: 'English' }]} onChange={(next) => {
        // Let the popover close before changing every localized view in the app.
        window.setTimeout(() => setLocale(next as Locale), 0)
      }} />
    </div>
  </header>
}
