import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  Braces, Check, ChevronDown, ChevronRight, Copy, File, FilePlus2, FileText, FlaskConical, Folder, GitBranch,
  History, Play, Pin, Settings2, Trash2,
} from 'lucide-react'
import { displayName, relativePath, type FileEntry, type GitStatus } from '../../lib/api'
import { GoFileIcon } from '../../components/GoFileIcon'
import type { ContextState, OpenFile, SideView, TabContextState } from '../types'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface ContextMenusProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  context: ContextState | null
  newSubmenuOpen: boolean
  setNewSubmenuOpen: (value: boolean) => void
  closeContextMenu: (restoreFocus?: boolean) => void
  tabContext: TabContextState | null
  tabSubmenu: 'copy' | 'git' | null
  setTabSubmenu: (value: 'copy' | 'git' | null) => void
  closeTabContextMenu: (restoreFocus?: boolean) => void
  tabs: OpenFile[]
  mutationBusyPath: string | null
  git: GitStatus | null
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  toggleFolder: (path: string) => void
  expanded: Set<string>
  openFile: (path: string) => Promise<boolean>
  openGitFileHistory: (path: string) => Promise<void>
  setFileHistorySource: (value: 'local' | 'git') => void
  openGitDiff: (path: string, staged?: boolean) => Promise<void>
  setSideView: (value: SideView) => void
  setSidebarOpen: (value: boolean | ((current: boolean) => boolean)) => void
  runSelection: (task: 'run' | 'test' | 'build', options?: { scope?: 'workspace' | 'file' | 'package' | 'directory'; targetPath?: string; testName?: string; label?: string }) => void
  createTestsForSource: (sourcePath: string, methodLine?: number) => Promise<void>
  copyEntryPath: (path: string) => Promise<void>
  copyTabValue: (value: string) => Promise<void>
  showDialog: (kind: 'go' | 'file' | 'module' | 'workspace' | 'folder' | 'rename', parent: string, target?: FileEntry, initialName?: string) => void
  deleteEntry: (entry: FileEntry, parent: string) => Promise<void>
  closeTab: (path: string) => Promise<boolean>
  closeTabs: (paths: string[]) => Promise<void>
  togglePinnedTab: (path: string) => void
  setConfigMenu: (value: boolean) => void
}

