import type { RefObject } from 'react'
import { useCallback, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import type { OnChange, OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { ArrowLeft, ArrowRight, BookOpen, Columns2, FilePlus2, FolderOpen, FolderPlus, Pin, TerminalSquare, X } from 'lucide-react'
import { displayName, fileLanguage, relativePath, type GitStatus } from '../../lib/api'
import { renderMarkdown } from '../../lib/markdownPreview'
import { fileUri } from '../../lib/lsp'
import { entryIcon, gitAppearance, iconButton, isWorkspaceFile } from '../helpers'
import type { OpenFile, PanelView, TabContextState } from '../types'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface EditorAreaProps {
  /** Rendered below the editor inside main-area (the bottom tool panel). */
  children?: React.ReactNode
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  tabs: OpenFile[]
  activePath: string | null
  activeFile: OpenFile | null
  tabContext: TabContextState | null
  git: GitStatus | null
  showTabContextMenu: (path: string, trigger: HTMLButtonElement, x: number, y: number) => void
  selectTab: (path: string) => void
  closeTab: (path: string) => Promise<boolean>
  navigateHistory: (direction: 'back' | 'forward') => Promise<void>
  historyNavigationBusy: boolean
  historyAvailability: { back: boolean; forward: boolean }
  editorTabListRef: RefObject<HTMLDivElement | null>
  beforeEditorMount: (monaco: typeof Monaco) => void
  onEditorMount: OnMount
  onSplitEditorMount: (editor: Monaco.editor.IStandaloneCodeEditor) => void
  changeFile: OnChange
  /**
   * Content the editor model should hold when (re)created for a path, updated
   * only by external writes (disk reloads, workspace edits, save formatting).
   * Typing never touches it, so Monaco never sees a value that disagrees with
   * the live model — feeding typed text back through `value` makes the
   * wrapper replace the whole document and jump the caret when a render
   * lands late.
   */
  externalContent: Record<string, string>
  editorPreferences: { fontSize: number; lineHeight: number; minimap: boolean; showLineNumbers: boolean; showWhitespace: boolean; wordWrap: boolean; inlayHints: boolean }
  activeIndentOptions: { tabSize: number; insertSpaces: boolean }
  chooseWorkspace: () => Promise<void>
  openNewProject: () => Promise<void>
  showDialog: (kind: 'go' | 'folder', parent: string) => void
  setPanelView: (value: PanelView) => void
  setPanelOpen: (value: boolean | ((current: boolean) => boolean)) => void
  /** Second editor group: the file pinned to the right pane. */
  splitPath: string | null
  setSplitPath: (path: string | null) => void
  theme: string
  /** Renders each line number; returns '' to hide it (breakpoint overlay). */
  lineNumbersFormatter?: (line: number) => string
  /** Markdown preview pane shown beside the active .md file. */
  mdPreviewOpen: boolean
  setMdPreviewOpen: (value: boolean) => void
}

export function EditorArea(props: EditorAreaProps) {
  const {
    children, t, locale, root, tabs, activePath, activeFile, tabContext, git, showTabContextMenu, selectTab, closeTab,
    navigateHistory, historyNavigationBusy, historyAvailability, editorTabListRef, beforeEditorMount,
    onEditorMount, onSplitEditorMount, changeFile, externalContent, editorPreferences, activeIndentOptions,
    chooseWorkspace, openNewProject, showDialog, setPanelView, setPanelOpen, splitPath, setSplitPath, theme,
    lineNumbersFormatter, mdPreviewOpen, setMdPreviewOpen,
  } = props
  const splitFile = tabs.find((file) => file.path === splitPath) ?? null
  const isMarkdown = !!activeFile && !activeFile.binary && activeFile.path.endsWith('.md')
  const previewHtml = useMemo(() => mdPreviewOpen && isMarkdown ? renderMarkdown(activeFile.content) : '', [activeFile?.content, isMarkdown, mdPreviewOpen])
  const editorOptions = useCallback((readOnly: boolean | undefined) => ({ automaticLayout: true, readOnly: !!readOnly, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", fontSize: editorPreferences.fontSize, lineHeight: editorPreferences.lineHeight, ...activeIndentOptions, minimap: { enabled: editorPreferences.minimap, scale: 1 }, smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'off', scrollBeyondLastLine: false, lineNumbersMinChars: 2, lineNumbers: editorPreferences.showLineNumbers ? (lineNumbersFormatter ?? 'on') : 'off', renderWhitespace: editorPreferences.showWhitespace ? 'all' : 'none', guides: { indentation: true }, padding: { top: 18, bottom: 20 }, bracketPairColorization: { enabled: false }, inlineSuggest: { enabled: true }, multiCursorModifier: 'alt', fixedOverflowWidgets: true, definitionLinkOpensInPeek: false, gotoLocation: { multipleDefinitions: 'goto' }, wordWrap: editorPreferences.wordWrap ? 'on' : 'off', 'semanticHighlighting.enabled': true, glyphMargin: true, inlayHints: { enabled: editorPreferences.inlayHints ? 'on' : 'off' } } as const), [editorPreferences, activeIndentOptions, lineNumbersFormatter])
  // Stable option objects keep the memoized Editor from re-rendering (and
  // re-running updateOptions) on every keystroke.
  const mainOptions = useMemo(() => editorOptions(activeFile?.readOnly), [activeFile?.readOnly, editorOptions])
  const splitOptions = useMemo(() => editorOptions(splitFile?.readOnly), [editorOptions, splitFile?.readOnly])
  return <main className="main-area">
    <div className="editor-tabs">
      <div className="editor-tab-list" ref={editorTabListRef}>{tabs.length ? tabs.map((file) => {
        const Icon = entryIcon({ name: displayName(file.path), path: file.path, is_dir: false, ignored: false })
        const dirty = file.content !== file.savedContent
        const relative = root && isWorkspaceFile(root, file.path) ? relativePath(root, file.path) : null
        const gitFile = relative ? git?.files.find((item) => item.path === relative) : null
        return <div className={`editor-tab ${activePath === file.path ? 'active' : ''} ${file.pinned ? 'pinned' : ''} ${tabContext?.path === file.path ? 'context-target' : ''} ${gitFile ? `git-${gitAppearance(gitFile.status)}` : ''}`} key={file.path} onContextMenu={(event) => {
          event.preventDefault()
          const trigger = event.currentTarget.querySelector<HTMLButtonElement>('.tab-select')
          if (trigger) showTabContextMenu(file.path, trigger, event.clientX, event.clientY)
        }}>
          <button className="tab-select" type="button" title={gitFile ? `${file.path} · Git ${gitFile.status}` : file.path} aria-haspopup="menu" aria-expanded={tabContext?.path === file.path} onClick={() => selectTab(file.path)} onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            showTabContextMenu(file.path, event.currentTarget, bounds.left + 24, bounds.bottom + 4)
          }}><Icon size={15} className={file.path.endsWith('.go') ? 'go' : ''} /><span className="tab-file-name">{displayName(file.path)}</span>{file.pinned && <Pin className="tab-pin" size={11} aria-label={locale === 'zh-CN' ? '已固定' : 'Pinned'} />}{dirty && <span className="dirty-dot" aria-label={t('未保存')} />}</button>
          <button className="tab-close" type="button" title={t('关闭 {name}', { name: displayName(file.path) })} aria-label={t('关闭 {name}', { name: displayName(file.path) })} onClick={() => void closeTab(file.path)}><X size={13} /></button>
        </div>
      }) : <div className="tabs-placeholder">{t('Welcome')}</div>}</div>
      <div className="editor-navigation">
        {iconButton(t('后退'), ArrowLeft, () => void navigateHistory('back'), !historyNavigationBusy && !historyAvailability.back)}
        {iconButton(t('前进'), ArrowRight, () => void navigateHistory('forward'), !historyNavigationBusy && !historyAvailability.forward)}
        {iconButton(splitPath ? t('取消分屏') : t('向右分屏'), Columns2, () => setSplitPath(splitPath ? null : activePath), !activeFile)}
        {isMarkdown && iconButton(t('切换 Markdown 预览'), BookOpen, () => setMdPreviewOpen(!mdPreviewOpen), false)}
      </div>
      {activeFile?.readOnly && <span className="tabs-readonly">{t('只读')}</span>}
      {activeFile && iconButton(t('关闭当前标签'), X, () => void closeTab(activeFile.path))}
    </div>
    <div className={`editor-container ${splitFile ? 'split' : ''} ${mdPreviewOpen && isMarkdown ? 'with-preview' : ''}`}>
      {activeFile ? <Editor
        path={fileUri(activeFile.path)}
        language={activeFile.binary ? 'plaintext' : fileLanguage(activeFile.path)}
        value={externalContent[activeFile.path] ?? activeFile.content}
        theme={theme}
        beforeMount={beforeEditorMount}
        onMount={onEditorMount}
        onChange={changeFile}
        options={mainOptions}
      /> : <div className="editor-empty"><div className="empty-symbol"><span>Go</span></div><h1>{t('欢迎使用 MGLand')}</h1><p>{root ? t('从 Project 工具窗口选择文件，开始编写 Go 代码。') : t('选择已有项目，或新建一个 Go 项目。')}</p><div className="welcome-actions"><button type="button" onClick={() => void chooseWorkspace()}><FolderOpen size={17} />{root ? t('打开项目') : t('打开已有项目')}</button>{root ? <><button type="button" onClick={() => showDialog('go', root)}><FilePlus2 size={17} />{t('新建 Go 文件')}</button><button type="button" onClick={() => { setPanelView('terminal'); setPanelOpen(true) }}><TerminalSquare size={17} />{t('终端')}</button></> : <button type="button" onClick={() => void openNewProject()}><FolderPlus size={17} />{t('新建项目')}</button>}</div>{root && <div className="empty-shortcuts"><span><kbd>⇧ ⇧</kbd> {t('搜索文件和命令')}</span><span><kbd>⌘⇧O</kbd> {t('Project')}</span><span><kbd>⌘B</kbd> {t('跳转定义')}</span></div>}</div>}
      {splitFile && splitFile.path !== activeFile?.path ? <div className="editor-split-pane">
        <div className="editor-split-header">
          <span>{displayName(splitFile.path)}</span>
          <button type="button" title={t('关闭分屏')} onClick={() => setSplitPath(null)}><X size={12} /></button>
        </div>
        <Editor
          path={fileUri(splitFile.path)}
          language={splitFile.binary ? 'plaintext' : fileLanguage(splitFile.path)}
          value={externalContent[splitFile.path] ?? splitFile.content}
          theme={theme}
          beforeMount={beforeEditorMount}
          onMount={onSplitEditorMount}
          onChange={changeFile}
          options={splitOptions}
        />
      </div> : null}
      {mdPreviewOpen && isMarkdown && <div className="markdown-preview-pane" aria-label={t('Markdown 预览')} dangerouslySetInnerHTML={{ __html: previewHtml }} />}
    </div>
    {children}
  </main>
}
