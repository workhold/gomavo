import { useState, type ReactNode, type RefObject } from 'react'
import {
  Archive, ArrowDownToLine, ArrowUpFromLine, Book, Bookmark, Braces, Check, ChevronDown, ChevronRight, ChevronsDownUp,
  CloudDownload, FilePlus2, FolderOpen, FolderPlus, GitBranch, Library, LocateFixed, Package, RefreshCw, X,
} from 'lucide-react'
import { displayName, relativePath, type FileEntry, type GitLogEntry, type GitStashEntry, type GitStatus, type GoModInfo } from '../../lib/api'
import type { StructureSymbol } from '../../lib/lsp'
import { entryIcon, gitAppearance, iconButton, isWorkspaceFile, statusLabel } from '../helpers'
import type { ContextState, SideView } from '../types'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface SidebarProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  sideView: SideView
  root: string | null
  tree: Record<string, FileEntry[]>
  expanded: Set<string>
  setExpanded: (value: Set<string>) => void
  setRevealPath: (value: string | null) => void
  toggleFolder: (path: string) => void
  refreshDirectory: (path: string) => Promise<void>
  refreshProjectFiles: (workspace: string) => Promise<void>
  refreshGit: (workspace: string, options?: { refreshIgnored?: boolean }) => Promise<void>
  showHiddenFiles: boolean
  treeScrollRef: RefObject<HTMLDivElement | null>
  selectedTreePath: string | null
  setSelectedTreePath: (value: string | null) => void
  openingPath: string | null
  mutationBusyPath: string | null
  activePath: string | null
  openFile: (path: string) => Promise<boolean>
  chooseWorkspace: () => Promise<void>
  showDialog: (kind: 'go' | 'file' | 'module' | 'workspace' | 'folder' | 'rename', parent: string, target?: FileEntry, initialName?: string) => void
  showContextMenu: (entry: FileEntry, parent: string, trigger: HTMLButtonElement, x: number, y: number) => void
  showNewMenu: (parent: string, trigger: HTMLButtonElement) => void
  deleteEntry: (entry: FileEntry, parent: string) => Promise<void>
  revealCurrentFile: () => void
  context: ContextState | null
  setSidebarOpen: (value: boolean | ((current: boolean) => boolean)) => void
  git: GitStatus | null
  gitError: string | null
  formatError: (cause: unknown) => string
  gitLog: GitLogEntry[]
  setBranchMenu: (value: boolean | ((current: boolean) => boolean)) => void
  commitMessage: string
  setCommitMessage: (value: string) => void
  openGitDiff: (path: string, staged?: boolean) => Promise<void>
  updateGitIndex: (path: string, staged: boolean) => Promise<void>
  commitGit: () => Promise<void>
  /** Remote operations, stash, and merge state from the Git tool window. */
  remoteBusy: boolean
  gitFetch: () => Promise<void>
  gitPull: (rebase?: boolean) => Promise<void>
  gitPush: (setUpstream?: boolean) => Promise<void>
  mergeConflicts: string[]
  gitAbortMerge: () => Promise<void>
  openMergeResolver: (path: string) => void
  openGitGraph: () => Promise<void>
  stashEntries: GitStashEntry[]
  gitStashPush: () => Promise<void>
  gitStashPop: (index?: number) => Promise<void>
  gitStashDrop: (index?: number) => Promise<void>
  /** Recent workspaces for the empty project view. */
  recentProjects: string[]
  openRecentProject: (path: string) => Promise<void>
  /** go.mod dependencies and the Go SDK version, for the External Libraries node. */
  goMod: GoModInfo | null
  goSdkVersion: string | null
  /** Structure tool window: symbols of the active file. */
  structureSymbols: StructureSymbol[]
  structureLoading: boolean
  /** Bookmarks map for the Bookmarks tool window; removing one navigates the map. */
  bookmarks: Record<string, number[]>
  removeBookmark: (path: string, line: number) => void
  navigateTo: (target: { path: string; line: number; column: number }) => Promise<boolean>
}