export function ContextMenus(props: ContextMenusProps) {
  const {
    t, locale, root, context, newSubmenuOpen, setNewSubmenuOpen, closeContextMenu, tabContext, tabSubmenu,
    setTabSubmenu, closeTabContextMenu, tabs, mutationBusyPath, git, editorRef, toggleFolder, expanded,
    openFile, openGitFileHistory, setFileHistorySource, openGitDiff, setSideView, setSidebarOpen,
    runSelection, createTestsForSource, copyEntryPath, copyTabValue, showDialog, deleteEntry, closeTab,
    closeTabs, togglePinnedTab, setConfigMenu,
  } = props

  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const newSubmenuRef = useRef<HTMLDivElement | null>(null)
  const newSubmenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const tabMenuRef = useRef<HTMLDivElement | null>(null)
  const tabSubmenuRef = useRef<HTMLDivElement | null>(null)
  const tabCopyTriggerRef = useRef<HTMLButtonElement | null>(null)
  const tabGitTriggerRef = useRef<HTMLButtonElement | null>(null)

  const newMenuParent = context ? context.entry.is_dir ? context.entry.path : context.parent : null
  const renderNewMenuItems = (parent: string) => <>
    <button role="menuitem" type="button" onClick={() => showDialog('go', parent)}><GoFileIcon size={15} />{locale === 'zh-CN' ? 'Go 文件' : 'Go File'}</button>
    <button role="menuitem" type="button" onClick={() => showDialog('file', parent)}><FileText size={15} />{locale === 'zh-CN' ? '文件' : 'File'}</button>
    <button role="menuitem" type="button" onClick={() => showDialog('module', parent)}><Braces size={15} />{locale === 'zh-CN' ? 'Go 模块文件' : 'Go Module File'}</button>
    <button role="menuitem" type="button" onClick={() => showDialog('workspace', parent)}><Braces size={15} />{locale === 'zh-CN' ? 'Go 工作区文件' : 'Go Workspace File'}</button>
    <button role="menuitem" type="button" onClick={() => showDialog('folder', parent)}><Folder size={15} />{locale === 'zh-CN' ? '目录' : 'Directory'}</button>
    <div className="menu-divider" role="separator" />
    <button role="menuitem" type="button" onClick={() => showDialog('file', parent, undefined, '.editorconfig')}><Settings2 size={15} />{locale === 'zh-CN' ? 'EditorConfig 文件' : 'EditorConfig File'}</button>
  </>

  const tabContextFile = tabContext ? tabs.find((file) => file.path === tabContext.path) ?? null : null
  const tabContextIndex = tabContextFile ? tabs.findIndex((file) => file.path === tabContextFile.path) : -1
  const tabWorkspacePath = tabContextFile && root && (root === tabContextFile.path || tabContextFile.path.startsWith(`${root}/`)) ? relativePath(root, tabContextFile.path) : null
  const tabGitFile = tabWorkspacePath ? git?.files.find((file) => file.path === tabWorkspacePath) : null
  const tabCloseOthers = tabContextFile ? tabs.filter((file) => file.path !== tabContextFile.path).map((file) => file.path) : []
  const tabCloseUnmodified = tabs.filter((file) => file.content === file.savedContent).map((file) => file.path)
  const tabCloseLeft = tabs.slice(0, tabContextIndex).map((file) => file.path)
  const tabCloseRight = tabContextIndex < 0 ? [] : tabs.slice(tabContextIndex + 1).map((file) => file.path)
  const tabCloseReadOnly = tabs.filter((file) => file.readOnly).map((file) => file.path)
  const tabMenuText = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

  useLayoutEffect(() => {
    if (!context || !contextMenuRef.current) return
    const menu = contextMenuRef.current
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(context.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(context.y, window.innerHeight - bounds.height - 8))}px`
    if (context.mode === 'context' && newSubmenuOpen && newSubmenuRef.current && newSubmenuTriggerRef.current) {
      const submenu = newSubmenuRef.current
      const anchor = newSubmenuTriggerRef.current.getBoundingClientRect()
      const submenuBounds = submenu.getBoundingClientRect()
      const right = anchor.right + 5
      const left = anchor.left - submenuBounds.width - 5
      submenu.style.left = `${right + submenuBounds.width <= window.innerWidth - 8 ? right : Math.max(8, left)}px`
      submenu.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - submenuBounds.height - 8))}px`
    }
    if (context.mode === 'new' || !newSubmenuOpen) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [context, newSubmenuOpen])

  useLayoutEffect(() => {
    const menu = tabMenuRef.current
    if (!tabContext || !menu) return
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(tabContext.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(tabContext.y, window.innerHeight - bounds.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus()
  }, [tabContext])

  useLayoutEffect(() => {
    const submenu = tabSubmenuRef.current
    const trigger = tabSubmenu === 'copy' ? tabCopyTriggerRef.current : tabSubmenu === 'git' ? tabGitTriggerRef.current : null
    if (!tabContext || !submenu || !trigger) return
    const anchor = trigger.getBoundingClientRect()
    const bounds = submenu.getBoundingClientRect()
    const right = anchor.right + 5
    const left = anchor.left - bounds.width - 5
    submenu.style.left = `${right + bounds.width <= window.innerWidth - 8 ? right : Math.max(8, left)}px`
    submenu.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8))}px`
  }, [tabContext, tabSubmenu])

  const handleContextMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { event.preventDefault(); closeContextMenu(true); return }
    if (event.key === 'ArrowRight' && event.currentTarget === contextMenuRef.current && document.activeElement === newSubmenuTriggerRef.current) {
      event.preventDefault()
      setNewSubmenuOpen(true)
      requestAnimationFrame(() => newSubmenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus())
      return
    }
    if (event.key === 'ArrowLeft' && event.currentTarget === newSubmenuRef.current) {
      event.preventDefault()
      setNewSubmenuOpen(false)
      newSubmenuTriggerRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
    if (event.currentTarget === contextMenuRef.current && items[next] !== newSubmenuTriggerRef.current) setNewSubmenuOpen(false)
  }

  const handleTabMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { event.preventDefault(); closeTabContextMenu(true); return }
    if (event.key === 'ArrowRight' && event.currentTarget === tabMenuRef.current) {
      const submenu = document.activeElement === tabCopyTriggerRef.current ? 'copy' : document.activeElement === tabGitTriggerRef.current ? 'git' : null
      if (submenu) {
        event.preventDefault()
        setTabSubmenu(submenu)
        requestAnimationFrame(() => tabSubmenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus())
        return
      }
    }
    if (event.key === 'ArrowLeft' && event.currentTarget === tabSubmenuRef.current) {
      event.preventDefault()
      const trigger = tabSubmenu === 'copy' ? tabCopyTriggerRef.current : tabGitTriggerRef.current
      setTabSubmenu(null)
      trigger?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')]
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
    if (event.currentTarget === tabMenuRef.current && items[next] !== tabCopyTriggerRef.current && items[next] !== tabGitTriggerRef.current) setTabSubmenu(null)
  }

  return <>
    {context && <div ref={contextMenuRef} className={`menu-popover context-menu ${context.mode === 'new' ? 'new-entry-menu' : ''}`} role="menu" aria-label={context.mode === 'new' ? locale === 'zh-CN' ? '新建' : 'New' : t('文件操作')} style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()} onKeyDown={handleContextMenuKeyDown} onMouseOver={(event) => {
      if (context.mode !== 'context') return
      const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="menuitem"]')
      if (!item || !event.currentTarget.contains(item)) return
      setNewSubmenuOpen(item === newSubmenuTriggerRef.current)
    }}>
      {context.mode === 'new' ? newMenuParent && renderNewMenuItems(newMenuParent) : <>
      <button ref={newSubmenuTriggerRef} role="menuitem" type="button" aria-haspopup="menu" aria-controls="new-entry-submenu" aria-expanded={newSubmenuOpen} onClick={() => {
        setNewSubmenuOpen(true)
        requestAnimationFrame(() => newSubmenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus())
      }}><FilePlus2 size={14} /><span>{locale === 'zh-CN' ? '新建' : 'New'}</span><ChevronRight className="context-submenu-arrow" size={14} /></button>
      <div className="menu-divider" role="separator" />
      <button role="menuitem" type="button" onClick={() => {
        if (context.entry.is_dir) {
          toggleFolder(context.entry.path)
          closeContextMenu(true)
        } else {
          closeContextMenu()
          void openFile(context.entry.path).then((opened) => { if (opened) editorRef.current?.focus() })
        }
      }}>{context.entry.is_dir ? expanded.has(context.entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <File size={14} />}{t(context.entry.is_dir ? expanded.has(context.entry.path) ? '收起文件夹' : '展开文件夹' : '打开文件')}</button>
      {!context.entry.is_dir && <button role="menuitem" type="button" onClick={() => { const path = context.entry.path; closeContextMenu(true); void openGitFileHistory(path) }}><History size={14} />{t('查看文件历史')}</button>}
      {context.entry.is_dir && <><div className="menu-divider" role="separator" />
        <button role="menuitem" type="button" onClick={() => { runSelection('run', { scope: 'package', targetPath: context.entry.path, label: `运行 ${context.entry.name}` }); closeContextMenu(true) }}><Play size={14} />运行此 Go 包</button>
        <button role="menuitem" type="button" onClick={() => { runSelection('test', { scope: 'package', targetPath: context.entry.path, label: `测试 ${context.entry.name}` }); closeContextMenu(true) }}><FlaskConical size={14} />测试此 Go 包</button>
        <button role="menuitem" type="button" onClick={() => { runSelection('test', { scope: 'directory', targetPath: context.entry.path, label: `测试 ${context.entry.name}/...` }); closeContextMenu(true) }}><FlaskConical size={14} />测试此目录及子目录</button>
      </>}
      {!context.entry.is_dir && context.entry.name.endsWith('.go') && <><div className="menu-divider" role="separator" />
        {!context.entry.name.endsWith('_test.go') && <button role="menuitem" type="button" onClick={() => { const path = context.entry.path; closeContextMenu(true); void createTestsForSource(path) }}><FlaskConical size={14} />{t('创建文件测试方法')}</button>}
        {context.entry.name.endsWith('_test.go') ? <button role="menuitem" type="button" onClick={() => { runSelection('test', { scope: 'file', targetPath: context.entry.path, label: `测试 ${context.entry.name}` }); closeContextMenu(true) }}><FlaskConical size={14} />运行此文件测试</button> : <button role="menuitem" type="button" onClick={() => { runSelection('run', { scope: 'file', targetPath: context.entry.path, label: `运行 ${context.entry.name} 所在包` }); closeContextMenu(true) }}><Play size={14} />运行此文件所在包</button>}
        <button role="menuitem" type="button" onClick={() => { runSelection('test', { scope: 'package', targetPath: context.parent, label: `测试 ${context.entry.name} 所在包` }); closeContextMenu(true) }}><FlaskConical size={14} />测试当前包</button>
      </>}
      <div className="menu-divider" role="separator" />
      <button role="menuitem" type="button" onClick={() => void copyEntryPath(context.entry.path)}><Copy size={14} />{t('复制路径')}</button>
      {context.entry.path !== root && <><button role="menuitem" type="button" onClick={() => showDialog('rename', context.parent, context.entry)}><Settings2 size={14} />{t('重命名')}</button>
        <button role="menuitem" type="button" className="danger" onClick={() => void deleteEntry(context.entry, context.parent)}><Trash2 size={14} />{t('删除')}</button></>}
      </>}
    </div>}
    {context?.mode === 'context' && newSubmenuOpen && newMenuParent && <div id="new-entry-submenu" ref={newSubmenuRef} className="menu-popover context-menu new-entry-submenu" role="menu" aria-label={locale === 'zh-CN' ? '新建' : 'New'} onClick={(event) => event.stopPropagation()} onKeyDown={handleContextMenuKeyDown}>{renderNewMenuItems(newMenuParent)}</div>}

    {tabContextFile && tabContext && <div ref={tabMenuRef} className="menu-popover context-menu tab-context-menu" role="menu" aria-label={tabMenuText(`${displayName(tabContextFile.path)} 标签页操作`, `${displayName(tabContextFile.path)} tab actions`)} style={{ left: tabContext.x, top: tabContext.y }} onClick={(event) => event.stopPropagation()} onKeyDown={handleTabMenuKeyDown} onMouseOver={(event) => {
      const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="menuitem"]')
      if (!item || !event.currentTarget.contains(item)) return
      setTabSubmenu(item === tabCopyTriggerRef.current ? 'copy' : item === tabGitTriggerRef.current ? 'git' : null)
    }}>
      <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void closeTab(tabContextFile.path) }}><span className="tab-menu-label">{tabMenuText('关闭', 'Close')}</span></button>
      <button role="menuitem" type="button" disabled={!tabCloseOthers.length} onClick={() => { closeTabContextMenu(true); void closeTabs(tabCloseOthers) }}><span className="tab-menu-label">{tabMenuText('关闭其他标签页', 'Close Other Tabs')}</span></button>
      <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void closeTabs(tabs.map((file) => file.path)) }}><span className="tab-menu-label">{tabMenuText('关闭所有标签页', 'Close All Tabs')}</span></button>
      <button role="menuitem" type="button" disabled={!tabCloseUnmodified.length} onClick={() => { closeTabContextMenu(true); void closeTabs(tabCloseUnmodified) }}><span className="tab-menu-label">{tabMenuText('关闭未修改标签页', 'Close Unmodified Tabs')}</span></button>
      <button role="menuitem" type="button" disabled={!tabCloseLeft.length} onClick={() => { closeTabContextMenu(true); void closeTabs(tabCloseLeft) }}><span className="tab-menu-label">{tabMenuText('关闭左侧标签页', 'Close Tabs to the Left')}</span></button>
      <button role="menuitem" type="button" disabled={!tabCloseRight.length} onClick={() => { closeTabContextMenu(true); void closeTabs(tabCloseRight) }}><span className="tab-menu-label">{tabMenuText('关闭右侧标签页', 'Close Tabs to the Right')}</span></button>
      <button role="menuitem" type="button" disabled={!tabCloseReadOnly.length} onClick={() => { closeTabContextMenu(true); void closeTabs(tabCloseReadOnly) }}><span className="tab-menu-label">{tabMenuText('关闭所有只读项', 'Close All Read-Only Tabs')}</span></button>
      <div className="menu-divider" role="separator" />
      <button ref={tabCopyTriggerRef} role="menuitem" type="button" aria-haspopup="menu" aria-controls="tab-copy-submenu" aria-expanded={tabSubmenu === 'copy'} onClick={() => {
        setTabSubmenu('copy')
        requestAnimationFrame(() => tabSubmenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus())
      }}><Copy size={14} /><span className="tab-menu-label">{tabMenuText('复制路径/引用…', 'Copy Path/Reference…')}</span><ChevronRight className="context-submenu-arrow" size={14} /></button>
      <div className="menu-divider" role="separator" />
      <button role="menuitemcheckbox" type="button" aria-checked={!!tabContextFile.pinned} onClick={() => { togglePinnedTab(tabContextFile.path); closeTabContextMenu(true) }}><Pin size={14} /><span className="tab-menu-label">{tabMenuText('固定标签页', 'Pin Tab')}</span>{tabContextFile.pinned && <Check className="tab-menu-check" size={14} />}</button>
      {tabWorkspacePath && tabContextFile.path.endsWith('.go') && !tabContextFile.binary && <><div className="menu-divider" role="separator" />
        <button role="menuitem" type="button" onClick={() => {
          const path = tabContextFile.path
          closeTabContextMenu(true)
          if (path.endsWith('_test.go')) runSelection('test', { scope: 'file', targetPath: path, label: `测试 ${displayName(path)}` })
          else runSelection('run', { scope: 'file', targetPath: path, label: `运行 ${displayName(path)} 所在包` })
        }}><Play size={14} /><span className="tab-menu-label">{tabMenuText(`运行 '${displayName(tabContextFile.path)}'`, `Run '${displayName(tabContextFile.path)}'`)}</span></button>
        <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); setConfigMenu(true) }}><Settings2 size={14} /><span className="tab-menu-label">{tabMenuText('修改运行配置…', 'Edit Run Configuration…')}</span></button>
      </>}
      {tabWorkspacePath && <><div className="menu-divider" role="separator" />
        <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void openGitFileHistory(tabContextFile.path); setFileHistorySource('local') }}><History size={14} /><span className="tab-menu-label">{tabMenuText('本地历史记录', 'Local History')}</span></button>
        <button ref={tabGitTriggerRef} role="menuitem" type="button" aria-haspopup="menu" aria-controls="tab-git-submenu" aria-expanded={tabSubmenu === 'git'} onClick={() => {
          setTabSubmenu('git')
          requestAnimationFrame(() => tabSubmenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus())
        }}><GitBranch size={14} /><span className="tab-menu-label">Git</span><ChevronRight className="context-submenu-arrow" size={14} /></button>
        <div className="menu-divider" role="separator" />
        <button role="menuitem" type="button" disabled={!!mutationBusyPath} onClick={() => {
          const path = tabContextFile.path
          const parent = path.slice(0, path.lastIndexOf('/')) || '/'
          showDialog('rename', parent, { path, name: displayName(path), is_dir: false, ignored: false })
        }}><FileText size={14} /><span className="tab-menu-label">{tabMenuText('重命名文件…', 'Rename File…')}</span></button>
      </>}
    </div>}
    {tabContextFile && tabContext && tabSubmenu && <div id={tabSubmenu === 'copy' ? 'tab-copy-submenu' : 'tab-git-submenu'} ref={tabSubmenuRef} className="menu-popover context-menu tab-context-submenu" role="menu" aria-label={tabSubmenu === 'copy' ? tabMenuText('复制路径/引用', 'Copy Path/Reference') : 'Git'} onClick={(event) => event.stopPropagation()} onKeyDown={handleTabMenuKeyDown}>
      {tabSubmenu === 'copy' ? <>
        <button role="menuitem" type="button" onClick={() => void copyTabValue(tabContextFile.path)}>{tabMenuText('绝对路径', 'Absolute Path')}</button>
        {tabWorkspacePath && <button role="menuitem" type="button" onClick={() => void copyTabValue(tabWorkspacePath)}>{tabMenuText('项目相对路径', 'Path from Project Root')}</button>}
        <button role="menuitem" type="button" onClick={() => void copyTabValue(displayName(tabContextFile.path))}>{tabMenuText('文件名', 'File Name')}</button>
      </> : <>
        <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void openGitFileHistory(tabContextFile.path); setFileHistorySource('git') }}>{tabMenuText('查看文件历史', 'File History')}</button>
        {tabGitFile?.unstaged && <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void openGitDiff(tabWorkspacePath!, false) }}>{tabMenuText('查看工作区差异', 'View Working Tree Diff')}</button>}
        {tabGitFile?.staged && <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); void openGitDiff(tabWorkspacePath!, true) }}>{tabMenuText('查看已暂存差异', 'View Staged Diff')}</button>}
        <button role="menuitem" type="button" onClick={() => { closeTabContextMenu(true); setSideView('git'); setSidebarOpen(true) }}>{tabMenuText('查看 Git 状态', 'Show Git Status')}</button>
      </>}
    </div>}
  </>
}