export function Sidebar(props: SidebarProps) {
  const {
    t, locale, sideView, root, tree, expanded, setExpanded, setRevealPath, toggleFolder, refreshDirectory,
    refreshProjectFiles, refreshGit, showHiddenFiles, treeScrollRef, selectedTreePath, setSelectedTreePath,
    openingPath, mutationBusyPath, activePath, openFile, chooseWorkspace, showDialog, showContextMenu,
    showNewMenu, deleteEntry, revealCurrentFile, context, setSidebarOpen,
    git, gitError, formatError, gitLog, setBranchMenu,
    commitMessage, setCommitMessage, openGitDiff, updateGitIndex, commitGit,
    remoteBusy, gitFetch, gitPull, gitPush, mergeConflicts, gitAbortMerge, openMergeResolver,
    openGitGraph, stashEntries, gitStashPush, gitStashPop, gitStashDrop,
    recentProjects, openRecentProject, goMod, goSdkVersion,
    structureSymbols, structureLoading, bookmarks, removeBookmark, navigateTo,
  } = props

  const [librariesOpen, setLibrariesOpen] = useState(false)
  const [modulesOpen, setModulesOpen] = useState(false)

  const renderEntries = (directory: string, depth: number): ReactNode => {
    const entries = tree[directory]
    if (!entries) return expanded.has(directory) ? <div className="tree-loading" style={{ paddingLeft: 17 + depth * 14 }}>{t('读取中…')}</div> : null
    if (!entries.length && depth > 0) return <div className="tree-empty" style={{ paddingLeft: 24 + depth * 14 }}>{t('空文件夹')}</div>
    return entries.filter((entry) => showHiddenFiles || !entry.name.startsWith('.')).map((entry) => {
      const Icon = entry.is_dir && expanded.has(entry.path) ? FolderOpen : entryIcon(entry)
      const relative = root ? relativePath(root, entry.path) : entry.name
      const gitFile = git?.files.find((item) => item.path === relative)
      const folderChanged = entry.is_dir && git?.files.some((item) => item.path.startsWith(`${relative}/`))
      const gitClass = gitFile ? `git-${gitAppearance(gitFile.status)}` : ''
      return <div key={entry.path}>
        <button
          className={`tree-row ${selectedTreePath === entry.path ? 'active' : ''} ${openingPath === entry.path ? 'opening' : ''} ${context?.entry.path === entry.path ? 'context-target' : ''} ${entry.ignored ? 'git-ignored' : gitClass} ${entry.name.endsWith('_test.go') ? 'test-file' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          type="button"
          data-entry-path={entry.path}
          title={entry.ignored ? `${relative} · ${locale === 'zh-CN' ? 'Git 已忽略' : 'Ignored by Git'}` : gitFile ? `${relative} · Git ${gitFile.status}` : relative}
          aria-current={selectedTreePath === entry.path ? 'true' : undefined}
          aria-busy={openingPath === entry.path || mutationBusyPath === entry.path}
          aria-expanded={entry.is_dir ? expanded.has(entry.path) : undefined}
          aria-haspopup="menu"
          disabled={mutationBusyPath === entry.path}
          onClick={() => { setSelectedTreePath(entry.path); if (entry.is_dir) toggleFolder(entry.path); else void openFile(entry.path) }}
          onContextMenu={(event) => {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            showContextMenu(entry, directory, event.currentTarget, event.clientX || bounds.left + 24, event.clientY || bounds.top + 20)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              showContextMenu(entry, directory, event.currentTarget, bounds.left + 24, bounds.bottom)
            } else if (event.key === 'F2') {
              event.preventDefault()
              showDialog('rename', directory, entry)
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              void deleteEntry(entry, directory)
            }
          }}
        >
          {entry.is_dir ? (expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="tree-indent" />}
          <Icon size={15} className={`tree-file-icon ${entry.is_dir ? 'folder' : entry.name.endsWith('.go') ? 'go' : ''}`} strokeWidth={1.8} />
          <span className="tree-name">{entry.name}</span>
          {gitFile && <span className={`git-badge status-${statusLabel(gitFile.status)}`}>{statusLabel(gitFile.status)}</span>}
          {!gitFile && folderChanged && <span className="folder-change" />}
          {(openingPath === entry.path || mutationBusyPath === entry.path) && <span className="tree-open-progress" aria-hidden="true" />}
        </button>
        {entry.is_dir && expanded.has(entry.path) && renderEntries(entry.path, depth + 1)}
      </div>
    })
  }

  return <aside className="sidebar">
    {sideView === 'files' ? <>
      <div className="sidebar-heading project-heading"><button className="tool-window-title" type="button" onClick={() => { if (root) toggleFolder(root) }}><span>{t('Project')}</span><ChevronDown size={13} /></button><div className="sidebar-heading-actions"><button className="icon-button" type="button" title={locale === 'zh-CN' ? '新建…' : 'New…'} aria-label={locale === 'zh-CN' ? '新建…' : 'New…'} aria-haspopup="menu" aria-expanded={context?.mode === 'new'} disabled={!root} onClick={(event) => { event.stopPropagation(); if (root) showNewMenu(root, event.currentTarget) }}><FilePlus2 size={15} strokeWidth={1.8} /></button>{iconButton(t('新建文件夹'), FolderPlus, () => root && showDialog('folder', root), !root)}{iconButton(locale === 'zh-CN' ? '定位当前文件' : 'Select Opened File', LocateFixed, revealCurrentFile, !root || !activePath || !isWorkspaceFile(root, activePath))}{iconButton(locale === 'zh-CN' ? '全部收起' : 'Collapse All', ChevronsDownUp, () => { setRevealPath(null); setExpanded(new Set()) }, !root || expanded.size === 0)}{iconButton(t('刷新文件'), RefreshCw, () => { if (root) { for (const path of new Set([root, ...expanded])) void refreshDirectory(path); void refreshGit(root); void refreshProjectFiles(root) } }, !root)}{iconButton(t('关闭 Project'), X, () => setSidebarOpen(false))}</div></div>
      {root ? <div className="tree-scroll" ref={treeScrollRef}><button className={`tree-root ${selectedTreePath === root ? 'active' : ''} ${context?.entry.path === root ? 'context-target' : ''}`} type="button" aria-current={selectedTreePath === root ? 'true' : undefined} aria-expanded={expanded.has(root)} aria-haspopup="menu" aria-busy={mutationBusyPath === root} disabled={mutationBusyPath === root} onClick={() => { setSelectedTreePath(root); toggleFolder(root) }} onContextMenu={(event) => {
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        showContextMenu({ name: displayName(root), path: root, is_dir: true, ignored: false }, root, event.currentTarget, event.clientX || bounds.left + 24, event.clientY || bounds.top + 20)
      }} onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          showContextMenu({ name: displayName(root), path: root, is_dir: true, ignored: false }, root, event.currentTarget, bounds.left + 24, bounds.bottom)
        }
      }}>{expanded.has(root) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderOpen size={16} /><span>{displayName(root)}</span><small>{root}</small></button>{expanded.has(root) && renderEntries(root, 0)}{goMod && (goSdkVersion || goMod.requires.length > 0) && <div className="tree-libraries">
        <button className="tree-row tree-lib-root" type="button" aria-expanded={librariesOpen} onClick={() => setLibrariesOpen((open) => !open)} style={{ paddingLeft: 10 }}>
          {librariesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Library size={15} strokeWidth={1.8} className="tree-file-icon" />
          <span className="tree-name">{t('外部库')}</span>
        </button>
        {librariesOpen && <>
          {goMod.requires.length > 0 && <div>
            <button className="tree-row tree-lib-modules" type="button" aria-expanded={modulesOpen} onClick={() => setModulesOpen((open) => !open)} style={{ paddingLeft: 24 }}>
              {modulesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="tree-indent" />
              <Library size={15} strokeWidth={1.8} className="tree-file-icon" />
              <span className="tree-name">{'Go Modules <' + displayName(root) + '>'}</span>
            </button>
            {modulesOpen && goMod.requires.map((dep) => <div className="tree-row tree-library-row" key={`${dep.module}@${dep.version}`} style={{ paddingLeft: 38 }} title={`${dep.module} ${dep.version}`}>
              <span className="tree-indent" />
              <span className="tree-indent" />
              <Package size={15} strokeWidth={1.8} className="tree-file-icon" />
              <span className="tree-name">{dep.module}<span className="dep-version">{dep.version}</span></span>
            </div>)}
          </div>}
          {goSdkVersion && <div className="tree-row tree-library-row" style={{ paddingLeft: 24 }} title={`Go SDK ${goSdkVersion}`}>
            <span className="tree-indent" />
            <Book size={15} strokeWidth={1.8} className="tree-file-icon" />
            <span className="tree-name">Go SDK {goSdkVersion}</span>
          </div>}
        </>}
      </div>}</div> : <div className="sidebar-empty"><button className="sidebar-quick-action" type="button" onClick={() => void chooseWorkspace()}><FolderOpen size={17} />{t('Open...')}</button><div className="sidebar-divider" />{recentProjects.length > 0 ? <>
          <span className="recent-projects-title">{t('最近项目')}</span>
          <div className="recent-projects">
            {recentProjects.map((path) => <button key={path} type="button" className="recent-project" title={path} onClick={() => void openRecentProject(path)}>
              <FolderOpen size={14} />
              <span>{displayName(path)}</span>
              <small>{path}</small>
            </button>)}
          </div>
        </> : <span>{t('No recent projects')}</span>}</div>}
    </> : sideView === 'structure' ? <>
      <div className="sidebar-heading"><span className="tool-window-title">{t('结构')}</span><div className="sidebar-heading-actions">{iconButton(t('关闭结构'), X, () => setSidebarOpen(false))}</div></div>
      <div className="tree-scroll">
        {!activePath ? <div className="sidebar-empty"><Braces size={22} /><span>{t('打开文件以查看其结构。')}</span></div>
          : structureLoading ? <div className="tree-loading" style={{ paddingLeft: 17 }}>{t('读取中…')}</div>
            : !structureSymbols.length ? <div className="sidebar-empty"><Braces size={22} /><span>{t('该文件没有可显示的符号。')}</span></div>
              : structureSymbols.map((symbol, index) => <button
                className="tree-row structure-row"
                key={`${symbol.name}-${symbol.line}-${index}`}
                style={{ paddingLeft: 10 + symbol.depth * 14 }}
                type="button"
                title={`${symbol.name}${symbol.detail ? ` · ${symbol.detail}` : ''}`}
                onClick={() => { if (activePath) void navigateTo({ path: activePath, line: symbol.line, column: symbol.column }) }}
              >
                <span className="tree-indent" />
                <Braces size={14} strokeWidth={1.8} className={`tree-file-icon structure-kind-${symbol.kind}`} />
                <span className="tree-name">{symbol.name}</span>
                <small>{symbol.line}</small>
              </button>)}
      </div>
    </> : sideView === 'bookmarks' ? <>
      <div className="sidebar-heading"><span className="tool-window-title">{t('书签')}</span><div className="sidebar-heading-actions">{iconButton(t('关闭书签'), X, () => setSidebarOpen(false))}</div></div>
      <div className="tree-scroll">
        {Object.keys(bookmarks).length ? Object.entries(bookmarks).flatMap(([path, lines]) => lines.length ? [
          <div className="bookmarks-file" key={path}>
            <button className="tree-row bookmarks-file-row" type="button" title={path} onClick={() => void openFile(path)}>
              <span className="tree-indent" />
              <Bookmark size={14} strokeWidth={1.8} className="tree-file-icon" />
              <span className="tree-name">{displayName(path)}</span>
              <small>{root && isWorkspaceFile(root, path) ? relativePath(root, path) : ''}</small>
            </button>
            {lines.map((line) => <div className="tree-row bookmarks-line-row" key={`${path}:${line}`} style={{ paddingLeft: 24 }}>
              <span className="tree-indent" />
              <button className="bookmarks-line-button" type="button" title={`${path}:${line}`} onClick={() => void navigateTo({ path, line, column: 1 })}>
                <span className="tree-name">{t('第 {line} 行', { line })}</span>
              </button>
              <button className="bookmarks-remove" type="button" title={t('移除书签')} aria-label={t('移除书签')} onClick={() => removeBookmark(path, line)}><X size={11} /></button>
            </div>)}
          </div>,
        ] : []) : <div className="sidebar-empty"><Bookmark size={22} /><span>{t('还没有书签。按 F3 在当前行添加书签。')}</span></div>}
      </div>
    </> : <>
      <div className="sidebar-heading"><span className="tool-window-title">Git</span><div className="sidebar-heading-actions">{iconButton(t('刷新 Git 状态'), RefreshCw, () => { if (root) void refreshGit(root, { refreshIgnored: true }) }, !root)}{iconButton(t('关闭 Git'), X, () => setSidebarOpen(false))}</div></div>
      <div className="git-sidebar">{!root ? <div className="sidebar-empty"><GitBranch size={25} /><span>{t('打开项目以查看 Git 状态')}</span></div> : gitError ? <div className="git-empty"><GitBranch size={25} /><strong>{t('未检测到 Git 仓库')}</strong><span>{formatError(gitError)}</span></div> : <>
        <button className="git-branch-line" type="button" onClick={(event) => { event.stopPropagation(); if (root) void refreshGit(root, { refreshIgnored: true }); setBranchMenu(true) }}><GitBranch size={15} /><span>{git?.branch || 'HEAD'}</span><ChevronDown size={13} /></button>
        <div className="git-remote-actions">
          {iconButton(t('拉取（fetch）'), CloudDownload, () => void gitFetch(), remoteBusy)}
          {iconButton(t('更新（pull）'), ArrowDownToLine, () => void gitPull(false), remoteBusy)}
          {iconButton(t('推送（push）'), ArrowUpFromLine, () => void gitPush(true), remoteBusy)}
          {iconButton(t('日志图'), GitBranch, () => void openGitGraph(), false)}
          {iconButton(t('贮藏（stash）'), Archive, () => void gitStashPush(), remoteBusy || !git?.files.length)}
        </div>
        {mergeConflicts.length > 0 && <>
          <div className="git-section-title conflict">{t('合并冲突')} <span>{mergeConflicts.length}</span></div>
          {mergeConflicts.map((path) => <div className="git-change-row git-conflict" key={`conflict:${path}`}>
            <button className="git-file-row" type="button" title={t('解决冲突')} onClick={() => openMergeResolver(path)}><span className="git-badge status-U">U</span><span>{path}</span></button>
          </div>)}
          <button type="button" className="git-abort-merge" onClick={() => void gitAbortMerge()}>{t('中止合并')}</button>
        </>}
        <div className="git-section-title">{t('已暂存')} <span>{git?.files.filter((file) => file.staged).length ?? 0}</span></div>
        {git?.files.filter((file) => file.staged).map((file) => <div className={`git-change-row git-${gitAppearance(file.status)}`} key={`staged:${file.path}`}>
          <button className="git-file-row" type="button" title={t('查看已暂存差异 · {name}', { name: file.path })} onClick={() => void openGitDiff(file.path, true)}><span className={`git-badge status-${statusLabel(file.status)}`}>{statusLabel(file.status)}</span><span>{file.path}</span></button>
          <button className="git-change-action" type="button" title={t('取消暂存 {name}', { name: file.path })} aria-label={t('取消暂存 {name}', { name: file.path })} onClick={() => void updateGitIndex(file.path, true)}>−</button>
        </div>)}
        <div className="git-section-title">{t('未暂存')} <span>{git?.files.filter((file) => file.unstaged).length ?? 0}</span></div>
        {!git?.files.length ? <div className="git-clean"><Check size={17} />{t('没有未提交的更改')}</div> : git.files.filter((file) => file.unstaged).map((file) => <div className={`git-change-row git-${gitAppearance(file.status)}`} key={`unstaged:${file.path}`}>
          <button className="git-file-row" type="button" title={t('查看工作区差异 · {name}', { name: file.path })} onClick={() => void openGitDiff(file.path)}><span className={`git-badge status-${statusLabel(file.status)}`}>{statusLabel(file.status)}</span><span>{file.path}</span></button>
          <button className="git-change-action" type="button" title={t('暂存 {name}', { name: file.path })} aria-label={t('暂存 {name}', { name: file.path })} onClick={() => void updateGitIndex(file.path, false)}>＋</button>
        </div>)}
        <div className="git-commit-box"><label htmlFor="git-commit-message">{t('提交信息')}</label><textarea id="git-commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t('输入提交信息…')} rows={2} /><button type="button" disabled={!commitMessage.trim() || !git?.files.some((file) => file.staged)} onClick={() => void commitGit()}>{t('提交已暂存更改')}</button></div>
        {stashEntries.length > 0 && <>
          <div className="git-section-title">{t('贮藏')} <span>{stashEntries.length}</span></div>
          {stashEntries.map((entry) => <div className="git-stash-row" key={entry.index} title={entry.message}>
            <Archive size={13} />
            <span>{entry.message}</span>
            <button type="button" title={t('恢复（pop）')} onClick={() => void gitStashPop(entry.index)}><ArrowDownToLine size={12} /></button>
            <button type="button" title={t('删除')} onClick={() => void gitStashDrop(entry.index)}><X size={12} /></button>
          </div>)}
        </>}
        <div className="git-section-title">{t('最近提交')} <span>{gitLog.length}</span></div>
        {gitLog.map((entry) => <div className="git-log-row" key={entry.hash} title={`${entry.hash} · ${entry.author} · ${entry.date}`}><strong>{entry.shortHash}</strong><span>{entry.subject}</span></div>)}
      </>}</div>
    </>}
  </aside>
}
