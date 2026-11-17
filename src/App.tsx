import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { OnChange, OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  AlertCircle, AppWindow, Bookmark, Braces, Check, CircleHelp, Download, FlaskConical, Folder, FolderOpen, FolderPlus,
  GitBranch, Hammer, ListTree, Package, Play, Search, Settings2, TerminalSquare, Wrench, X,
} from 'lucide-react'
import { SettingsPane, type SettingsSection } from './components/SettingsPane'
import {
  command, desktopAvailable, displayName, errorMessage, fileLanguage,
  joinPath, relativePath, type BinaryPreview, type FileEntry, type GoModInfo, type ReplaceFileResult, type ToolVersions,
} from './lib/api'
import { fileUri, uriToPath, applyTextEdits, type WorkspaceEditCallback, type WorkspaceSymbolEntry, type StructureSymbol } from './lib/lsp'
import { commitWorkspaceFileWrites, type WorkspaceFileWrite } from './lib/lsp/workspaceEditTransaction'
import type { LspCodeAction } from './lib/lsp/protocol'
import { createGoTest, goPackageDeclarationLine, goSourceDeclarations, goTestDeclarations } from './lib/goTests'
import { generateConstructor, generateGetters, generateSetters, generateStructTags, goStructs, type StructTagScheme } from './lib/goGenerate'
import { registerGoTemplates } from './lib/goTemplates'
import { coverageRanges } from './lib/coverage'
import { rememberProject, loadRecentProjects } from './lib/recentProjects'
import { createShortcutMatcher, DEFAULT_SHORTCUTS, loadPreferences, loadProjectGoOverrides, savePreferences, saveProjectGoOverrides, shortcutFromKeyboardEvent, type GoPreferences, type Preferences, type RunConfiguration, type ShortcutAction } from './lib/preferences'
import { createProjectCodeStyleIfMissing, loadProjectCodeStyleSnapshot, migrateLegacyProjectCodeStyle, parseProjectCodeStyle, projectCodeStyleExists, projectCodeStylePath, saveProjectCodeStyle, serializeProjectCodeStyle, type ProjectCodeStyleIO } from './lib/projectCodeStyle'
import { createLocalUnifiedDiff, LocalEditHistory } from './lib/localHistory'
import { executePluginAction, getEnabledPluginActions, getPlugins, subscribePlugins } from './lib/plugins/plugins'
import { NativePluginHost } from './lib/plugins/nativePluginHost'
import { listNativePlugins, type InstalledNativePlugin } from './lib/plugins/nativePlugins'
import { loadLocale, saveLocale, translate, type Locale, type MessageKey } from './lib/i18n'
import { localizeError } from './lib/errorI18n'
import { applyEditorConfigToContent, editorConfigIndentOptions, parseGoLandCodeStyle, resolveEditorConfig, type EditorConfigSettings } from './lib/editorConfig'
import { defineGomavoTheme, monacoThemeName } from './lib/monacoTheme'
import { registerGoSuffixCompletions } from './lib/goSuffix'
import { installGoTodoDecorations } from './lib/goHighlight'
import { installModifierNavigation } from './lib/modifierNavigation'
import { entryIcon, formatBinaryPreview, isWorkspaceFile, readOptionalEditorConfig } from './app/helpers'
import type {
  ContextState, DialogState, OpenFile, PaletteMode, PanelView,
  SideView, StartupIntent, TabContextState, TaskOptions, TestResult, Toast,
} from './app/types'
import { TitleBar } from './app/ui/TitleBar'
import { Sidebar } from './app/ui/Sidebar'
import { EditorArea } from './app/ui/EditorArea'
import { BottomPanel } from './app/ui/BottomPanel'
import { StatusBar } from './app/ui/StatusBar'
import { Dialogs } from './app/ui/Dialogs'
import { ContextMenus } from './app/ui/ContextMenus'
import { Palette } from './app/ui/Palette'
import { RunConfigDialog } from './app/ui/RunConfigDialog'
import type { UsageItem } from './app/ui/UsagesPane'
import { useNavigation, type OpenFileFn } from './app/hooks/useNavigation'
import { useLsp } from './app/hooks/useLsp'
import { useGit } from './app/hooks/useGit'
import { useTasks } from './app/hooks/useTasks'
import { useDebugger, type BreakpointSpec } from './app/hooks/useDebugger'

/** Parse `KEY=VALUE` lines from a saved run configuration into env vars. */
function parseEnvVars(text: string | null | undefined): Record<string, string> | undefined {
  if (!text?.trim()) return undefined
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    vars[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1)
  }
  return Object.keys(vars).length ? vars : undefined
}

/** Split a shell-style argument string, honoring double-quoted segments. */
function parseProgramArgs(text: string | null | undefined): string[] | undefined {
  if (!text?.trim()) return undefined
  const matches = text.match(/"([^"]*)"|'([^']*)'|(\S+)/g) ?? []
  const args = matches.map((match) => match.replace(/^["']|["']$/g, ''))
  return args.length ? args : undefined
}

/** Convert a saved run configuration into go task options. */
function runConfigurationToOptions(config: RunConfiguration): TaskOptions {
  return {
    scope: config.scope,
    targetPath: config.targetPath ?? undefined,
    testName: config.testName ?? undefined,
    label: config.name,
    programArgs: parseProgramArgs(config.programArgs),
    envVars: parseEnvVars(config.envVars),
    buildTags: config.buildTags || undefined,
    race: config.race || undefined,
    ...(config.kind === 'bench' ? { bench: config.benchPattern || '.' } : {}),
  }
}

/** Insert generated code (constructor/getters) after its struct. */
function insertGenerated(editor: Monaco.editor.IStandaloneCodeEditor, generator: (source: string) => { content: string; insertLine: number } | null): void {
  const model = editor.getModel()
  if (!model) return
  const generated = generator(model.getValue())
  if (!generated) return
  const line = Math.min(Math.max(generated.insertLine, 1), model.getLineCount() + 1)
  editor.executeEdits('gomavo.generate', [{
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    text: generated.content,
    forceMoveMarkers: true,
  }])
  editor.revealLineInCenter(line)
  editor.focus()
}

/** Full-document scans (declaration parsing) only re-run once typing settles.
 *  A changed key (tab switch) bypasses the delay so stale content never pairs
 *  with a new file's path. */
function useDebouncedValue<T>(value: T, delay: number, key?: unknown): T {
  const [deferred, setDeferred] = useState(value)
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key
      setDeferred(value)
      return
    }
    const timer = window.setTimeout(() => setDeferred(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay, key])
  return deferred
}

const projectCodeStyleIO: ProjectCodeStyleIO = {
  listDirectory: (path) => command<FileEntry[]>('list_directory', { path }),
  readFile: (path) => command<string>('read_file', { path }),
  createDirectory: (path) => command('create_directory', { path }),
  createFile: (path, content) => command('create_file_with_content', { path, content }),
  writeFile: (path, content, expectedContent) => command('write_file', { path, content, expectedContent }),
}

function App() {
  const [locale, setLocale] = useState<Locale>(loadLocale)
  const localeRef = useRef(locale)
  localeRef.current = locale
  const t = useCallback((key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values), [locale])
  const [root, setRoot] = useState<string | null>(null)
  const rootRef = useRef<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [tree, setTree] = useState<Record<string, FileEntry[]>>({})
  const treeRef = useRef(tree)
  treeRef.current = tree
  const directoryRefreshRequestRef = useRef(new Map<string, number>())
  const [projectFiles, setProjectFiles] = useState<FileEntry[]>([])
  const projectFilesRequestRef = useRef(0)
  const [goModulePath, setGoModulePath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const [tabs, setTabs] = useState<OpenFile[]>([])
  const tabsRef = useRef<OpenFile[]>([])
  const saveQueueRef = useRef(new Map<string, Promise<boolean>>())
  const editorTabListRef = useRef<HTMLDivElement | null>(null)
  const closingTabsRef = useRef<Set<string>>(new Set())
  const [activePath, setActivePath] = useState<string | null>(null)
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const openSequenceRef = useRef(0)
  const [sideView, setSideView] = useState<SideView>('files')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelView, setPanelView] = useState<PanelView>('terminal')
  const [panelOpen, setPanelOpen] = useState(false)
  const [runConfig, setRunConfig] = useState<'run' | 'test' | 'build'>('run')
  const [runOptions, setRunOptions] = useState<TaskOptions>({})
  const [configMenu, setConfigMenu] = useState(false)
  const localEditHistoryRef = useRef(new LocalEditHistory())
  const [localHistoryRevision, setLocalHistoryRevision] = useState(0)
  const [branchMenu, setBranchMenu] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [versions, setVersions] = useState<ToolVersions | null>(null)
  const [goMod, setGoMod] = useState<GoModInfo | null>(null)
  const [lspEpoch, setLspEpoch] = useState(0)
  const workspaceQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const workspaceGenerationRef = useRef(0)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogName, setDialogName] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [windowClosePrompt, setWindowClosePrompt] = useState(false)
  const [windowCloseBusy, setWindowCloseBusy] = useState(false)
  const windowClosePromptRef = useRef(false)
  const windowCloseBusyRef = useRef(false)
  const [context, setContext] = useState<ContextState | null>(null)
  const [tabContext, setTabContext] = useState<TabContextState | null>(null)
  const [tabSubmenu, setTabSubmenu] = useState<'copy' | 'git' | null>(null)
  const tabContextTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [newSubmenuOpen, setNewSubmenuOpen] = useState(false)
  const [mutationBusyPath, setMutationBusyPath] = useState<string | null>(null)
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const [moduleMenu, setModuleMenu] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('all')
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteSelection, setPaletteSelection] = useState(0)
  const paletteTriggerRef = useRef<HTMLElement | null>(null)
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('editor')
  const installedPlugins = useSyncExternalStore(subscribePlugins, getPlugins, getPlugins)
  const [nativePlugins, setNativePlugins] = useState<InstalledNativePlugin[]>([])
  const nativePluginHostRef = useRef<NativePluginHost | null>(null)
  const shortcutMatcherRef = useRef(createShortcutMatcher())
  const [toast, setToast] = useState<Toast | null>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [monacoApi, setMonacoApi] = useState<typeof Monaco | null>(null)
  /** Content each editor model should hold at (re)creation; see EditorAreaProps.externalContent. */
  const [externalContent, setExternalContent] = useState<Record<string, string>>({})
  const splitEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const activePathRef = useRef<string | null>(null)
  activePathRef.current = activePath
  const runEditorContextRef = useRef<((line?: number, fileFallback?: boolean) => boolean) | null>(null)
  const toggleBreakpointRef = useRef<((path: string, line: number) => void) | null>(null)
  const lineNumbersFormatterRef = useRef<((line: number) => string) | null>(null)
  const createTestFromEditorRef = useRef<((line?: number) => void) | null>(null)
  const openGitFileHistoryRef = useRef<((path: string) => void) | null>(null)
  const createTestContextLineRef = useRef<number | null>(null)
  const creatingTestRef = useRef(false)
  // --- New tool state: split, breakpoints, bookmarks, recents, search, theme ---
  const [splitPath, setSplitPath] = useState<string | null>(null)
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>(() => {
    try { return JSON.parse(localStorage.getItem('gomavo.breakpoints') ?? '{}') as Record<string, number[]> } catch { return {} }
  })
  const breakpointsRef = useRef(breakpoints)
  breakpointsRef.current = breakpoints
  /** Per-breakpoint condition/logMessage specs (GoLand breakpoint properties). */
  const [breakpointSpecs, setBreakpointSpecs] = useState<Record<string, Record<number, BreakpointSpec>>>(() => {
    try { return JSON.parse(localStorage.getItem('gomavo.breakpointSpecs') ?? '{}') as Record<string, Record<number, BreakpointSpec>> } catch { return {} }
  })
  const breakpointSpecsRef = useRef(breakpointSpecs)
  breakpointSpecsRef.current = breakpointSpecs
  const [breakpointEdit, setBreakpointEdit] = useState<{ path: string; line: number; condition: string; logMessage: string } | null>(null)
  const [mdPreviewOpen, setMdPreviewOpen] = useState(false)
  const [structureSymbols, setStructureSymbols] = useState<StructureSymbol[]>([])
  const [structureLoading, setStructureLoading] = useState(false)
  const [usages, setUsages] = useState<{ identifier: string; items: UsageItem[] } | null>(null)
  const [usagesBusy, setUsagesBusy] = useState(false)
  const [intentionItems, setIntentionItems] = useState<LspCodeAction[]>([])
  const [lineJumpOpen, setLineJumpOpen] = useState(false)
  const [lineJumpDraft, setLineJumpDraft] = useState('')
  const lineJumpInputRef = useRef<HTMLInputElement | null>(null)
  const [bookmarks, setBookmarks] = useState<Record<string, number[]>>(() => {
    try { return JSON.parse(localStorage.getItem('gomavo.bookmarks') ?? '{}') as Record<string, number[]> } catch { return {} }
  })
  const [recentProjects, setRecentProjects] = useState<string[]>(loadRecentProjects)
  /** Style-family scope: "global" applies everywhere, "project" only to the open workspace. */
  const [goScope, setGoScope] = useState<'global' | 'project'>('global')
  const [projectGoOverrides, setProjectGoOverrides] = useState<Partial<GoPreferences>>({})
  const [projectStyleReady, setProjectStyleReady] = useState(false)
  const projectStyleDiskRef = useRef(new Map<string, string | null>())
  const projectStyleExternalRevisionRef = useRef(new Map<string, number>())
  const projectStyleSaveRef = useRef<Promise<void>>(Promise.resolve())
  const projectStyleLoadRef = useRef<{ root: string; promise: Promise<void> } | null>(null)
  const projectStyleLoadRequestRef = useRef(0)
  const syncProjectStyleTabRef = useRef<((path: string, content: string) => void) | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const [runConfigEditorOpen, setRunConfigEditorOpen] = useState(false)
  const [symbolResults, setSymbolResults] = useState<WorkspaceSymbolEntry[]>([])
  const [prefersDark, setPrefersDark] = useState(() => typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(prefers-color-scheme: dark)').matches)
  const monacoTheme = monacoThemeName(preferences.appearance.theme, prefersDark)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', monacoTheme === 'gomavo-light')
  }, [monacoTheme])

  // Force-sync Monaco with the active theme: the editor library applies the
  // theme prop on creation, but a restart with a different theme can race
  // the initial setTheme, leaving stale colors.
  useEffect(() => {
    if (!monacoApi) return
    try { monacoApi.editor.setTheme(monacoTheme) } catch { /* editor not ready yet */ }
  }, [monacoApi, monacoTheme])

  useEffect(() => {
    try { localStorage.setItem('gomavo.breakpoints', JSON.stringify(breakpoints)) } catch { /* storage full */ }
  }, [breakpoints])

  useEffect(() => {
    try { localStorage.setItem('gomavo.breakpointSpecs', JSON.stringify(breakpointSpecs)) } catch { /* storage full */ }
  }, [breakpointSpecs])

  useEffect(() => {
    try { localStorage.setItem('gomavo.bookmarks', JSON.stringify(bookmarks)) } catch { /* storage full */ }
  }, [bookmarks])

  const activeFile = tabs.find((file) => file.path === activePath) ?? null
  const activeIndentOptions = editorConfigIndentOptions(activeFile?.editorConfig ?? {}, preferences.editor)
  // Whole-file parses (declarations, package line) lag one beat behind typing:
  // on a 10k-line file they cost several milliseconds per keystroke otherwise.
  const activeFileContent = useDebouncedValue(activeFile?.content ?? '', 250)
  const activeTestDeclarations = useMemo(() => activeFile?.path.endsWith('_test.go') ? goTestDeclarations(activeFileContent) : [], [activeFileContent, activeFile?.path])
  const activePackageLine = useMemo(() => activeFile?.path.endsWith('_test.go') ? goPackageDeclarationLine(activeFileContent) : null, [activeFileContent, activeFile?.path])
  /** Gutter click awaiting its first `go test` event; drives the spinner before compile output arrives. */
  const [pendingTestRun, setPendingTestRun] = useState<{ path: string; testName?: string } | null>(null)
  const dirtyFiles = tabs.filter((file) => file.content !== file.savedContent)
  const dirtyCount = dirtyFiles.length
  const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent)
  // Breadcrumb symbol: the Go declaration enclosing the cursor line.
  const activeSymbol = useMemo(() => {
    if (!activeFile?.path.endsWith('.go') || activeFile.binary || !cursor.line) return null
    const declaration = goSourceDeclarations(activeFileContent).find((item) => item.startLine <= cursor.line && cursor.line <= item.endLine)
    return declaration ? { name: declaration.name, line: declaration.startLine } : null
  }, [activeFile?.binary, activeFileContent, activeFile?.path, cursor.line])

  useEffect(() => {
    editorTabListRef.current?.querySelector<HTMLElement>('.editor-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])

  useEffect(() => {
    if (tabContext && !tabs.some((file) => file.path === tabContext.path)) {
      setTabContext(null)
      setTabSubmenu(null)
    }
  }, [tabContext, tabs])

  useEffect(() => {
    if (activePath && isWorkspaceFile(root, activePath)) setSelectedTreePath(activePath)
  }, [activePath, root])

  const notify = useCallback((text: string, kind: Toast['kind'] = 'success') => setToast({ text, kind }), [])
  const formatError = useCallback((cause: unknown) => localizeError(localeRef.current, errorMessage(cause)), [])

  const openFileRef = useRef<OpenFileFn | null>(null)
  const {
    setNavigation, pendingNavigationRef, navigationRequestRef, historyRef,
    historyAvailability, historyNavigationBusy, cancelPendingNavigation, refreshHistoryAvailability,
    captureEditorLocation, applyNavigation, navigateTo, navigateHistory, reset: resetNavigation,
  } = useNavigation({ openFileRef, editorRef, activePathRef, activePath })
  const lspWorkspaceEditsRef = useRef<WorkspaceEditCallback | null>(null)
  const goGetRef = useRef<((module: string) => void) | null>(null)
  // Style-family Go settings support a project scope: project overrides win
  // over the global defaults while the workspace is open.
  const effectiveGo = useMemo(() => ({ ...preferences.go, ...projectGoOverrides }), [preferences.go, projectGoOverrides])
  const {
    lspState, lspError, goplsLog, lspRef, diagnostics, goToDefinition, reset: resetLsp,
  } = useLsp({
    root, monacoApi, goplsAvailable: versions?.gopls, lspEpoch, tabsRef, navigateTo,
    captureEditorLocation, navigationRequestRef, activePath, activePathRef,
    workspaceEditsRef: lspWorkspaceEditsRef, missingModuleRef: goGetRef, localPrefix: effectiveGo.localPrefix,
    staticcheck: effectiveGo.staticcheck, gofumpt: effectiveGo.gofumpt, notify, formatError, t,
  })
  const problemCount = diagnostics.filter((item) => item.severity === 'error').length

  // Live-apply import grouping and lint/style settings without restarting gopls.
  useEffect(() => {
    lspRef.current?.setConfig({
      localPrefix: effectiveGo.localPrefix,
      staticcheck: effectiveGo.staticcheck,
      gofumpt: effectiveGo.gofumpt,
    })
  }, [effectiveGo.localPrefix, effectiveGo.staticcheck, effectiveGo.gofumpt])

  // Project style now lives in .gomavo/code-style.json. Copy the previous
  // project file, then migrate older browser-local overrides if needed.
  useEffect(() => {
    const request = ++projectStyleLoadRequestRef.current
    setProjectGoOverrides({})
    setGoScope('global')
    setProjectStyleReady(false)
    if (!root || !desktopAvailable) {
      projectStyleLoadRef.current = null
      return
    }
    const load = (async () => {
      let snapshot = await migrateLegacyProjectCodeStyle(root, projectCodeStyleIO)
      if (snapshot === null) {
        const legacy = loadProjectGoOverrides(root)
        if (Object.keys(legacy).length) {
          const created = await createProjectCodeStyleIfMissing(root, legacy, projectCodeStyleIO)
          snapshot = created
            ? { go: legacy, content: serializeProjectCodeStyle(legacy) }
            : await loadProjectCodeStyleSnapshot(root, projectCodeStyleIO)
          if (snapshot === null) throw new Error('Project code-style file disappeared during migration')
          saveProjectGoOverrides(root, {})
        }
      } else saveProjectGoOverrides(root, {})
      if (request !== projectStyleLoadRequestRef.current || rootRef.current !== root) return
      const overrides = snapshot?.go ?? {}
      projectStyleDiskRef.current.set(root, snapshot?.content ?? null)
      setProjectGoOverrides(overrides)
      setGoScope(Object.keys(overrides).length ? 'project' : 'global')
      setProjectStyleReady(true)
    })()
    projectStyleLoadRef.current = { root, promise: load }
    void load.catch((cause) => {
      if (request === projectStyleLoadRequestRef.current && rootRef.current === root) notify(formatError(cause), 'error')
    })
  }, [root, formatError, notify])

  const persistProjectGoOverrides = useCallback((workspace: string, overrides: Partial<GoPreferences>) => {
    const request = ++projectStyleLoadRequestRef.current
    const externalRevision = projectStyleExternalRevisionRef.current.get(workspace) ?? 0
    setProjectGoOverrides(overrides)
    projectStyleSaveRef.current = projectStyleSaveRef.current.catch(() => undefined).then(async () => {
      const load = projectStyleLoadRef.current
      if (load?.root === workspace) await load.promise
      if ((projectStyleExternalRevisionRef.current.get(workspace) ?? 0) !== externalRevision
        || !projectStyleDiskRef.current.has(workspace)) {
        throw new Error('Save conflict: File changed on disk. Reload before saving')
      }
      const expected = projectStyleDiskRef.current.get(workspace)
      let content: string
      if (expected === null) {
        if (!await createProjectCodeStyleIfMissing(workspace, overrides, projectCodeStyleIO)) {
          throw new Error('Save conflict: File changed on disk. Reload before saving')
        }
        content = serializeProjectCodeStyle(overrides)
      } else {
        content = await saveProjectCodeStyle(workspace, overrides, projectCodeStyleIO, expected!)
      }
      if ((projectStyleExternalRevisionRef.current.get(workspace) ?? 0) !== externalRevision) return
      projectStyleDiskRef.current.set(workspace, content)
      saveProjectGoOverrides(workspace, {})
      if (rootRef.current === workspace) {
        syncProjectStyleTabRef.current?.(projectCodeStylePath(workspace), content)
        if (!treeRef.current[workspace]?.some((entry) => entry.name === '.gomavo')) {
          const entries = await command<FileEntry[]>('list_directory', { path: workspace })
          setTree((current) => ({ ...current, [workspace]: entries }))
        }
      }
    }).catch(async (cause) => {
      if (rootRef.current !== workspace) return
      notify(formatError(cause), 'error')
      if (request !== projectStyleLoadRequestRef.current) return
      try {
        const snapshot = await loadProjectCodeStyleSnapshot(workspace, projectCodeStyleIO)
        if (request !== projectStyleLoadRequestRef.current || rootRef.current !== workspace) return
        const latest = snapshot?.go ?? {}
        const content = snapshot?.content ?? null
        if (projectStyleDiskRef.current.has(workspace) && projectStyleDiskRef.current.get(workspace) !== content) {
          projectStyleExternalRevisionRef.current.set(workspace, (projectStyleExternalRevisionRef.current.get(workspace) ?? 0) + 1)
        }
        projectStyleDiskRef.current.set(workspace, content)
        setProjectGoOverrides(latest)
        setGoScope(Object.keys(latest).length ? 'project' : 'global')
        setProjectStyleReady(true)
      } catch (reloadError) {
        if (request === projectStyleLoadRequestRef.current && rootRef.current === workspace) {
          setProjectStyleReady(false)
          notify(formatError(reloadError), 'error')
        }
      }
    })
  }, [formatError, notify])

  const reloadProjectCodeStyle = useCallback(async (workspace: string) => {
    if (rootRef.current !== workspace) return
    const request = ++projectStyleLoadRequestRef.current
    try {
      await projectStyleSaveRef.current.catch(() => undefined)
      const snapshot = await loadProjectCodeStyleSnapshot(workspace, projectCodeStyleIO)
      if (request !== projectStyleLoadRequestRef.current || rootRef.current !== workspace) return
      const content = snapshot?.content ?? null
      if (projectStyleDiskRef.current.has(workspace) && projectStyleDiskRef.current.get(workspace) !== content) {
        projectStyleExternalRevisionRef.current.set(workspace, (projectStyleExternalRevisionRef.current.get(workspace) ?? 0) + 1)
      }
      projectStyleDiskRef.current.set(workspace, content)
      const overrides = snapshot?.go ?? {}
      setProjectGoOverrides(overrides)
      setGoScope(Object.keys(overrides).length ? 'project' : 'global')
      setProjectStyleReady(true)
    } catch (cause) {
      if (request === projectStyleLoadRequestRef.current && rootRef.current === workspace) {
        setProjectStyleReady(false)
        notify(formatError(cause), 'error')
      }
    }
  }, [formatError, notify])

  /**
   * Replace a tab's content from outside the keyboard (disk reload, workspace
   * edit, save formatting, search replace). The model is edited first so the
   * caret survives, then the frozen value map follows; feeding the new text
   * only through React state would make the editor wrapper swap the whole
   * document and throw the cursor to line 1.
   */
  const applyExternalContent = useCallback((path: string, next: string) => {
    const monaco = monacoApi
    const model = monaco?.editor.getModel(monaco.Uri.parse(fileUri(path)))
    if (model && !model.isDisposed() && model.getValue() !== next) {
      const editor = editorRef.current
      const view = editor && editor.getModel() === model ? editor.saveViewState() : null
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
      if (editor && view && editor.getModel() === model) editor.restoreViewState(view)
    }
    setExternalContent((current) => current[path] === next ? current : { ...current, [path]: next })
  }, [monacoApi])

  syncProjectStyleTabRef.current = (path, content) => {
    const file = tabsRef.current.find((item) => item.path === path)
    if (!file || file.content !== file.savedContent) return
    if (file.content !== content) applyExternalContent(path, content)
    const next = tabsRef.current.map((item) => item.path === path ? { ...item, content, savedContent: content } : item)
    tabsRef.current = next
    setTabs(next)
  }

  /** Apply gopls workspace edits after validating every target, with checked disk rollback. */
  const workspaceEditApplyQueueRef = useRef<Promise<void>>(Promise.resolve())
  const applyWorkspaceEdits: WorkspaceEditCallback = useCallback((changes, options) => {
    const run = workspaceEditApplyQueueRef.current.then(async () => {
      const workspace = rootRef.current
      if (!workspace) throw new Error('The workspace closed while the edit was running')

      type PlannedEdit = {
        path: string
        before: string
        next: string
        open: OpenFile | null
        model: Monaco.editor.ITextModel | null
        modelVersion: number | null
        diskBefore: string | null | undefined
      }
      const planned: PlannedEdit[] = []
      const paths = new Set<string>()
      for (const [uri, edits] of Object.entries(changes)) {
        if (!edits.length) continue
        options?.validate?.()
        const path = uriToPath(uri)
        if (!isWorkspaceFile(workspace, path)) throw new Error(`${path}: outside the workspace`)
        if (paths.has(path)) throw new Error(`${path}: duplicate workspace edit target`)
        paths.add(path)
        const open = tabsRef.current.find((file) => file.path === path) ?? null
        if (open?.readOnly || open?.binary) throw new Error(`${path}: file is read-only`)
        const model = open ? monacoApi?.editor.getModel(monacoApi.Uri.parse(fileUri(path))) ?? null : null
        if (model && (model.isDisposed() || model.getValue() !== open?.content)) {
          throw new Error(`${path}: editor content changed; retry the edit`)
        }
        const before = open?.content ?? await command<string>('read_file', { path }).catch((cause) => {
          if (options?.requireExisting) throw new Error(`${path}: ${formatError(cause)}`)
          return null
        })
        let next: string
        try { next = applyTextEdits(before ?? '', edits) }
        catch (cause) { throw new Error(`${path}: ${formatError(cause)}`) }
        if (next === before) continue
        let diskBefore: string | null | undefined
        if (!open) {
          diskBefore = before
        } else if (open.content === open.savedContent) {
          // Preflight clean tabs against disk before any file is changed.
          const disk = await command<string>('read_file', { path }).catch((cause) => {
            throw new Error(`${path}: ${formatError(cause)}`)
          })
          if (disk !== open.savedContent) throw new Error(`${path}: file changed on disk; reload before renaming`)
          diskBefore = disk
        }
        planned.push({ path, before: before ?? '', next, open, model, modelVersion: model?.getVersionId() ?? null, diskBefore })
      }

      const validate = () => {
        if (rootRef.current !== workspace) throw new Error('The workspace changed while the edit was running')
        options?.validate?.()
        for (const edit of planned) {
          if (!edit.open) continue
          const latest = tabsRef.current.find((file) => file.path === edit.path)
          if (!latest || latest.content !== edit.open.content || latest.savedContent !== edit.open.savedContent) {
            throw new Error(`${edit.path}: editor content changed; retry the edit`)
          }
          if (edit.model && (edit.model.isDisposed() || edit.model.getVersionId() !== edit.modelVersion)) {
            throw new Error(`${edit.path}: editor content changed; retry the edit`)
          }
        }
      }
      const writes: WorkspaceFileWrite[] = planned
        .filter((edit) => edit.diskBefore !== undefined)
        .map((edit) => ({ path: edit.path, before: edit.diskBefore!, after: edit.next }))
      await commitWorkspaceFileWrites(writes, {
        read: (path) => command<string>('read_file', { path }),
        write: (path, content, expectedContent) => command<void>('write_file', { path, content, expectedContent }),
        create: (path, content) => command<void>('create_file_with_content', { path, content }),
        remove: (path) => command<void>('delete_path', { path }),
      }, validate, () => {
        const openEdits = planned.filter((edit) => edit.open)
        if (!openEdits.length) return
        const originalTabs = tabsRef.current
        try {
          for (const edit of openEdits) applyExternalContent(edit.path, edit.next)
          const byPath = new Map(openEdits.map((edit) => [edit.path, edit]))
          const updated = tabsRef.current.map((file) => {
            const edit = byPath.get(file.path)
            if (!edit) return file
            return { ...file, content: edit.next, savedContent: edit.diskBefore === undefined ? file.savedContent : edit.next }
          })
          tabsRef.current = updated
          setTabs(updated)
        } catch (cause) {
          for (const edit of openEdits) {
            try { applyExternalContent(edit.path, edit.before) } catch { /* Preserve the original failure. */ }
          }
          tabsRef.current = originalTabs
          setTabs(originalTabs)
          throw cause
        }
      })
      for (const edit of planned) {
        if (edit.open && localEditHistoryRef.current.ensureFile(edit.path, edit.next)) {
          setLocalHistoryRevision((value) => value + 1)
        }
        if (edit.path.endsWith('.go')) {
          if (edit.open) void lspRef.current?.changeDocument(edit.path, edit.next).catch(() => undefined)
          else void lspRef.current?.openDocument(edit.path, edit.next).catch(() => undefined)
        }
      }
    })
    workspaceEditApplyQueueRef.current = run.catch(() => undefined)
    return run
  }, [applyExternalContent, formatError, monacoApi])
  lspWorkspaceEditsRef.current = applyWorkspaceEdits

  const refreshNativePlugins = useCallback(async () => {
    if (!desktopAvailable) return
    try { setNativePlugins(await listNativePlugins()) }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify])

  useEffect(() => {
    const host = new NativePluginHost({ getProjectRoot: () => rootRef.current, notify })
    nativePluginHostRef.current = host
    return () => { host.dispose(); nativePluginHostRef.current = null }
  }, [notify])

  useEffect(() => {
    void refreshNativePlugins()
    const onFocus = () => { void refreshNativePlugins() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshNativePlugins])

  useEffect(() => { nativePluginHostRef.current?.sync(nativePlugins) }, [nativePlugins])
  useEffect(() => { nativePluginHostRef.current?.workspaceChanged() }, [root])
  useEffect(() => {
    if (activeFile && !activeFile.binary) nativePluginHostRef.current?.activateForLanguage(fileLanguage(activeFile.path))
  }, [activeFile?.binary, activeFile?.path, nativePlugins])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = root ? `${displayName(root)} · GoMavo` : t('GoMavo · Go 开发环境')
    saveLocale(locale)
  }, [locale, root, t])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const refreshTools = useCallback(async () => {
    if (!desktopAvailable) return
    try { setVersions(await command<ToolVersions>('tool_versions')) }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify])

  const refreshDirectory = useCallback(async (path: string) => {
    const requests = directoryRefreshRequestRef.current
    const request = (requests.get(path) ?? 0) + 1
    requests.set(path, request)
    try {
      const entries = await command<FileEntry[]>('list_directory', { path })
      if (requests.get(path) !== request || !isWorkspaceFile(rootRef.current, path)) return
      entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      setTree((current) => ({ ...current, [path]: entries }))
    } catch (cause) { if (requests.get(path) === request && isWorkspaceFile(rootRef.current, path)) notify(formatError(cause), 'error') }
  }, [formatError, notify])

  const refreshProjectFiles = useCallback(async (workspace: string) => {
    const request = ++projectFilesRequestRef.current
    void command<string[]>('go_modules')
      .then((lines) => {
        const requires: GoModInfo['requires'] = []
        for (const line of lines) {
          const [module, version] = line.trim().split(/\s+/)
          if (module && version && version !== '=>') requires.push({ module, version })
        }
        setGoMod(requires.length > 0 ? { requires } : null)
      })
      .catch(() => setGoMod(null))
    try {
      const files = await command<FileEntry[]>('list_project_files', { root: workspace })
      if (request === projectFilesRequestRef.current && rootRef.current === workspace) setProjectFiles(files)
    } catch (cause) {
      if (request !== projectFilesRequestRef.current || rootRef.current !== workspace) return
      setProjectFiles([])
      notify(formatError(cause), 'error')
    }
  }, [formatError, notify])

  const reloadCleanTabs = useCallback(async () => {
    const cleanFiles = tabsRef.current.filter((file) => !file.readOnly && file.content === file.savedContent)
    const refreshed = await Promise.all(cleanFiles.map(async (file) => {
      try { return { path: file.path, before: file.savedContent, content: await command<string>('read_file', { path: file.path }) } }
      catch { return null }
    }))
    const changes = refreshed.filter((file): file is NonNullable<typeof file> => !!file && file.content !== file.before)
    if (!changes.length) return
    const next = tabsRef.current.map((file) => {
      const change = changes.find((item) => item.path === file.path && item.before === file.savedContent)
      return change && file.content === file.savedContent ? { ...file, content: change.content, savedContent: change.content } : file
    })
    for (const change of changes) {
      // The tab may have gone dirty while the disk read awaited; only swap
      // the model when the buffer still matches what was snapshotted.
      const stillClean = tabsRef.current.find((file) => file.path === change.path)
      if (stillClean && stillClean.content === stillClean.savedContent && stillClean.savedContent === change.before) applyExternalContent(change.path, change.content)
    }
    tabsRef.current = next
    setTabs(next)
    let localHistoryChanged = false
    for (const change of changes) {
      const updated = next.find((file) => file.path === change.path)
      if (updated?.content === change.content && localEditHistoryRef.current.ensureFile(change.path, change.content)) localHistoryChanged = true
    }
    if (localHistoryChanged) setLocalHistoryRevision((value) => value + 1)
    for (const change of changes) if (change.path.endsWith('.go')) void lspRef.current?.changeDocument(change.path, change.content).catch(() => undefined)
  }, [applyExternalContent])

  const openGitPanel = useCallback((view: 'diff' | 'history' | 'log' | 'merge') => {
    setPanelView(view)
    setPanelOpen(true)
  }, [])

  const leaveHistoryPanel = useCallback(() => {
    setPanelView((current) => current === 'history' ? 'terminal' : current)
  }, [])

  const resetTreeAndExpansion = useCallback((root: string) => {
    setTree({})
    setExpanded(new Set([root]))
  }, [])

  const {
    git, gitError, gitDiff, setGitDiff, gitFileHistory,
    fileHistorySource, setFileHistorySource,
    selectedLocalHistoryId, setSelectedLocalHistoryId,
    gitLog, gitBranches, branchBusy, commitMessage, setCommitMessage,
    refreshGit, openGitDiff, openGitFileHistory, openGitFileCommitDiff,
    invalidateFileHistory, updateGitIndex, commitGit, changeBranch, reset: resetGit,
    remoteBusy, gitFetch, gitPull, gitPush,
    gitMerge, gitAbortMerge, mergeConflicts,
    mergeResolverPath, openMergeResolver, mergeResolved,
    stashEntries, refreshStash, gitStashPush, gitStashPop, gitStashDrop,
    gitBlame, setGitBlame, openGitBlame,
    gitGraph, gitGraphLoading, openGitGraph,
  } = useGit({
    root, rootRef, expandedRef, treeRef, workspaceGenerationRef, localEditHistoryRef,
    refreshDirectory, refreshProjectFiles, reloadCleanTabs, dirtyCount,
    openPanel: openGitPanel, leaveHistoryPanel, resetTreeAndExpansion,
    setBranchMenu, setNewBranchName, notify, formatError, t,
  })

  const selectedHistoryEntry = gitFileHistory?.entries.find((entry) => entry.hash === gitFileHistory.selectedHash) ?? null
  const localHistoryEntries = useMemo(() => gitFileHistory && root
    ? localEditHistoryRef.current.getEntries(joinPath(root, gitFileHistory.path))
    : [], [gitFileHistory?.path, root, localHistoryRevision])
  const selectedLocalHistoryEntry = localHistoryEntries.find((entry) => entry.id === selectedLocalHistoryId) ?? localHistoryEntries[0] ?? null
  const selectedLocalDiff = useMemo(() => selectedLocalHistoryEntry && gitFileHistory
    ? createLocalUnifiedDiff(selectedLocalHistoryEntry.before, selectedLocalHistoryEntry.after, gitFileHistory.path)
    : '', [selectedLocalHistoryEntry, gitFileHistory?.path])
  const openPalette = useCallback((mode: PaletteMode = 'all') => {
    paletteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPaletteMode(mode)
    setPaletteQuery('')
    setPaletteSelection(0)
    setPaletteOpen(true)
    if (rootRef.current) void refreshProjectFiles(rootRef.current)
  }, [refreshProjectFiles])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    setPaletteQuery('')
    const trigger = paletteTriggerRef.current
    paletteTriggerRef.current = null
    requestAnimationFrame(() => {
      if (trigger?.isConnected && document.activeElement === document.body) trigger.focus()
    })
  }, [])

  useEffect(() => {
    const seconds = preferences.versionControl.gitAutoRefreshSeconds
    if (!desktopAvailable || !root || seconds === 0) return
    const timer = window.setInterval(() => void refreshGit(root), seconds * 1000)
    return () => window.clearInterval(timer)
  }, [preferences.versionControl.gitAutoRefreshSeconds, refreshGit, root])

  // Recursive FS watching: one debounced event batch refreshes the tree, the
  // project index, Git state, and editor tabs whose files changed on disk.
  useEffect(() => {
    if (!desktopAvailable || !root) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    let flushTimer = 0
    let pendingPaths: string[] = []
    const target = getCurrentWebviewWindow().label
    const flush = () => {
      const paths = pendingPaths
      pendingPaths = []
      if (!paths.length) return
      const workspace = rootRef.current
      if (workspace !== root) return
      // Refresh the tree for expanded directories containing a changed entry.
      const parents = new Set(paths.map((path) => {
        const slash = path.lastIndexOf('/')
        return slash > 0 ? path.slice(0, slash) : path
      }))
      for (const parent of parents) {
        if (expandedRef.current?.has(parent)) void refreshDirectory(parent)
      }
      // go.mod / go.sum / .go changes made outside the editor (terminal `go
      // get`) reach gopls as watched-file updates so stale markers clear.
      const lspPaths = paths.filter((path) => /(^|\/)(go\.mod|go\.sum)$/.test(path) || path.endsWith('.go'))
      if (lspPaths.length) void lspRef.current?.changedWatchedFiles(lspPaths)
      if (paths.includes(projectCodeStylePath(workspace))) void reloadProjectCodeStyle(workspace)
      void refreshProjectFiles(workspace)
      void refreshGit(workspace)
      void reloadCleanTabs()
    }
    void Promise.all([
      listen<{ root: string; paths: string[]; truncated: boolean }>('fs-changed', (event) => {
        if (event.payload.root !== root) return
        pendingPaths = [...pendingPaths, ...event.payload.paths]
        window.clearTimeout(flushTimer)
        flushTimer = window.setTimeout(flush, 600)
      }, { target }),
      command('watch_start', { root }).catch(() => undefined),
    ]).then(([offWatch]) => {
      if (disposed) { offWatch(); void command('watch_stop').catch(() => undefined) }
      else unlisten = offWatch
    }).catch(() => undefined)
    return () => {
      disposed = true
      window.clearTimeout(flushTimer)
      unlisten?.()
      void command('watch_stop').catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, reloadProjectCodeStyle])

  useEffect(() => {
    if (!root || !activePath || !preferences.project.autoRevealCurrentFile || !isWorkspaceFile(root, activePath)) return
    const parent = activePath.slice(0, activePath.lastIndexOf('/'))
    const segments = relativePath(root, parent).split('/').filter(Boolean)
    const paths = [root]
    for (const segment of segments) paths.push(joinPath(paths[paths.length - 1], segment))
    setExpanded((current) => {
      if (paths.every((path) => current.has(path))) return current
      return new Set([...current, ...paths])
    })
    for (const path of paths) if (!tree[path]) void refreshDirectory(path)
  }, [activePath, preferences.project.autoRevealCurrentFile, refreshDirectory, root, tree])

  openGitFileHistoryRef.current = (path) => { void openGitFileHistory(path) }

  const saveFileRef = useRef<((path: string) => Promise<boolean>) | null>(null)
  const {
    output, setOutput, testResults, testOutput, testOutputByCase, coverageProfile,
    runningTask, lastTestOptionsRef, runTask, runTaskAwaiting, runSelection, reset: resetTasks,
  } = useTasks({
    root, rootRef, tabsRef, workspaceGenerationRef, localeRef,
    saveBeforeRun: preferences.run.saveBeforeRun, saveFileRef,
    refreshTools, refreshGit, refreshDirectory, refreshProjectFiles, reloadCleanTabs,
    setPanelOpen, setPanelView, setModuleMenu, setConfigMenu, setRunConfig, setRunOptions,
    notify, formatError, t,
  })
  const {
    debugState, debugFrames, debugSelectedFrameIndex, selectFrame: hookSelectFrame,
    debugVariables, debugCurrentThreadId, debugConsole, debugLocation, debugThreads,
    debugWatches, addWatch, removeWatch, evaluateRepl, selectThread,
    startDebug, debugControl, syncBreakpoints, expandVariable, resetDebugger,
  } = useDebugger({
    root, rootRef, breakpointsRef, breakpointSpecsRef, setPanelOpen, setPanelView,
    notify, formatError, t,
  })

  const activateWorkspace = useCallback((path: string) => {
    const job = workspaceQueueRef.current.then(async () => {
      const canonical = await command<string>('open_workspace', { root: path })
      workspaceGenerationRef.current += 1
      resetTasks()
      const previousRoot = rootRef.current
      rootRef.current = canonical
      if (previousRoot !== canonical) {
        setProjectGoOverrides({})
        setGoScope('global')
        setProjectStyleReady(false)
      }
      setRoot(canonical)
      setDialog(null)
      setDialogName('')
      setDialogError(null)
      setContext(null)
      setTabContext(null)
      setTabSubmenu(null)
      setNewProjectOpen(false)
      setProjectMenuOpen(false)
      setTree({})
      setRevealPath(null)
      setProjectFiles([])
      setGoModulePath(null)
      setExpanded(new Set([canonical]))
      setTabs([])
      tabsRef.current = []
      openSequenceRef.current += 1
      resetNavigation()
      setOpeningPath(null)
      setActivePath(null)
      setSelectedTreePath(null)
      resetGit()
      setBranchMenu(false)
      resetLsp()
      setRunOptions({})
      setSideView('files')
      setSidebarOpen(true)
      setSplitPath(null)
      resetDebugger()
      setRecentProjects(rememberProject(canonical))
      localStorage.setItem('gomavo.lastWorkspace', canonical)
      await Promise.all([refreshDirectory(canonical), refreshProjectFiles(canonical), refreshGit(canonical), refreshTools()])
      try {
        const mod = await command<string>('read_file', { path: joinPath(canonical, 'go.mod') })
        setGoModulePath(mod.match(/^module\s+(\S+)/m)?.[1] ?? null)
      } catch { setGoModulePath(null) }
    })
    workspaceQueueRef.current = job.catch(() => undefined)
    return job
  }, [cancelPendingNavigation, refreshDirectory, refreshProjectFiles, refreshGit, refreshTools])

  useEffect(() => {
    if (!desktopAvailable) return
    void refreshTools()
    void command<StartupIntent>('startup_intent').then((intent) => {
      if (rootRef.current) return
      if (intent.newProject) { setNewProjectOpen(true); return }
      const path = intent.emptyWindow ? null : intent.workspace ?? localStorage.getItem('gomavo.lastWorkspace')
      if (path) void activateWorkspace(path).catch((cause) => {
        if (!intent.workspace) localStorage.removeItem('gomavo.lastWorkspace')
        else notify(formatError(cause), 'error')
      })
    }).catch((cause) => notify(formatError(cause), 'error'))
  }, [activateWorkspace, formatError, notify, refreshTools])

  const openNewProject = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try {
      if (rootRef.current) await command('open_new_project_window')
      else setNewProjectOpen(true)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, t])

  const openEmptyWindow = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try { await command('open_empty_project_window') }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, t])

  const chooseWorkspace = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try {
      const picked = await open({ directory: true, multiple: false, title: t('选择 Go 项目文件夹') })
      if (typeof picked === 'string') {
        if (rootRef.current) await command('open_project_window', { root: picked })
        else await activateWorkspace(picked)
      }
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [activateWorkspace, formatError, notify, t])

  /** Native menu bar actions dispatch through this ref so they always see the latest callbacks. */
  const menuActionRef = useRef<(id: string, path?: string) => void>(() => undefined)
  useEffect(() => {
    if (!desktopAvailable) return
    let disposed = false
    let unlisten: UnlistenFn[] = []
    const target = getCurrentWebviewWindow().label
    void Promise.all([
      listen<{ id: string; path?: string }>('menu-action', (event) => menuActionRef.current?.(event.payload.id, event.payload.path), { target }),
    ]).then((listeners) => { if (disposed) listeners.forEach((stop) => stop()); else unlisten = listeners })
      .catch((cause) => notify(formatError(cause), 'error'))
    return () => { disposed = true; unlisten.forEach((stop) => stop()) }
  }, [formatError, notify])

  // Keep the native menu bar localized and the Recent Projects submenu current.
  useEffect(() => {
    if (!desktopAvailable) return
    command('set_menu_locale', { locale }).catch(() => undefined)
  }, [desktopAvailable, locale])
  useEffect(() => {
    if (!desktopAvailable) return
    command('set_recent_projects', {
      projects: recentProjects.map((path) => ({ name: displayName(path), path, branch: null })),
    }).catch(() => undefined)
  }, [desktopAvailable, recentProjects])

  // GoLand project code style (.idea/codeStyles/Project.xml), resolved once
  // per workspace and used when .editorconfig does not specify indentation.
  const goLandCodeStyleCacheRef = useRef<{ workspace: string; value: Partial<EditorConfigSettings> } | null>(null)
  const loadEditorConfig = useCallback(async (workspace: string, path: string): Promise<EditorConfigSettings> => {
    try {
      const settings = await resolveEditorConfig(workspace, path, readOptionalEditorConfig)
      if (settings.indentStyle !== undefined && settings.indentSize !== undefined) return settings
      if (goLandCodeStyleCacheRef.current?.workspace !== workspace) {
        let value: Partial<EditorConfigSettings> = {}
        try {
          const xml = await command<string>('read_file', { path: joinPath(workspace, '.idea/codeStyles/Project.xml') })
          value = parseGoLandCodeStyle(xml)
        } catch { /* projects without .idea or GoLand styles simply skip this */ }
        goLandCodeStyleCacheRef.current = { workspace, value }
      }
      return { ...goLandCodeStyleCacheRef.current.value, ...settings }
    }
    catch (cause) {
      if (rootRef.current === workspace) notify(`.editorconfig: ${formatError(cause)}`, 'error')
      return {}
    }
  }, [formatError, notify])

  const refreshOpenEditorConfigs = useCallback(async () => {
    const workspace = rootRef.current
    if (!workspace) return
    const generation = workspaceGenerationRef.current
    const files = tabsRef.current.filter((file) => !file.readOnly && !file.binary)
    const resolved = await Promise.all(files.map(async (file) => [file.path, await loadEditorConfig(workspace, file.path)] as const))
    if (generation !== workspaceGenerationRef.current) return
    const configs = new Map(resolved)
    const next = tabsRef.current.map((file) => configs.has(file.path) ? { ...file, editorConfig: configs.get(file.path) } : file)
    tabsRef.current = next
    setTabs(next)
  }, [loadEditorConfig])

  const openFile = useCallback(async (path: string, options: { preserveNavigation?: boolean } = {}) => {
    if (!options.preserveNavigation) cancelPendingNavigation()
    const sequence = ++openSequenceRef.current
    const workspaceGeneration = workspaceGenerationRef.current
    const existing = tabsRef.current.find((item) => item.path === path)
    if (existing) { setOpeningPath(null); setActivePath(path); if (isWorkspaceFile(root, path)) setSelectedTreePath(path); return true }
    setOpeningPath(path)
    try {
      const external = !isWorkspaceFile(root, path)
      let content: string
      let binary = false
      try {
        content = await command<string>(external ? 'read_go_source' : 'read_file', { path })
        binary = !external && content.includes('\0')
      } catch (cause) {
        if (external || !/valid UTF-8|invalid utf-8/i.test(errorMessage(cause))) throw cause
        binary = true
        content = ''
      }
      if (binary) {
        const preview = await command<BinaryPreview>('read_binary_preview', { path })
        content = formatBinaryPreview(path, preview, localeRef.current)
      }
      const editorConfig = !external && !binary && root ? await loadEditorConfig(root, path) : undefined
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      const current = tabsRef.current.find((item) => item.path === path)
      if (current) {
        if (sequence !== openSequenceRef.current) return false
        setActivePath(path)
        if (isWorkspaceFile(root, path)) setSelectedTreePath(path)
        return true
      }
      // Closing a tab keeps its Monaco model alive (the wrapper only disposes
      // on unmount); drop the stale model so the reopen re-reads from disk.
      const monaco = monacoApi
      const stale = monaco?.editor.getModel(monaco.Uri.parse(fileUri(path)))
      if (stale && stale !== editorRef.current?.getModel() && stale !== splitEditorRef.current?.getModel()) stale.dispose()
      setExternalContent((current) => current[path] === content ? current : { ...current, [path]: content })
      const next = [...tabsRef.current, { path, content, savedContent: content, readOnly: external || binary, binary, editorConfig }]
      if (!external && !binary && localEditHistoryRef.current.ensureFile(path, content)) setLocalHistoryRevision((value) => value + 1)
      tabsRef.current = next
      setTabs(next)
      const selected = sequence === openSequenceRef.current
      if (selected) {
        setActivePath(path)
        if (isWorkspaceFile(root, path)) setSelectedTreePath(path)
      }
      if (path.endsWith('.go') && !binary && lspRef.current) void lspRef.current.openDocument(path, content).catch(() => undefined)
      return selected
    } catch (cause) {
      if (workspaceGeneration === workspaceGenerationRef.current) notify(formatError(cause), 'error')
      return false
    }
    finally { if (sequence === openSequenceRef.current) setOpeningPath(null) }
  }, [cancelPendingNavigation, formatError, loadEditorConfig, monacoApi, notify, root])

  openFileRef.current = openFile

  const createTestsForSource = useCallback(async (sourcePath: string, methodLine?: number) => {
    const workspace = rootRef.current
    if (creatingTestRef.current || !workspace || !isWorkspaceFile(workspace, sourcePath) || !sourcePath.endsWith('.go') || sourcePath.endsWith('_test.go')) return
    creatingTestRef.current = true
    setMutationBusyPath(sourcePath)
    const generation = workspaceGenerationRef.current
    const parent = sourcePath.slice(0, Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')))
    const testPath = `${sourcePath.slice(0, -3)}_test.go`
    try {
      const sourceTab = tabsRef.current.find((file) => file.path === sourcePath)
      if (sourceTab?.readOnly) return
      const sourceModel = editorRef.current?.getModel()
      const source = sourceModel?.uri.toString() === fileUri(sourcePath)
        ? sourceModel.getValue()
        : sourceTab?.content ?? await command<string>('read_file', { path: sourcePath })
      if (generation !== workspaceGenerationRef.current) return
      const targetName = methodLine === undefined ? undefined : goSourceDeclarations(source).find((declaration) => declaration.startLine <= methodLine && methodLine <= declaration.endLine)?.testName
      if (methodLine !== undefined && !targetName) { notify(t('没有可创建的测试方法')); return }

      const openTest = tabsRef.current.find((file) => file.path === testPath)
      if (openTest?.readOnly || openTest?.binary) { notify(t('只读'), 'error'); return }
      const testEntry = openTest ? null : (await command<FileEntry[]>('list_directory', { path: parent })).find((entry) => entry.name === displayName(testPath))
      if (generation !== workspaceGenerationRef.current) return
      const existingTest = openTest?.content ?? (testEntry ? await command<string>('read_file', { path: testPath }) : null)
      if (generation !== workspaceGenerationRef.current) return
      const result = createGoTest(source, existingTest, targetName)
      if (!result) { notify(t('没有可创建的测试方法')); return }

      if (openTest && openTest.content !== openTest.savedContent) {
        applyExternalContent(testPath, result.testFileContent)
        const next = tabsRef.current.map((file) => file.path === testPath ? { ...file, content: result.testFileContent } : file)
        tabsRef.current = next
        setTabs(next)
        if (localEditHistoryRef.current.ensureFile(testPath, result.testFileContent)) setLocalHistoryRevision((value) => value + 1)
        void lspRef.current?.changeDocument(testPath, result.testFileContent).catch(() => undefined)
      } else {
        if (existingTest === null) await command('create_file_with_content', { path: testPath, content: result.testFileContent })
        else await command('write_file', { path: testPath, content: result.testFileContent, expectedContent: existingTest })
        if (generation !== workspaceGenerationRef.current) return
        const currentTest = tabsRef.current.find((file) => file.path === testPath)
        if (currentTest) {
          const merged = currentTest.content === existingTest
            ? result.testFileContent
            : createGoTest(source, currentTest.content, targetName)?.testFileContent ?? currentTest.content
          if (merged !== currentTest.content) applyExternalContent(testPath, merged)
          const next = tabsRef.current.map((file) => file.path === testPath ? { ...file, content: merged, savedContent: result.testFileContent } : file)
          tabsRef.current = next
          setTabs(next)
          if (localEditHistoryRef.current.ensureFile(testPath, merged)) setLocalHistoryRevision((value) => value + 1)
          void (async () => {
            const client = lspRef.current
            if (!client) return
            await client.saveDocument(testPath, result.testFileContent)
            if (merged !== result.testFileContent) await client.changeDocument(testPath, merged)
          })().catch(() => undefined)
        }
      }

      await refreshDirectory(parent)
      if (generation !== workspaceGenerationRef.current) return
      void refreshProjectFiles(workspace)
      void refreshGit(workspace)
      setRevealPath(testPath)
      const opened = await openFile(testPath)
      if (opened && generation === workspaceGenerationRef.current) requestAnimationFrame(() => {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || model?.uri.toString() !== fileUri(testPath)) return
        const declaration = goTestDeclarations(model.getValue()).find((item) => result.createdNames.includes(item.name))
        if (declaration) {
          editor.setPosition({ lineNumber: declaration.startLine, column: 1 })
          editor.revealLineInCenter(declaration.startLine)
        }
        editor.focus()
      })
      notify(t('已创建 {count} 个测试方法', { count: result.createdNames.length }))
    } catch (cause) { if (generation === workspaceGenerationRef.current) notify(formatError(cause), 'error') }
    finally {
      creatingTestRef.current = false
      setMutationBusyPath((current) => current === sourcePath ? null : current)
    }
  }, [applyExternalContent, formatError, notify, openFile, refreshDirectory, refreshGit, refreshProjectFiles, t])

  createTestFromEditorRef.current = (line?: number) => {
    const uri = editorRef.current?.getModel()?.uri.toString()
    if (!uri) return
    const path = tabsRef.current.find((file) => fileUri(file.path) === uri)?.path ?? uriToPath(uri)
    void createTestsForSource(path, line)
  }

  const selectTab = useCallback((path: string) => {
    openSequenceRef.current += 1
    cancelPendingNavigation()
    setActivePath(path)
    if (isWorkspaceFile(root, path)) setSelectedTreePath(path)
  }, [cancelPendingNavigation, root])

  const saveFile = useCallback((path: string): Promise<boolean> => {
    // Read the tab after prior saves complete: repeated shortcuts must use the
    // latest savedContent when the backend checks for external changes.
    const previous = saveQueueRef.current.get(path) ?? Promise.resolve(true)
    const task = previous.then(async () => {
      const initialFile = tabsRef.current.find((item) => item.path === path)
      const saveActions = (effectiveGo.formatOnSave || effectiveGo.organizeImportsOnSave) && path.endsWith('.go') && lspState === 'ready' && !!lspRef.current
      if (!initialFile || (initialFile.content === initialFile.savedContent && !saveActions)) return true
      if (initialFile.readOnly) { notify(t('外部 Go 源码为只读。'), 'error'); return false }
      const generation = workspaceGenerationRef.current
      const workspace = rootRef.current
      try {
        const editorConfig = workspace ? await loadEditorConfig(workspace, path) : initialFile.editorConfig ?? {}
        if (generation !== workspaceGenerationRef.current || workspace !== rootRef.current) return false
        let formatted: string | null = null
        let formattingFailure: unknown = null
        const client = effectiveGo.formatOnSave && path.endsWith('.go') && lspState === 'ready' ? lspRef.current : null
        if (lspRef.current && effectiveGo.organizeImportsOnSave && path.endsWith('.go') && lspState === 'ready') {
          // GoLand "Optimize imports on save": gopls sorts, groups (localPrefix),
          // and drops unused imports before formatting. Only applied when the
          // buffer still matches the organized text — a keystroke during the
          // request wins.
          const before = tabsRef.current.find((item) => item.path === path)
          if (before && !before.readOnly && !before.binary) {
            const organized = await lspRef.current.organizeImports(path, before.content).catch(() => null)
            const latest = organized === null ? null : tabsRef.current.find((item) => item.path === path)
            if (organized !== null && latest && latest.content === before.content && organized !== before.content) applyExternalContent(path, organized)
          }
        }
        if (client) {
          // A formatting request may finish after another keystroke. Only use
          // its result for the exact text it formatted, retrying a few times.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = tabsRef.current.find((item) => item.path === path)
            if (!current || current.readOnly || current.binary) return false
            const snapshot = current.content
            try {
              const options = editorConfigIndentOptions(editorConfig, preferences.editor)
              const result = await client.formatDocument(path, snapshot, options)
              if (generation !== workspaceGenerationRef.current || workspace !== rootRef.current) return false
              const latest = tabsRef.current.find((item) => item.path === path)
              if (!latest || latest.readOnly || latest.binary) return false
              if (latest.content !== snapshot || result === null) continue
              formatted = result
              break
            } catch (cause) {
              formattingFailure = cause
              break
            }
          }
        }
        const file = tabsRef.current.find((item) => item.path === path)
        if (!file || file.readOnly || file.binary || generation !== workspaceGenerationRef.current) return false
        const savedContent = applyEditorConfigToContent(formatted ?? file.content, editorConfig)
        const projectStyle = workspace && path === projectCodeStylePath(workspace)
          ? parseProjectCodeStyle(savedContent)
          : null
        if (savedContent === file.savedContent && file.content === file.savedContent) return true
        await command('write_file', { path, content: savedContent, expectedContent: file.savedContent })
        if (generation !== workspaceGenerationRef.current || workspace !== rootRef.current) return false
        // Formatted (or editorconfig-normalized) text differs from what the
        // model holds: swap it through the model so the caret stays put. Skip
        // when a keystroke landed while the save awaited — the buffer wins.
        if (savedContent !== file.content) {
          const latestBuffer = tabsRef.current.find((item) => item.path === path)
          if (latestBuffer?.content === file.content) applyExternalContent(path, savedContent)
        }
        const next = tabsRef.current.map((item) => item.path === path ? {
          ...item,
          content: item.content === file.content ? savedContent : item.content,
          savedContent,
          editorConfig,
        } : item)
        tabsRef.current = next
        setTabs(next)
        const latest = next.find((item) => item.path === path)
        if (latest && localEditHistoryRef.current.ensureFile(path, latest.content)) setLocalHistoryRevision((value) => value + 1)
        if (path.endsWith('.go')) {
          const client = lspRef.current
          if (client) void (async () => {
            await client.saveDocument(path, savedContent)
            const latest = tabsRef.current.find((item) => item.path === path)
            if (latest && latest.content !== savedContent) await client.changeDocument(path, latest.content)
          })().catch(() => undefined)
        }
        if (displayName(path) === '.editorconfig') void refreshOpenEditorConfigs()
        if (workspace && projectStyle && rootRef.current === workspace) {
          projectStyleLoadRequestRef.current += 1
          projectStyleExternalRevisionRef.current.set(workspace, (projectStyleExternalRevisionRef.current.get(workspace) ?? 0) + 1)
          projectStyleDiskRef.current.set(workspace, savedContent)
          setProjectGoOverrides(projectStyle)
          setGoScope('project')
          setProjectStyleReady(true)
        }
        if (workspace && rootRef.current === workspace) {
          const ignoreRulesChanged = displayName(path) === '.gitignore'
          void refreshGit(workspace, { refreshIgnored: ignoreRulesChanged })
          if (ignoreRulesChanged) void refreshProjectFiles(workspace)
        }
        if (formattingFailure) {
          notify(localeRef.current === 'zh-CN'
            ? `已保存 ${displayName(path)}，但 gopls 格式化失败：${formatError(formattingFailure)}`
            : `Saved ${displayName(path)}, but gopls formatting failed: ${formatError(formattingFailure)}`, 'error')
        } else notify(t('已保存 {name}', { name: displayName(path) }))
        return true
      } catch (cause) {
        const message = errorMessage(cause)
        notify(message.startsWith('Save conflict:') ? t('磁盘上的文件已变化，保存已取消。请关闭并重新打开文件后合并修改。') : formatError(message), 'error')
        return false
      }
    })
    saveQueueRef.current.set(path, task)
    void task.finally(() => { if (saveQueueRef.current.get(path) === task) saveQueueRef.current.delete(path) })
    return task
  }, [applyExternalContent, effectiveGo.formatOnSave, effectiveGo.organizeImportsOnSave, formatError, loadEditorConfig, lspState, notify, preferences.editor, refreshGit, refreshOpenEditorConfigs, refreshProjectFiles, t])

  useEffect(() => {
    if (!desktopAvailable) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    void getCurrentWebviewWindow().onCloseRequested((event) => {
      if (!tabsRef.current.some((file) => file.content !== file.savedContent)) return
      event.preventDefault()
      if (windowClosePromptRef.current) return
      windowClosePromptRef.current = true
      setWindowClosePrompt(true)
    }).then((stopListening) => {
      if (disposed) stopListening()
      else unlisten = stopListening
    }).catch((cause) => notify(formatError(cause), 'error'))
    return () => { disposed = true; unlisten?.() }
  }, [formatError, notify])

  const cancelWindowClose = useCallback(() => {
    if (windowCloseBusyRef.current) return
    windowClosePromptRef.current = false
    setWindowClosePrompt(false)
    // A cancelled app-quit leaves its windows open: release the backend's
    // quitting mark so the session tracks the survivors again.
    if (desktopAvailable) void command('quit_cancelled').catch(() => undefined)
  }, [])

  const finishWindowClose = useCallback(async () => {
    try { await getCurrentWebviewWindow().destroy() }
    catch (cause) {
      windowCloseBusyRef.current = false
      setWindowCloseBusy(false)
      notify(formatError(cause), 'error')
    }
  }, [formatError, notify])

  const saveAndCloseWindow = useCallback(async () => {
    if (windowCloseBusyRef.current) return
    windowCloseBusyRef.current = true
    setWindowCloseBusy(true)
    for (const file of tabsRef.current.filter((item) => item.content !== item.savedContent)) {
      if (!await saveFile(file.path)) { windowCloseBusyRef.current = false; setWindowCloseBusy(false); return }
    }
    if (tabsRef.current.some((file) => file.content !== file.savedContent)) {
      windowCloseBusyRef.current = false
      setWindowCloseBusy(false)
      return
    }
    await finishWindowClose()
  }, [finishWindowClose, saveFile])

  const discardAndCloseWindow = useCallback(async () => {
    if (windowCloseBusyRef.current) return
    windowCloseBusyRef.current = true
    setWindowCloseBusy(true)
    await finishWindowClose()
  }, [finishWindowClose])

  const closeTab = useCallback(async (path: string): Promise<boolean> => {
    if (closingTabsRef.current.has(path)) return false
    closingTabsRef.current.add(path)
    try {
      const file = tabsRef.current.find((item) => item.path === path)
      if (!file) return false
      if (file && file.content !== file.savedContent) {
        const confirmed = await ask(t('{name} 尚未保存。关闭并丢弃修改吗？', { name: displayName(path) }), {
          title: t('关闭未保存文件'), kind: 'warning', okLabel: t('丢弃并关闭'), cancelLabel: t('取消'),
        })

  saveFileRef.current = saveFile
        if (!confirmed) return false
      }
      const index = tabsRef.current.findIndex((item) => item.path === path)
      if (index < 0) return false
      const next = tabsRef.current.filter((item) => item.path !== path)
      tabsRef.current = next
      setTabs(next)
      if (path.endsWith('.go')) void lspRef.current?.closeDocument(path).catch(() => undefined)
      if (activePathRef.current === path || pendingNavigationRef.current?.path === path) cancelPendingNavigation()
      if (activePathRef.current === path) {
        const nextPath = next[Math.min(index, next.length - 1)]?.path ?? null
        activePathRef.current = nextPath
        setActivePath(nextPath)
      }
      return true
    } catch (cause) { notify(formatError(cause), 'error'); return false }
    finally { closingTabsRef.current.delete(path) }
  }, [cancelPendingNavigation, formatError, notify, t])

  const closeTabs = useCallback(async (paths: string[]) => {
    for (const path of paths) if (!await closeTab(path)) break
  }, [closeTab])

  const togglePinnedTab = useCallback((path: string) => {
    const current = tabsRef.current.find((file) => file.path === path)
    if (!current) return
    const next = tabsRef.current.map((file) => file.path === path ? { ...file, pinned: !current.pinned } : file)
    const reordered = [...next.filter((file) => file.pinned), ...next.filter((file) => !file.pinned)]
    tabsRef.current = reordered
    setTabs(reordered)
  }, [])

  const changeFile = useCallback((source: 'main' | 'split', value: Parameters<OnChange>[0], event: Parameters<OnChange>[1]) => {
    if (value === undefined) return
    // Each editor reports its own model. Matching by text can select the wrong
    // file when the main and split panes happen to contain the same content.
    const model = (source === 'main' ? editorRef.current : splitEditorRef.current)?.getModel()
    if (!model || model.getValue() !== value) return
    const modelUri = model.uri.toString()
    const file = tabsRef.current.find((item) => fileUri(item.path) === modelUri)
    if (!file || file.readOnly || file.content === value) return
    if (localEditHistoryRef.current.record(file.path, file.content, value, event)) setLocalHistoryRevision((current) => current + 1)
    const next = tabsRef.current.map((item) => item.path === file.path ? { ...item, content: value } : item)
    tabsRef.current = next
    setTabs(next)
    if (file.path.endsWith('.go')) {
      const client = lspRef.current
      if (!client) return
      // Keystroke edits ride through as incremental changes; anything without
      // change metadata falls back to a full-text sync.
      if (event?.changes?.length) void client.changeDocumentIncremental(file.path, event.changes, value).catch(() => undefined)
      else void client.changeDocument(file.path, value).catch(() => undefined)
    }
  }, [])




  /** GoLand-style context run: the enclosing method, then its test file. */
  const runEditorContext = useCallback((line?: number, fileFallback = true): boolean => {
    const path = activePathRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!path?.endsWith('_test.go') || !editor || !model || model.uri.toString() !== fileUri(path)) return false
    /** Spins the gutter immediately; the state clears once the task exits or per-test events arrive. */
    const launchTest = (options: TaskOptions, testName?: string) => {
      void runSelection('test', options).then((started) => {
        if (started) setPendingTestRun({ path, ...(testName ? { testName } : {}) })
      })
    }
    const currentLine = line ?? editor.getPosition()?.lineNumber
    if (line && !fileFallback && currentLine === goPackageDeclarationLine(model.getValue())) {
      const directory = path.slice(0, path.lastIndexOf('/'))
      launchTest({ scope: 'package', targetPath: directory, label: t('测试 {name} 包', { name: displayName(directory) }) })
      return true
    }
    const declaration = currentLine ? goTestDeclarations(model.getValue()).find((item) => item.startLine <= currentLine && currentLine <= item.endLine) : undefined
    if (declaration) {
      launchTest({ scope: 'file', targetPath: path, testName: declaration.name, label: t('测试 {name}', { name: declaration.name }) }, declaration.name)
      return true
    }
    if (!fileFallback) return false
    launchTest({ scope: 'file', targetPath: path, label: t('测试 {name}', { name: displayName(path) }) })
    return true
  }, [runSelection])
  runEditorContextRef.current = runEditorContext

  // Line-number renderer: hides the number under a breakpoint dot so the dot
  // fully replaces it. Reads refs, so its identity never changes.
  const lineNumbersFormatter = useCallback((lineNumber: number): string => {
    const model = editorRef.current?.getModel()
    const path = model ? tabsRef.current?.find((item) => fileUri(item.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString()) : null
    const marked = path ? breakpointsRef.current[path]?.includes(lineNumber) : false
    return marked ? '' : String(lineNumber)
  }, [])

  const persistBreakpoints = useCallback((next: Record<string, number[]>) => {
    setBreakpoints(next)
    const activePath = activePathRef.current
    if (activePath) void syncBreakpoints(activePath, next[activePath] ?? [])
    // Re-apply the formatter so the number under a new dot hides immediately.
    const formatter = lineNumbersFormatterRef.current
    if (formatter) editorRef.current?.updateOptions({ lineNumbers: formatter })
  }, [lineNumbersFormatter, syncBreakpoints])

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    const current = breakpointsRef.current[path] ?? []
    if (current.includes(line)) {
      persistBreakpoints({ ...breakpointsRef.current, [path]: current.filter((item) => item !== line) })
      // Drop any condition/logMessage spec attached to the removed breakpoint.
      setBreakpointSpecs((currentSpecs) => {
        const fileSpecs = { ...(currentSpecs[path] ?? {}) }
        delete fileSpecs[line]
        const next = { ...currentSpecs, [path]: fileSpecs }
        breakpointSpecsRef.current = next
        return next
      })
    } else {
      persistBreakpoints({ ...breakpointsRef.current, [path]: [...current, line].sort((a, b) => a - b) })
    }
  }, [persistBreakpoints])

  const toggleBookmark = useCallback((path: string, line: number) => {
    setBookmarks((current) => {
      const lines = current[path] ?? []
      const next = lines.includes(line) ? lines.filter((item) => item !== line) : [...lines, line].sort((a, b) => a - b)
      return { ...current, [path]: next }
    })
  }, [])
  toggleBreakpointRef.current = toggleBreakpoint
  lineNumbersFormatterRef.current = lineNumbersFormatter

  /** Project-wide replace finished: sync open tabs and gopls with the new contents. */
  const onReplaced = useCallback(async (results: ReplaceFileResult[]) => {
    for (const result of results) {
      const open = tabsRef.current.find((file) => file.path === result.path)
      if (open) {
        if (open.content === result.before) applyExternalContent(result.path, result.after)
        const updated = tabsRef.current.map((file) => file.path === result.path
          ? { ...file, content: file.content === result.before ? result.after : file.content, savedContent: file.savedContent === result.before ? result.after : file.savedContent }
          : file)
        tabsRef.current = updated
        setTabs(updated)
        if (result.path.endsWith('.go')) void lspRef.current?.changeDocument(result.path, result.after).catch(() => undefined)
      } else if (result.path.endsWith('.go')) {
        void lspRef.current?.openDocument(result.path, result.after).catch(() => undefined)
      }
    }
    const workspace = rootRef.current
    if (workspace) { void refreshProjectFiles(workspace); void refreshGit(workspace) }
    setSearchRevision((value) => value + 1)
  }, [applyExternalContent, lspRef, refreshGit, refreshProjectFiles])

  const openRecentProject = useCallback(async (path: string) => {
    setProjectMenuOpen(false)
    try {
      if (rootRef.current && rootRef.current !== path) await command('open_project_window', { root: path })
      else await activateWorkspace(path)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [activateWorkspace, formatError, notify])

  /** Selecting a saved configuration applies its kind and options to the run widget. */
  const selectRunConfiguration = useCallback((id: string) => {
    const config = preferences.run.runConfigurations.find((item) => item.id === id)
    if (!config) return
    // Bench configurations run as `go test` with a -bench extra.
    setRunConfig(config.kind === 'bench' ? 'test' : config.kind)
    setRunOptions(runConfigurationToOptions(config))
    setPreferences(savePreferences({ ...preferences, run: { ...preferences.run, selectedRunConfigurationId: id } }))
  }, [preferences, setRunConfig, setRunOptions])

  // The stash list loads when the Git tool window opens or the workspace changes.
  useEffect(() => {
    if (sidebarOpen && sideView === 'git' && root) void refreshStash()
  }, [refreshStash, root, sideView, sidebarOpen])

  /** Debug like GoLand ⌃D: the test under the cursor, the test file, or the package. */
  const debugCurrentContext = useCallback(() => {
    const path = activePathRef.current
    if (!path?.endsWith('.go')) {
      notify(localeRef.current === 'zh-CN' ? '请先打开要调试的 Go 文件。' : 'Open a Go file to debug first.', 'error')
      return
    }
    if (path.endsWith('_test.go')) {
      const editor = editorRef.current
      const line = editor?.getPosition()?.lineNumber
      const declaration = line ? goTestDeclarations(editor!.getModel()!.getValue()).find((item) => item.startLine <= line && line <= item.endLine) : undefined
      void startDebug('test', {
        scope: 'package',
        targetPath: path.slice(0, path.lastIndexOf('/')),
        ...(declaration ? { testName: declaration.name } : {}),
        label: declaration ? `调试 ${declaration.name}` : `调试 ${displayName(path)} 测试`,
        envVars: runOptions.envVars,
        buildTags: runOptions.buildTags || undefined,
      })
      return
    }
    void startDebug('debug', {
      scope: 'file',
      targetPath: path,
      label: `调试 ${displayName(path)} 所在包`,
      programArgs: runOptions.programArgs,
      envVars: runOptions.envVars,
      buildTags: runOptions.buildTags || undefined,
    })
  }, [displayName, notify, runOptions.buildTags, runOptions.envVars, runOptions.programArgs, startDebug])

  const packageDirectory = useCallback((packageName: string): string | null => {
    if (!root || !goModulePath) return null
    if (packageName === goModulePath) return root
    if (packageName.startsWith(`${goModulePath}/`)) return joinPath(root, packageName.slice(goModulePath.length + 1))
    return null
  }, [goModulePath, root])

  const locateTest = useCallback(async (packageName: string, testName: string) => {
    const baseName = testName.split('/')[0]
    const directory = packageDirectory(packageName)
    const candidates = projectFiles.filter((entry) => entry.name.endsWith('_test.go') && (!directory || entry.path.slice(0, -entry.name.length - 1) === directory))
    for (const entry of candidates) {
      try {
        const content = tabsRef.current.find((file) => file.path === entry.path)?.content ?? await command<string>('read_file', { path: entry.path })
        const declaration = goTestDeclarations(content).find((item) => item.name === baseName)
        if (declaration) return { path: entry.path, line: declaration.startLine }
      } catch { /* Continue with the remaining test files. */ }
    }
    return null
  }, [packageDirectory, projectFiles])

  const jumpToTest = useCallback(async (packageName: string, testName: string) => {
    const from = captureEditorLocation()
    const source = await locateTest(packageName, testName)
    if (!source) { notify(`未找到 ${testName} 的测试源码。`, 'error'); return }
    await navigateTo({ ...source, column: 6 }, from)
  }, [captureEditorLocation, locateTest, navigateTo, notify])

  const rerunTest = useCallback(async (packageName: string, testName: string) => {
    const source = await locateTest(packageName, testName)
    if (!source) { notify(`未找到 ${testName} 的测试源码。`, 'error'); return }
    const started = await runSelection('test', { scope: 'file', targetPath: source.path, testName, label: t('测试 {name}', { name: testName }) })
    if (started) setPendingTestRun({ path: source.path, testName })
  }, [locateTest, notify, runSelection])

  const toggleFolder = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else { next.add(path); void refreshDirectory(path) }
      return next
    })
  }, [refreshDirectory])

  const closeContextMenu = (restoreFocus = false) => {
    setContext(null)
    setNewSubmenuOpen(false)
    if (restoreFocus) contextTriggerRef.current?.focus()
  }

  const closeTabContextMenu = (restoreFocus = false) => {
    setTabContext(null)
    setTabSubmenu(null)
    if (restoreFocus) tabContextTriggerRef.current?.focus()
  }

  const showTabContextMenu = (path: string, trigger: HTMLButtonElement, x: number, y: number) => {
    if (!tabsRef.current.some((file) => file.path === path)) return
    tabContextTriggerRef.current = trigger
    selectTab(path)
    setContext(null)
    setNewSubmenuOpen(false)
    setModuleMenu(false)
    setConfigMenu(false)
    setBranchMenu(false)
    setProjectMenuOpen(false)
    setTabSubmenu(null)
    setTabContext({ path, x, y })
  }

  const showContextMenu = (entry: FileEntry, parent: string, trigger: HTMLButtonElement, x: number, y: number) => {
    if (mutationBusyPath) return
    contextTriggerRef.current = trigger
    closeTabContextMenu()
    setSelectedTreePath(entry.path)
    setBranchMenu(false)
    setConfigMenu(false)
    setModuleMenu(false)
    setNewSubmenuOpen(false)
    setContext({ entry, parent, x, y, mode: 'context' })
  }

  const showNewMenu = (parent: string, trigger: HTMLButtonElement) => {
    if (mutationBusyPath) return
    const bounds = trigger.getBoundingClientRect()
    contextTriggerRef.current = trigger
    closeTabContextMenu()
    setBranchMenu(false)
    setConfigMenu(false)
    setModuleMenu(false)
    setNewSubmenuOpen(false)
    setContext({ entry: { path: parent, name: displayName(parent), is_dir: true, ignored: false }, parent, x: bounds.left, y: bounds.bottom + 4, mode: 'new' })
  }

  const showDialog = (kind: DialogState['kind'], parent: string, target?: FileEntry, initialName = '') => {
    if (mutationBusyPath) return
    dialogTriggerRef.current = context ? contextTriggerRef.current : tabContext ? tabContextTriggerRef.current : document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDialog({ kind, parent, target })
    setDialogName(kind === 'rename' ? target?.name ?? '' : kind === 'module' ? displayName(parent) : kind === 'workspace' ? 'go.work' : initialName)
    setDialogError(null)
    closeContextMenu()
    closeTabContextMenu()
  }

  const closeDialog = () => {
    if (dialogBusy) return
    setDialog(null)
    setDialogError(null)
    dialogTriggerRef.current?.focus()
  }

  const copyText = async (value: string, successMessage: string) => {
    try {
      let copied = false
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(value); copied = true }
        catch { /* The desktop webview may need the legacy clipboard path. */ }
      }
      if (!copied) {
        const field = document.createElement('textarea')
        field.value = value
        field.style.position = 'fixed'
        field.style.opacity = '0'
        document.body.append(field)
        field.select()
        copied = document.execCommand('copy')
        field.remove()
        if (!copied) throw new Error(t('无法复制路径。'))
      }
      notify(successMessage)
    } catch (cause) { notify(formatError(cause), 'error') }
  }

  const copyEntryPath = async (path: string) => {
    try { await copyText(path, t('已复制路径')) }
    finally { closeContextMenu(true) }
  }

  const copyTabValue = async (value: string) => {
    closeTabContextMenu(true)
    await copyText(value, t('已复制路径'))
  }

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault()
    if (!dialog || dialogBusy) return
    const name = dialogName.trim()
    if (dialog.kind === 'module') {
      if (!/^[A-Za-z0-9._~/-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) { setDialogError(locale === 'zh-CN' ? '请输入有效的 Go 模块路径。' : 'Enter a valid Go module path.'); return }
    } else if (!name || name === '.' || name === '..' || /[\0\\/]/.test(name)) { setDialogError(t('请输入不含路径分隔符的名称。')); return }
    if (dialog.kind === 'rename' && dialog.target?.name === name) { closeDialog(); return }
    const ignoreRulesChanged = (dialog.kind === 'file' && name === '.gitignore')
      || (dialog.kind === 'rename' && (dialog.target?.name === '.gitignore' || name === '.gitignore'))
    setDialogBusy(true)
    setMutationBusyPath(dialog.target?.path ?? dialog.parent)
    setDialogError(null)
    try {
      if (dialog.kind === 'file' || dialog.kind === 'go' || dialog.kind === 'module' || dialog.kind === 'workspace') {
        const fileName = dialog.kind === 'go' ? name.endsWith('.go') ? name : `${name}.go` : dialog.kind === 'module' ? 'go.mod' : dialog.kind === 'workspace' ? 'go.work' : name
        const path = joinPath(dialog.parent, fileName)
        let content = ''
        if (dialog.kind === 'go') {
          const entries = tree[dialog.parent] ?? await command<FileEntry[]>('list_directory', { path: dialog.parent })
          const existing = entries.find((entry) => !entry.is_dir && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) ?? entries.find((entry) => !entry.is_dir && entry.name.endsWith('.go'))
          let packageName = displayName(dialog.parent).replace(/[^\p{L}\p{N}_]/gu, '_') || 'main'
          if (/^\p{N}/u.test(packageName)) packageName = `_${packageName}`
          if (existing) {
            try {
              const source = await command<string>('read_file', { path: existing.path })
              const declared = /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(source)?.[1]
              if (declared) packageName = existing.name.endsWith('_test.go') ? declared.replace(/_test$/, '') : declared
            } catch { /* A new file can still use the directory package name. */ }
          }
          content = `package ${packageName}\n`
        } else if (dialog.kind === 'module' || dialog.kind === 'workspace') {
          const goVersion = /go(\d+)\.(\d+)/.exec(versions?.go ?? '')
          const version = goVersion ? `${goVersion[1]}.${goVersion[2]}` : null
          content = dialog.kind === 'module' ? `module ${name}\n${version ? `\ngo ${version}\n` : ''}` : `go ${version ?? '1.18'}\n`
        }
        await command('create_file', { path })
        if (content) await command('write_file', { path, content, expectedContent: '' })
        await refreshDirectory(dialog.parent)
        if (fileName === '.editorconfig') void refreshOpenEditorConfigs()
        setRevealPath(path)
        await openFile(path)
      } else if (dialog.kind === 'folder') {
        const path = joinPath(dialog.parent, name)
        await command('create_directory', { path })
        await refreshDirectory(dialog.parent)
        setExpanded((current) => new Set(current).add(dialog.parent))
        setRevealPath(path)
        setSelectedTreePath(path)
      } else if (dialog.target) {
        const newPath = joinPath(dialog.parent, name)
        const oldPath = dialog.target.path
        const isAffected = (path: string) => path === oldPath || (dialog.target?.is_dir && path.startsWith(`${oldPath}/`))
        const affected = tabsRef.current.filter((file) => isAffected(file.path))
        await command('rename_path', { from: oldPath, to: newPath })
        const remap = (path: string) => `${newPath}${path.slice(oldPath.length)}`
        const next = tabsRef.current.map((file) => isAffected(file.path) ? { ...file, path: remap(file.path) } : file)
        tabsRef.current = next
        setTabs(next)
        if (activePath && isAffected(activePath)) setActivePath(remap(activePath))
        setSelectedTreePath((current) => current && isAffected(current) ? remap(current) : current)
        setNavigation((current) => current && isAffected(current.path) ? { ...current, path: remap(current.path) } : current)
        if (pendingNavigationRef.current && isAffected(pendingNavigationRef.current.path)) pendingNavigationRef.current = { ...pendingNavigationRef.current, path: remap(pendingNavigationRef.current.path) }
        historyRef.current.remapPaths((path) => isAffected(path) ? remap(path) : path)
        localEditHistoryRef.current.remapPaths((path) => isAffected(path) ? remap(path) : path)
        setLocalHistoryRevision((value) => value + 1)
        setRunOptions((current) => current.targetPath && isAffected(current.targetPath) ? {} : current)
        setGitDiff((current) => current && isAffected(current.path) ? null : current)
        invalidateFileHistory()
        leaveHistoryPanel()
        if (dialog.target.is_dir) {
          setTree((current) => Object.fromEntries(Object.entries(current).map(([directory, entries]) => [
            isAffected(directory) ? remap(directory) : directory,
            entries.map((entry) => isAffected(entry.path) ? { ...entry, path: remap(entry.path) } : entry),
          ])))
          setExpanded((current) => new Set([...current].map((path) => isAffected(path) ? remap(path) : path)))
        }
        await refreshDirectory(dialog.parent)
        if (dialog.target.is_dir || dialog.target.name === '.editorconfig' || name === '.editorconfig') void refreshOpenEditorConfigs()
        setRevealPath(newPath)
        for (const file of affected) {
          if (file.path.endsWith('.go')) await lspRef.current?.closeDocument(file.path).catch(() => undefined)
          const nextPath = remap(file.path)
          if (nextPath.endsWith('.go')) await lspRef.current?.openDocument(nextPath, file.content).catch(() => undefined)
        }
      }
      setDialog(null)
      notify(t(dialog.kind === 'rename' ? '已重命名为 {name}' : '已创建 {name}', { name: dialog.kind === 'go' && !name.endsWith('.go') ? `${name}.go` : dialog.kind === 'module' ? 'go.mod' : dialog.kind === 'workspace' ? 'go.work' : name }))
      if (root) { void refreshGit(root, { refreshIgnored: ignoreRulesChanged }); void refreshProjectFiles(root) }
    } catch (cause) { setDialogError(formatError(cause)) }
    finally { setDialogBusy(false); setMutationBusyPath(null) }
  }

  const deleteEntry = async (entry: FileEntry, parent: string) => {
    if (mutationBusyPath || entry.path === root) return
    closeContextMenu(true)
    const affected = tabsRef.current.filter((file) => file.path === entry.path || (entry.is_dir && file.path.startsWith(`${entry.path}/`)))
    const dirty = affected.filter((file) => file.content !== file.savedContent).length
    try {
      const confirmed = await ask(t(entry.is_dir ? '确定删除 {name} 及其所有内容？{warning}' : '确定删除 {name}？{warning}', {
        name: entry.name,
        warning: dirty ? t('其中 {count} 个文件有未保存修改。', { count: dirty }) : '',
      }), { title: t('确认删除'), kind: 'warning', okLabel: t('删除'), cancelLabel: t('取消') })
      if (!confirmed) return
    } catch (cause) { notify(formatError(cause), 'error'); return }
    setMutationBusyPath(entry.path)
    try {
      await command('delete_path', { path: entry.path })
      const affectedPaths = new Set(affected.map((file) => file.path))
      const next = tabsRef.current.filter((file) => !affectedPaths.has(file.path))
      tabsRef.current = next
      setTabs(next)
      if (activePath && affectedPaths.has(activePath)) setActivePath(next.at(-1)?.path ?? null)
      setSelectedTreePath((current) => current && (current === entry.path || entry.is_dir && current.startsWith(`${entry.path}/`)) ? null : current)
      setNavigation((current) => current && affectedPaths.has(current.path) ? null : current)
      if (pendingNavigationRef.current && affectedPaths.has(pendingNavigationRef.current.path)) cancelPendingNavigation()
      historyRef.current.removePaths((path) => path === entry.path || entry.is_dir && path.startsWith(`${entry.path}/`))
      localEditHistoryRef.current.removePaths((path) => path === entry.path || entry.is_dir && path.startsWith(`${entry.path}/`))
      setLocalHistoryRevision((value) => value + 1)
      refreshHistoryAvailability()
      setRunOptions((current) => current.targetPath && (current.targetPath === entry.path || entry.is_dir && current.targetPath.startsWith(`${entry.path}/`)) ? {} : current)
      setGitDiff((current) => current && (current.path === entry.path || entry.is_dir && current.path.startsWith(`${entry.path}/`)) ? null : current)
      invalidateFileHistory()
      leaveHistoryPanel()
      for (const file of affected) if (file.path.endsWith('.go')) void lspRef.current?.closeDocument(file.path).catch(() => undefined)
      if (entry.is_dir) {
        setTree((current) => Object.fromEntries(Object.entries(current).filter(([path]) => path !== entry.path && !path.startsWith(`${entry.path}/`))))
        setExpanded((current) => new Set([...current].filter((path) => path !== entry.path && !path.startsWith(`${entry.path}/`))))
      }
      await refreshDirectory(parent)
      if (entry.is_dir || entry.name === '.editorconfig') void refreshOpenEditorConfigs()
      if (root) { void refreshGit(root, { refreshIgnored: entry.name === '.gitignore' }); void refreshProjectFiles(root) }
      notify(t('已删除 {name}', { name: entry.name }))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setMutationBusyPath(null) }
  }

  const formatCurrentFile = useCallback(async () => {
    const path = activePathRef.current
    const file = tabsRef.current.find((item) => item.path === path)
    if (!file || !file.path.endsWith('.go') || file.readOnly) {
      notify(localeRef.current === 'zh-CN' ? '请先打开可编辑的 Go 文件。' : 'Open an editable Go file first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(localeRef.current === 'zh-CN' ? 'gopls 尚未就绪，无法格式化当前文件。' : 'gopls is not ready to format this file.', 'error')
      return
    }
    const action = editorRef.current?.getAction('editor.action.formatDocument')
    if (!action?.isSupported()) {
      notify(localeRef.current === 'zh-CN' ? '当前文件没有可用的格式化器。' : 'No formatter is available for this file.', 'error')
      return
    }
    try { await action.run() }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, lspState, notify])

  /** GoLand "Optimize imports" on demand for the active Go file. */
  const organizeCurrentFile = useCallback(async () => {
    const path = activePathRef.current
    const file = tabsRef.current.find((item) => item.path === path)
    if (!file || !file.path.endsWith('.go') || file.readOnly) {
      notify(localeRef.current === 'zh-CN' ? '请先打开可编辑的 Go 文件。' : 'Open an editable Go file first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(localeRef.current === 'zh-CN' ? 'gopls 尚未就绪，无法整理 imports。' : 'gopls is not ready to organize imports.', 'error')
      return
    }
    try {
      const model = editorRef.current?.getModel()
      const source = model && fileUri(file.path) === model.uri.toString() ? model.getValue() : file.content
      const organized = await lspRef.current.organizeImports(file.path, source)
      if (organized !== null && organized !== source) applyExternalContent(file.path, organized)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [applyExternalContent, formatError, lspState, notify])

  /** Run a gopls refactoring (extract/inline) at the cursor. */
  const runRefactor = useCallback(async (kinds: string[], prefer?: RegExp) => {
    const path = activePathRef.current
    const editor = editorRef.current
    const position = editor?.getPosition()
    if (!path?.endsWith('.go') || !editor || !position || editor.getModel()?.uri.toString() !== fileUri(path)) {
      notify(localeRef.current === 'zh-CN' ? '请先把光标放在 Go 代码上。' : 'Place the cursor in Go code first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法运行重构。'), 'error')
      return
    }
    try {
      const selection = editor.getSelection()
      const tryQuery = async (startLine: number, startCol: number, endLine: number, endCol: number) => {
        const actions = await lspRef.current!.codeActionsAtCursor(path, startLine, startCol, kinds, endLine, endCol)
        return actions.filter((action) => {
          const actionKind = action.kind
          return !!actionKind && kinds.some((kind) => actionKind === kind || actionKind.startsWith(`${kind}.`))
        })
      }
      // gopls only offers extract refactorings for a real range that starts on
      // the expression, so with a bare cursor walk the enclosing AST ranges
      // (gopls selectionRange chain) until one yields an action.
      let matching = selection && !selection.isEmpty()
        ? await tryQuery(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn)
        : []
      if (!matching.length) {
        const chain = await lspRef.current!.selectionRanges(path, position.lineNumber, position.column)
        for (const range of chain) {
          matching = await tryQuery(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)
          if (matching.length) break
        }
      }
      if (!matching.length) {
        notify(t('光标处没有可用的重构。'), 'error')
        return
      }
      // gopls serves "Extract variable" and "Extract constant" under the same
      // refactor.extract.constant kind; prefer the requested title when given.
      const chosen = (prefer && matching.find((action) => prefer.test(action.title))) ?? matching[0]
      await lspRef.current.applyCodeAction(chosen)
      notify(t('已应用重构：{name}', { name: chosen.title }))
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, lspState, notify, t])

  /** GoLand ⌥⌘B: open the implementation of the symbol under the cursor. */
  const goToImplementationNow = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const position = editor?.getPosition()
    if (!path || !editor || !position || lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法跳转实现。'), 'error')
      return
    }
    const source = captureEditorLocation()
    if (!source || source.path !== path) return
    const request = navigationRequestRef.current
    try {
      const target = await lspRef.current.goToImplementation(path, position.lineNumber, position.column)
      if (request !== navigationRequestRef.current || activePathRef.current !== path) return
      if (!target) { notify(t('未找到实现。'), 'error'); return }
      await navigateTo(target, source)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [captureEditorLocation, formatError, lspState, navigateTo, navigationRequestRef, notify, t])

  /** ⇧⌘T: jump between a function and its test (GoLand Go to Test). */
  const goToTestNow = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!path?.endsWith('.go') || !editor || !model) return
    const line = position?.lineNumber
    if (path.endsWith('_test.go')) {
      const sourcePath = `${path.slice(0, -8)}.go`
      let source = tabsRef.current.find((file) => file.path === sourcePath)?.content ?? null
      if (source === null) {
        source = await command<string>('read_file', { path: sourcePath }).catch(() => null)
      }
      if (source === null) { notify(t('未找到对应的源码文件。'), 'error'); return }
      const testName = line ? goTestDeclarations(model.getValue()).find((item) => item.startLine <= line && line <= item.endLine)?.name : undefined
      const baseName = testName?.replace(/^Test/, '') ?? ''
      const declaration = baseName ? goSourceDeclarations(source).find((item) => item.name === baseName) : undefined
      await navigateTo({ path: sourcePath, line: declaration?.startLine ?? 1, column: 1 }, captureEditorLocation())
      return
    }
    const testName = line ? goSourceDeclarations(model.getValue()).find((item) => item.startLine <= line && line <= item.endLine)?.testName : undefined
    if (!testName) { notify(t('光标处没有函数。'), 'error'); return }
    const testPath = `${path.slice(0, -3)}_test.go`
    let testSource = tabsRef.current.find((file) => file.path === testPath)?.content ?? null
    if (testSource === null) {
      testSource = await command<string>('read_file', { path: testPath }).catch(() => null)
    }
    if (testSource === null) {
      notify(t('还没有测试文件，正在生成…'))
      createTestFromEditorRef.current?.(line)
      return
    }
    const declaration = goTestDeclarations(testSource).find((item) => item.name === testName)
      ?? goTestDeclarations(testSource).find((item) => item.name.startsWith(`${testName}/`))
    await navigateTo({ path: testPath, line: declaration?.startLine ?? 1, column: 1 }, captureEditorLocation())
  }, [captureEditorLocation, navigateTo, notify, t])

  /** ⌥F7: Find Usages into the bottom tool window. */
  const runFindUsages = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position || !path) return
    const word = model.getWordAtPosition(position)
    if (!word) { notify(t('光标处没有可查找的符号。'), 'error'); return }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法查找用法。'), 'error')
      return
    }
    setPanelView('usages')
    setPanelOpen(true)
    setUsages({ identifier: word.word, items: [] })
    setUsagesBusy(true)
    try {
      const items = await lspRef.current.findUsages(path, position.lineNumber, position.column)
      setUsages({ identifier: word.word, items })
    } catch (cause) {
      setUsages({ identifier: word.word, items: [] })
      notify(formatError(cause), 'error')
    } finally { setUsagesBusy(false) }
  }, [formatError, lspState, notify, t])

  /** One Generate-menu entry: constructor/getter/setter insert, struct tags rewrite, tests. */
  const runGenerate = useCallback((kind: 'constructor' | 'getter' | 'setter' | 'tag-json' | 'tag-yaml' | 'tag-db' | 'test', structName?: string) => {
    const editor = editorRef.current
    const path = activePathRef.current
    const model = editor?.getModel()
    if (!editor || !model || !path?.endsWith('.go')) { notify(t('光标处没有可生成的代码。'), 'error'); return }
    if (kind === 'test') { createTestFromEditorRef.current?.(); return }
    const source = model.getValue()
    const structs = goStructs(source)
    if (!structName) {
      if (structs.length === 1) { runGenerate(kind, structs[0].name); return }
      notify(t('当前文件没有可操作的 struct。'), 'error')
      return
    }
    if (kind === 'tag-json' || kind === 'tag-yaml' || kind === 'tag-db') {
      const scheme: StructTagScheme = kind === 'tag-json' ? 'json' : kind === 'tag-yaml' ? 'yaml' : 'db'
      const result = generateStructTags(source, structName, scheme)
      if (!result || result.nextContent === source) { notify(t('没有可标注的字段。'), 'error'); return }
      applyExternalContent(path, result.nextContent)
      const next = tabsRef.current.map((item) => item.path === path ? { ...item, content: result.nextContent } : item)
      tabsRef.current = next
      setTabs(next)
      if (localEditHistoryRef.current.record(path, source, result.nextContent)) setLocalHistoryRevision((value) => value + 1)
      void lspRef.current?.changeDocument(path, result.nextContent).catch(() => undefined)
      return
    }
    const generator = kind === 'constructor'
      ? (text: string) => generateConstructor(text, structName)
      : kind === 'getter'
        ? (text: string) => generateGetters(text, structName)
        : (text: string) => generateSetters(text, structName)
    insertGenerated(editor, generator)
    notify(t('已生成 {label}', { label: structName }))
  }, [applyExternalContent, notify, t])

  /** Code Cleanup: organize imports + reformat every open Go file, then save. */
  const codeCleanup = useCallback(async () => {
    const client = lspRef.current
    if (lspState !== 'ready' || !client) { notify(t('gopls 尚未就绪，无法代码清理。'), 'error'); return }
    const targets = tabsRef.current.filter((file) => file.path.endsWith('.go') && !file.readOnly && !file.binary)
    if (!targets.length) { notify(t('没有可清理的 Go 文件。')); return }
    let changed = 0
    const updates = new Map<string, string>()
    for (const file of targets) {
      let content = file.content
      const organized = await client.organizeImports(file.path, content).catch(() => null)
      if (organized !== null) content = organized
      const formatted = await client.formatDocument(file.path, content, {
        tabSize: activeIndentOptions.tabSize, insertSpaces: activeIndentOptions.insertSpaces,
      }).catch(() => null)
      if (formatted !== null) content = formatted
      if (content !== file.content) { updates.set(file.path, content); changed += 1 }
    }
    if (updates.size) {
      for (const [path, content] of updates) applyExternalContent(path, content)
      const next = tabsRef.current.map((item) => updates.has(item.path) ? { ...item, content: updates.get(item.path)! } : item)
      tabsRef.current = next
      setTabs(next)
      let historyChanged = false
      for (const [path, content] of updates) {
        if (localEditHistoryRef.current.ensureFile(path, content)) historyChanged = true
      }
      if (historyChanged) setLocalHistoryRevision((value) => value + 1)
      for (const [path, content] of updates) {
        if (path.endsWith('.go')) void lspRef.current?.changeDocument(path, content).catch(() => undefined)
      }
    }
    for (const file of targets) await saveFile(file.path)
    notify(changed ? t('代码清理完成，更新了 {count} 个文件。', { count: changed }) : t('代码清理完成'))
  }, [activeIndentOptions, applyExternalContent, lspState, notify, saveFile, t])

  /** Save the breakpoint condition/logMessage dialog back to the spec map. */
  const saveBreakpointEdit = useCallback(() => {
    if (!breakpointEdit) return
    const condition = breakpointEdit.condition.trim()
    const logMessage = breakpointEdit.logMessage.trim()
    setBreakpointSpecs((current) => {
      const fileSpecs = { ...(current[breakpointEdit.path] ?? {}) }
      if (condition || logMessage) fileSpecs[breakpointEdit.line] = { ...(condition ? { condition } : {}), ...(logMessage ? { logMessage } : {}) }
      else delete fileSpecs[breakpointEdit.line]
      const next = { ...current, [breakpointEdit.path]: fileSpecs }
      breakpointSpecsRef.current = next
      return next
    })
    const edited = breakpointEdit
    setBreakpointEdit(null)
    void syncBreakpoints(edited.path, breakpointsRef.current[edited.path] ?? [])
  }, [breakpointEdit, syncBreakpoints])

  const submitLineJump = useCallback(() => {
    const match = /^(\d+)(?::(\d+))?$/.exec(lineJumpDraft.trim())
    if (match && activePathRef.current) {
      void navigateTo({ path: activePathRef.current, line: Number(match[1]), column: match[2] ? Number(match[2]) : 1 }, null)
    }
    setLineJumpOpen(false)
    setLineJumpDraft('')
  }, [lineJumpDraft, navigateTo])

  useEffect(() => {
    if (lineJumpOpen) lineJumpInputRef.current?.focus()
  }, [lineJumpOpen])

  /** Structure tool window: outline of the active file via gopls. */
  useEffect(() => {
    if (sideView !== 'structure') return
    const path = activePath
    const file = tabs.find((item) => item.path === path)
    if (!path || !file || file.binary || !path.endsWith('.go') || lspState !== 'ready' || !lspRef.current) {
      setStructureSymbols([])
      return
    }
    setStructureLoading(true)
    const timer = window.setTimeout(() => {
      void lspRef.current?.documentSymbols(path, file.content)
        .then((symbols) => setStructureSymbols(symbols ?? []))
        .catch(() => setStructureSymbols([]))
        .finally(() => setStructureLoading(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [activeFileContent, activePath, lspState, sideView, tabs])

  /** Intention palette: all code actions at the cursor, listed by title. */
  useEffect(() => {
    if (!paletteOpen || paletteMode !== 'intentions') { setIntentionItems([]); return }
    const path = activePathRef.current
    const editor = editorRef.current
    const position = editor?.getPosition()
    if (!path || !position || lspState !== 'ready' || !lspRef.current) return
    const timer = window.setTimeout(() => {
      void lspRef.current?.codeActionsAtCursor(path, position.lineNumber, position.column)
        .then(setIntentionItems)
        .catch(() => setIntentionItems([]))
    }, 120)
    return () => window.clearTimeout(timer)
  }, [lspState, paletteMode, paletteOpen])

  /** Shared dispatcher for keyboard shortcuts and native menu items. */
  const runShortcutAction = useCallback((action: ShortcutAction) => {
    switch (action) {
      case 'searchEverywhere': openPalette(); break
      case 'quickOpen': openPalette('files'); break
      case 'findAction': openPalette('actions'); break
      case 'findInFiles':
      case 'toggleSearch': setPanelView('search'); setPanelOpen((value) => panelView === 'search' ? !value : true); break
      case 'recentFiles': openPalette('recent'); break
      case 'symbolSearch': openPalette('symbols'); break
      case 'toggleProject': setSideView('files'); setSidebarOpen((value) => sideView === 'files' ? !value : true); break
      case 'toggleGit': setSideView('git'); setSidebarOpen((value) => sideView === 'git' ? !value : true); if (root) void refreshGit(root, { refreshIgnored: true }); break
      case 'toggleStructure': setSideView('structure'); setSidebarOpen((value) => sideView === 'structure' ? !value : true); break
      case 'toggleBookmarks': setSideView('bookmarks'); setSidebarOpen((value) => sideView === 'bookmarks' ? !value : true); break
      case 'toggleTodoPanel': setPanelView('todo'); setPanelOpen((value) => panelView === 'todo' ? !value : true); break
      case 'toggleTerminal': setPanelView('terminal'); setPanelOpen((value) => panelView === 'terminal' ? !value : true); break
      case 'toggleRun': setPanelView('output'); setPanelOpen((value) => panelView === 'output' ? !value : true); break
      case 'toggleProblems': setPanelView('problems'); setPanelOpen((value) => panelView === 'problems' ? !value : true); break
      case 'toggleDebugPanel': setPanelView('debug'); setPanelOpen((value) => panelView === 'debug' ? !value : true); break
      case 'goToDefinition': if (activePath) void goToDefinition(); break
      case 'goToImplementation': void goToImplementationNow(); break
      case 'goToTest': void goToTestNow(); break
      case 'findUsages': void runFindUsages(); break
      case 'jumpToLine': setLineJumpDraft(''); setLineJumpOpen(true); break
      case 'generate': openPalette('generate'); break
      case 'navigateBack': void navigateHistory('back'); break
      case 'navigateForward': void navigateHistory('forward'); break
      case 'toggleBookmark': {
        const editor = editorRef.current
        const position = editor?.getPosition()
        if (editor && position && activePathRef.current) toggleBookmark(activePathRef.current, position.lineNumber)
        break
      }
      case 'saveCurrent': if (activePathRef.current) void saveFile(activePathRef.current); break
      case 'saveAll': for (const file of tabsRef.current.filter((item) => item.content !== item.savedContent)) void saveFile(file.path); break
      case 'run': {
        // GoLand before-launch chain: tidy/build first, then the main task.
        const beforeLaunch = preferences.run.runConfigurations.find((item) => item.id === preferences.run.selectedRunConfigurationId)?.beforeLaunch ?? 'none'
        const launch = () => { if (!runEditorContextRef.current?.()) void runTask(runConfig, runOptions) }
        if (beforeLaunch === 'tidy') void runTaskAwaiting('mod_tidy').then((ok) => { if (ok) launch() })
        else if (beforeLaunch === 'build') void runTaskAwaiting('build').then((ok) => { if (ok) launch() })
        else launch()
        break
      }
      case 'debug': debugCurrentContext(); break
      case 'testAll': void runTask('test'); break
      case 'runWithCoverage': void runTask('test', { ...(lastTestOptionsRef.current || {}), coverage: true, label: t('覆盖率 · {name}', { name: lastTestOptionsRef.current?.label ?? 'go test ./...' }) }); break
      case 'build': void runTask('build'); break
      case 'stop':
        if (runningTask) void command('task_cancel', { id: runningTask }).catch((cause) => notify(formatError(cause), 'error'))
        else if (debugState !== 'idle') void debugControl('disconnect')
        break
      case 'format': void formatCurrentFile(); break
      case 'goModTidy': void runTask('mod_tidy'); break
      case 'openSettings': setSettingsSection('editor'); setSettingsOpen(true); break
    }
  }, [activePath, debugControl, debugCurrentContext, debugState, formatCurrentFile, formatError, goToDefinition, goToImplementationNow, goToTestNow, lastTestOptionsRef, navigateHistory, notify, openPalette, panelView, preferences.run.runConfigurations, preferences.run.selectedRunConfigurationId, refreshGit, root, runConfig, runFindUsages, runOptions, runTask, runTaskAwaiting, runningTask, saveFile, setPanelOpen, setPanelView, setSettingsOpen, setSettingsSection, setSideView, setSidebarOpen, sideView, t, toggleBookmark])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (windowClosePrompt) {
        if (event.key === 'Escape' && !windowCloseBusy) { event.preventDefault(); cancelWindowClose() }
        else if (event.metaKey && event.key.toLowerCase() === 's') event.preventDefault()
        return
      }
      if (event.target instanceof Element && event.target.closest('[data-settings-pane], [data-plugins-pane]')) return
      if (event.key === 'Escape') {
        if (context) { event.preventDefault(); closeContextMenu(true) }
        if (tabContext) { event.preventDefault(); closeTabContextMenu(true) }
        if (dialog && !dialogBusy) { event.preventDefault(); closeDialog() }
        if (paletteOpen) { event.preventDefault(); closePalette() }
        setModuleMenu(false)
        setConfigMenu(false)
        setBranchMenu(false)
        setProjectMenuOpen(false)
        return
      }
      if (dialog || paletteOpen || context || tabContext || newProjectOpen) return
      const binding = shortcutFromKeyboardEvent(event)
      const action = shortcutMatcherRef.current(event, preferences.shortcuts)
        ?? (binding === 'Meta+BracketLeft' && preferences.shortcuts.navigateBack === DEFAULT_SHORTCUTS.navigateBack ? 'navigateBack' : null)
        ?? (binding === 'Meta+BracketRight' && preferences.shortcuts.navigateForward === DEFAULT_SHORTCUTS.navigateForward ? 'navigateForward' : null)
      if (!action) return
      if (event.target instanceof Element && event.target.closest('.xterm') && action !== 'toggleTerminal') return
      event.preventDefault()
      // Stop the event from reaching Monaco's own bindings (F3 = find next),
      // which otherwise fire alongside the app action.
      event.stopPropagation()
      runShortcutAction(action)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancelWindowClose, closeContextMenu, closeDialog, closePalette, closeTabContextMenu, context, dialog, dialogBusy, newProjectOpen, paletteOpen, preferences.shortcuts, runShortcutAction, setBranchMenu, setConfigMenu, setModuleMenu, setProjectMenuOpen, tabContext, windowCloseBusy, windowClosePrompt])

  useEffect(() => {
    if (!context && !tabContext && !moduleMenu && !configMenu && !branchMenu && !projectMenuOpen) return
    const close = () => { setContext(null); setTabContext(null); setTabSubmenu(null); setModuleMenu(false); setConfigMenu(false); setBranchMenu(false); setProjectMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [context, tabContext, moduleMenu, configMenu, branchMenu, projectMenuOpen])

  const beforeEditorMount = useCallback((monaco: typeof Monaco) => {
    defineGomavoTheme(monaco)
    registerGoSuffixCompletions(monaco)
    registerGoTemplates(monaco)
  }, [])

  const installGoNavigation = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    const navigation = installModifierNavigation({
      editor, monaco,
      getClient: () => lspRef.current,
      navigate: async (target, clicked) => {
        const source = captureEditorLocation(editor)
        await navigateTo(target, source ? { ...source, line: clicked.line, column: clicked.column } : clicked)
      },
      showReferences: (name, references) => {
        setUsages({ identifier: name, items: references })
        setUsagesBusy(false)
        setPanelView('usages')
        setPanelOpen(true)
      },
      reportError: (error) => notify(formatError(error), 'error'),
      linkHint: (atDeclaration) => localeRef.current === 'zh-CN'
        ? atDeclaration ? '⌘ 点击查看引用' : '⌘ 点击跳转定义'
        : atDeclaration ? '⌘ click to find references' : '⌘ click to go to definition',
    })
    editor.onDidDispose(() => navigation.dispose())
  }, [captureEditorLocation, formatError, navigateTo, notify])

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    setMonacoApi(monaco)
    installGoNavigation(editor, monaco)
    installGoTodoDecorations(editor, monaco)
    const testFileContext = editor.createContextKey<boolean>('gomavoGoTestFile', false)
    const sourceFileContext = editor.createContextKey<boolean>('gomavoGoSourceFile', false)
    const sourceMethodContext = editor.createContextKey<boolean>('gomavoGoSourceMethod', false)
    const gitFileContext = editor.createContextKey<boolean>('gomavoGitWorkspaceFile', false)
    const updateGoContexts = (line = editor.getPosition()?.lineNumber) => {
      const model = editor.getModel()
      const file = model ? tabsRef.current.find((item) => fileUri(item.path) === model.uri.toString()) : null
      const path = file?.path ?? (model ? uriToPath(model.uri.toString()) : null)
      const eligible = !!path && !!file && !file.readOnly && !file.binary && path.endsWith('.go') && !path.endsWith('_test.go') && isWorkspaceFile(rootRef.current, path)
      testFileContext.set(path?.endsWith('_test.go') ?? false)
      sourceFileContext.set(eligible)
      sourceMethodContext.set(eligible && !!line && goSourceDeclarations(model!.getValue()).some((item) => item.startLine <= line && line <= item.endLine))
      gitFileContext.set(!!file && !!path && isWorkspaceFile(rootRef.current, path))
      createTestContextLineRef.current = line ?? null
    }
    updateGoContexts()
    editor.onDidChangeModel(() => updateGoContexts())
    // updateGoContexts scans the whole file for declarations; coalesce the
    // per-keystroke and per-cursor-move calls into one parse per frame.
    let goContextsFrame = 0
    let goContextsLine: number | undefined
    const scheduleGoContexts = (line?: number) => {
      goContextsLine = line
      if (goContextsFrame) return
      goContextsFrame = requestAnimationFrame(() => {
        goContextsFrame = 0
        updateGoContexts(goContextsLine)
      })
    }
    editor.onDidChangeModelContent(() => scheduleGoContexts())
    editor.addAction({
      id: 'gomavo.run-go-test-context',
      label: '运行光标处测试方法或当前测试文件',
      precondition: 'gomavoGoTestFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => { runEditorContextRef.current?.() },
    })
    // GoLand-style ⌥⏎ opens the quick-fix menu: macOS input methods swallow
    // Monaco's built-in ⌘. while a CJK layout is active. editor.action.quickFix
    // is an Action2 invisible to editor.getAction, so trigger the underlying
    // EditorCommand directly.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
      void editor.trigger('gomavo', 'editor.action.codeAction', { kind: 'quickfix' })
    }, '!suggestWidgetVisible')
    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column })
      scheduleGoContexts(event.position.lineNumber)
    })
    editor.onDidChangeModel(() => requestAnimationFrame(applyNavigation))
    const editorHost = editor.getContainerDomNode()
    const prepareContextMenu = (event: MouseEvent) => {
      // Monaco's own context-menu listener is registered before onMount runs.
      // Capture the DOM event so its action preconditions reflect this line
      // on the first right click, including keyboard-triggered menus.
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
      updateGoContexts(target?.position?.lineNumber ?? editor.getPosition()?.lineNumber)
    }
    editorHost.addEventListener('contextmenu', prepareContextMenu, true)
    editor.onDidDispose(() => editorHost.removeEventListener('contextmenu', prepareContextMenu, true))
    // Breakpoint dots overlay the line-number position (GoLand style): slide
    // the glyph-lane dot right by the gutter offset and hide numbers on marked
    // lines so the dot replaces them.
    const applyGutterShift = () => {
      const layout = editor.getLayoutInfo()
      // Center the dot on the start of the (left-aligned) number area.
      const shift = Math.max(0, Math.round(layout.glyphMarginWidth - 8))
      editor.getContainerDomNode().style.setProperty('--mg-bp-shift', `${shift}px`)
    }
    applyGutterShift()
    const layoutObserver = new ResizeObserver(applyGutterShift)
    layoutObserver.observe(editor.getContainerDomNode())
    editor.onDidDispose(() => layoutObserver.disconnect())
    editor.onMouseDown((event) => {
      if (event.event.rightButton) {
        updateGoContexts(event.target.position?.lineNumber ?? editor.getPosition()?.lineNumber)
        return
      }
      const hitElement = event.event.target instanceof Element ? event.event.target : null
      const inGutter = event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
        || event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        || event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
        || (hitElement?.closest('.glyph-margin-widgets, .line-decorations, .margin-view-overlays') != null)
      if (!inGutter) return
      // Folding arrows and our own test-run icons keep their own actions.
      const onFunctionIcon = !!hitElement?.closest('[class*="folding-"], .go-test-gutter, .go-package-gutter')
      let line = event.target.position?.lineNumber
      if (!line) {
        const { clientX, clientY } = event.event.browserEvent
        const resolved = editor.getTargetAtClientPoint(clientX, clientY)
        line = resolved?.position?.lineNumber
      }
      if (!line) return
      // Test files: the run icons (and the rest of the row, matching the old
      // gutter behavior) run the test under the line. Source files: any click
      // in the gutter row toggles a breakpoint, GoLand-style.
      const model = editor.getModel()
      const path = model ? tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path : null
      if (path?.endsWith('_test.go')) {
        if (onFunctionIcon || !path.slice(0, path.lastIndexOf('/')).includes('/')) runEditorContextRef.current?.(line, false)
        else runEditorContextRef.current?.(line, false)
        return
      }
      if (path?.endsWith('.go') && !onFunctionIcon) toggleBreakpointRef.current?.(path, line)
    })
  }, [applyNavigation, installGoNavigation])

  const onSplitEditorMount: OnMount = useCallback((editor, monaco) => {
    splitEditorRef.current = editor
    installGoNavigation(editor, monaco)
    installGoTodoDecorations(editor, monaco)
  }, [installGoNavigation])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monacoApi) return
    const methodAction = editor.addAction({
      id: 'gomavo.create-go-method-test',
      label: t('创建测试方法'),
      precondition: 'gomavoGoSourceFile && gomavoGoSourceMethod',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => { createTestFromEditorRef.current?.(createTestContextLineRef.current ?? editor.getPosition()?.lineNumber) },
    })
    const fileAction = editor.addAction({
      id: 'gomavo.create-go-file-tests',
      label: t('创建文件测试方法'),
      precondition: 'gomavoGoSourceFile && !gomavoGoSourceMethod',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => { createTestFromEditorRef.current?.() },
    })
    const historyAction = editor.addAction({
      id: 'gomavo.show-file-git-history',
      label: t('查看文件历史'),
      precondition: 'gomavoGitWorkspaceFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: () => {
        const model = editor.getModel()
        if (!model) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path
        if (path && isWorkspaceFile(rootRef.current, path)) openGitFileHistoryRef.current?.(path)
      },
    })
    const goFileContext = editor.createContextKey<boolean>('gomavoGoAnyFile', false)
    const syncAnyGoFile = () => {
      const model = editor.getModel()
      goFileContext.set(!!model && model.uri.scheme === 'file' && model.uri.path.endsWith('.go'))
    }
    syncAnyGoFile()
    const modelListener = editor.onDidChangeModel(syncAnyGoFile)
    const breakpointAction = editor.addAction({
      id: 'gomavo.toggle-breakpoint',
      label: t('切换断点'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'debug',
      contextMenuOrder: 1,
      // F9 stays unbound here: the global shortcut already handles it, and a
      // Monaco binding would double-fire the toggle (net zero).
      run: (_editor) => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        toggleBreakpoint(path, position.lineNumber)
      },
    })
    const bookmarkAction = editor.addAction({
      id: 'gomavo.toggle-bookmark',
      label: t('切换书签'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 4,
      run: () => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        toggleBookmark(path, position.lineNumber)
      },
    })
    const blameAction = editor.addAction({
      id: 'gomavo.git-blame',
      label: t('Git Blame（按行）'),
      precondition: 'gomavoGitWorkspaceFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 5,
      run: () => {
        const model = editor.getModel()
        if (!model) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path
        if (path && isWorkspaceFile(rootRef.current, path)) {
          if (gitBlame?.path === path) setGitBlame(null)
          else void openGitBlame(path)
        }
      },
    })
    const findUsagesAction = editor.addAction({
      id: 'gomavo.find-usages',
      label: t('查找用法'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 6,
      // No editor keybinding here: the global ⌥F7 shortcut already dispatches
      // through the preferences matcher, and a second binding fires it twice.
      run: () => { void runFindUsages() },
    })
    const extractVariableAction = editor.addAction({
      id: 'gomavo.refactor-extract-variable',
      label: locale === 'zh-CN' ? '重构：提取变量…' : 'Refactor: Extract Variable…',
      precondition: 'gomavoGoAnyFile && !editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
      run: () => { void runRefactor(['refactor.extract.variable', 'refactor.extract.constant'], /variable/i) },
    })
    const extractFunctionAction = editor.addAction({
      id: 'gomavo.refactor-extract-function',
      label: locale === 'zh-CN' ? '重构：提取函数…' : 'Refactor: Extract Function…',
      precondition: 'gomavoGoAnyFile && !editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 3,
      run: () => { void runRefactor(['refactor.extract.function', 'refactor.extract.method']) },
    })
    const goToImplementationAction = editor.addAction({
      id: 'gomavo.go-to-implementation',
      label: t('跳转到实现'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 7,
      run: () => { void goToImplementationNow() },
    })
    const goToTestAction = editor.addAction({
      id: 'gomavo.go-to-test',
      label: t('转到测试（或被测代码）'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 8,
      run: () => { void goToTestNow() },
    })
    const generateAction = editor.addAction({
      id: 'gomavo.generate-menu',
      label: t('Generate 生成…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 0,
      run: () => { openPalette('generate') },
    })
    const editBreakpointAction = editor.addAction({
      id: 'gomavo.edit-breakpoint',
      label: t('编辑断点条件'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'debug',
      contextMenuOrder: 2,
      run: () => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        const spec = breakpointSpecsRef.current[path]?.[position.lineNumber]
        setBreakpointEdit({
          path, line: position.lineNumber,
          condition: spec?.condition ?? '',
          logMessage: spec?.logMessage ?? '',
        })
      },
    })
    const constructorAction = editor.addAction({
      id: 'gomavo.generate-constructor',
      label: t('生成构造函数…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 1,
      run: () => insertGenerated(editor, (source) => {
        const structs = goStructs(source)
        if (structs.length !== 1) return null
        return generateConstructor(source, structs[0].name)
      }),
    })
    const gettersAction = editor.addAction({
      id: 'gomavo.generate-getters',
      label: t('生成 Getter 方法…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 2,
      run: () => insertGenerated(editor, (source) => {
        const structs = goStructs(source)
        if (structs.length !== 1) return null
        return generateGetters(source, structs[0].name)
      }),
    })
    return () => {
      methodAction.dispose(); fileAction.dispose(); historyAction.dispose()
      breakpointAction.dispose(); bookmarkAction.dispose(); blameAction.dispose()
      constructorAction.dispose(); gettersAction.dispose(); modelListener.dispose()
      findUsagesAction.dispose(); extractVariableAction.dispose(); extractFunctionAction.dispose()
      goToImplementationAction.dispose(); goToTestAction.dispose()
      generateAction.dispose(); editBreakpointAction.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoApi, t, locale, gitBlame?.path, toggleBreakpoint, toggleBookmark, runFindUsages, runRefactor, goToImplementationNow, goToTestNow])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monacoApi) return
    const applyIndentOptions = () => {
      const model = editor.getModel()
      if (!model) return
      const file = tabsRef.current.find((item) => fileUri(item.path) === model.uri.toString())
      model.updateOptions(editorConfigIndentOptions(file?.editorConfig ?? {}, preferences.editor))
    }
    applyIndentOptions()
    const modelChange = editor.onDidChangeModel(applyIndentOptions)
    return () => modelChange.dispose()
  }, [activeFile?.editorConfig, activeFile?.path, monacoApi, preferences.editor])

  // A pending gutter run clears when the task exits; per-test `run` events take
  // over the spinner as soon as `go test` starts reporting.
  useEffect(() => { if (!runningTask) setPendingTestRun(null) }, [runningTask])

  useEffect(() => {
    if (!activeFile?.path.endsWith('_test.go') || !editorRef.current || !monacoApi) return
    const editor = editorRef.current
    const directory = activeFile.path.slice(0, activeFile.path.lastIndexOf('/'))
    let packageName = testResults.find((result) => packageDirectory(result.package) === directory)?.package
    if (!packageName) {
      const lastRun = lastTestOptionsRef.current
      const onePackage = [...new Set(testResults.map((result) => result.package))]
      if (onePackage.length === 1 && ((lastRun.scope === 'file' && lastRun.targetPath === activeFile.path) || (lastRun.scope === 'package' && lastRun.targetPath === directory))) packageName = onePackage[0]
    }
    const resultByName = new Map(testResults.filter((result) => result.package === packageName && result.name !== '(package)').map((result) => [result.name, result.status]))
    const pending = pendingTestRun?.path === activeFile.path ? pendingTestRun : null
    const decorations = editor.createDecorationsCollection([])
    const update = () => {
      const model = editor.getModel()
      if (!model || model.uri.toString() !== fileUri(activeFile.path)) { decorations.clear(); return }
      const matches: Monaco.editor.IModelDeltaDecoration[] = []
      // Monaco's code-action lightbulb uses the left lane; sharing it keeps the margin one lane wide.
      if (activePackageLine) {
        const loading = !!pending && !pending.testName
        matches.push({ range: new monacoApi.Range(activePackageLine, 1, activePackageLine, 1), options: { glyphMarginClassName: `go-package-gutter${loading ? ' go-test-loading' : ''}`, glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left }, zIndex: 10 } })
      }
      for (const declaration of activeTestDeclarations) {
        const status = resultByName.get(declaration.name)
        const loading = status === 'run' || (!!pending && (!pending.testName || pending.testName === declaration.name))
        const state = status && status !== 'run' ? ` go-test-${status}` : loading ? ' go-test-loading' : ''
        matches.push({ range: new monacoApi.Range(declaration.startLine, 1, declaration.startLine, 1), options: { glyphMarginClassName: `go-test-gutter${state}`, glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left }, zIndex: 10 } })
      }
      decorations.set(matches)
    }
    const modelChange = editor.onDidChangeModel(update)
    const frame = requestAnimationFrame(update)
    return () => { cancelAnimationFrame(frame); modelChange.dispose(); decorations.clear() }
  }, [activeFile?.path, activePackageLine, activeTestDeclarations, monacoApi, packageDirectory, pendingTestRun, testResults])

  // Editor chrome decorations: breakpoints share the left glyph lane with the
  // test gutter (keeping the margin one lane wide); bookmarks, coverage, blame,
  // and the current debug position use line decorations and line styles.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !monacoApi) return
    const path = uriToPath(model.uri.toString())
    const matches: Monaco.editor.IModelDeltaDecoration[] = []
    for (const line of breakpoints[path] ?? []) {
      matches.push({
        range: new monacoApi.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'debug-breakpoint-gutter',
          glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left },
          zIndex: 20,
          glyphMarginHoverMessage: { value: '点击切换断点（F9）' },
        },
      })
    }
    for (const line of bookmarks[path] ?? []) {
      matches.push({
        range: new monacoApi.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'bookmark-line',
          linesDecorationsClassName: 'bookmark-mark',
          overviewRuler: { color: '#D9B783', position: monacoApi.editor.OverviewRulerLane.Right },
        },
      })
    }
    if (coverageProfile && activeFile && activeFile.path === path) {
      const profileFile = coverageProfile.files.find((file) => file.path === path || file.path.endsWith(`/${relativePath(root ?? '', path)}`) || path.endsWith(`/${file.path}`))
      if (profileFile) {
        for (const range of coverageRanges(profileFile.blocks)) {
          matches.push({
            range: new monacoApi.Range(range.startLine, 1, range.endLine, 1),
            options: { isWholeLine: true, className: range.covered ? 'coverage-covered' : 'coverage-uncovered' },
          })
        }
      }
    }
    if (gitBlame && gitBlame.path === path) {
      for (const line of gitBlame.result.lines) {
        const commit = gitBlame.result.commits[line.hash]
        if (!commit) continue
        matches.push({
          range: new monacoApi.Range(line.line, 1, line.line, 1),
          options: {
            linesDecorationsClassName: 'blame-mark',
            overviewRuler: { color: '#69BDF1', position: monacoApi.editor.OverviewRulerLane.Right },
            hoverMessage: { value: `${commit.author} · ${commit.date.slice(0, 10)} · ${commit.summary} (${commit.shortHash})` },
          },
        })
      }
    }
    if (debugLocation && debugLocation.path === path) {
      matches.push({
        range: new monacoApi.Range(debugLocation.line, 1, debugLocation.line, 1),
        options: {
          isWholeLine: true,
          className: 'debug-current-line',
          linesDecorationsClassName: 'debug-current-arrow',
          zIndex: 30,
        },
      })
    }
    const decorations = editor.createDecorationsCollection(matches)
    return () => decorations.clear()
  }, [activeFile, breakpoints, bookmarks, coverageProfile, debugLocation, gitBlame, monacoApi, root])

  const testPackages = useMemo(() => {
    const packages = new Map<string, TestResult[]>()
    for (const result of testResults) packages.set(result.package, [...(packages.get(result.package) ?? []), result])
    return [...packages.entries()]
  }, [testResults])
  const testPassed = testResults.filter((result) => result.name !== '(package)' && result.status === 'pass').length
  const testFailed = testResults.filter((result) => result.name !== '(package)' && result.status === 'fail').length

  // Symbol search for the palette: queries gopls as the user types.
  useEffect(() => {
    if (!paletteOpen || paletteMode !== 'symbols') { setSymbolResults([]); return }
    if (lspState !== 'ready' || !lspRef.current) return
    const query = paletteQuery.trim()
    const timer = window.setTimeout(() => {
      void lspRef.current?.workspaceSymbols(query)
        .then(setSymbolResults)
        .catch(() => setSymbolResults([]))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [lspState, paletteMode, paletteOpen, paletteQuery])

  const pluginActions = useMemo(() => getEnabledPluginActions(), [installedPlugins])
  const nativePluginCommands = useMemo(() => nativePlugins.filter((plugin) => plugin.enabled).flatMap((plugin) =>
    plugin.manifest.contributes.commands.map((item) => ({ pluginId: plugin.manifest.id, pluginName: plugin.manifest.name, ...item }))), [nativePlugins])
  const paletteItems = useMemo(() => {
    const actions = [
      { label: t('新建窗口'), hint: t('工作区'), action: () => void openEmptyWindow(), icon: AppWindow },
      { label: locale === 'zh-CN' ? '新建项目' : 'New Project', hint: t('工作区'), action: () => void openNewProject(), icon: FolderPlus },
      { label: t('打开项目文件夹'), hint: t('工作区'), action: () => void chooseWorkspace(), icon: FolderOpen },
      { label: t('运行 Go 项目'), hint: 'go run .', action: () => void runTask('run'), icon: Play },
      { label: t('运行全部测试'), hint: 'go test ./...', action: () => void runTask('test'), icon: FlaskConical },
      { label: t('编译项目'), hint: 'go build ./...', action: () => void runTask('build'), icon: Hammer },
      { label: t('格式化 Go 代码'), hint: 'go fmt ./...', action: () => void runTask('fmt'), icon: Wrench },
      { label: t('整理 Go 模块'), hint: 'go mod tidy', action: () => void runTask('mod_tidy'), icon: Download },
      { label: t('显示终端'), hint: t('命令行'), action: () => { setPanelOpen(true); setPanelView('terminal') }, icon: TerminalSquare },
      { label: t('刷新 Git 状态'), hint: t('版本控制'), action: () => { if (root) void refreshGit(root, { refreshIgnored: true }) }, icon: GitBranch },
      { label: '打开设置', hint: '⌘,', action: () => { setSettingsSection('editor'); setSettingsOpen(true) }, icon: Settings2 },
      { label: '管理插件', hint: 'GoMavo 原生插件与命令清单', action: () => { setSettingsSection('plugins'); setSettingsOpen(true) }, icon: Package },
    ]
    const pluginItems = pluginActions.map((item) => ({
      label: item.action.name,
      hint: `插件 · ${item.pluginName}`,
      icon: Package,
      action: () => { void executePluginAction(item.pluginId, item.action.id, { projectRoot: root, runGoTask: (task) => runTask(task), openFile }).catch((cause) => notify(formatError(cause), 'error')) },
    }))
    const nativePluginItems = nativePluginCommands.map((item) => ({
      label: item.title,
      hint: `插件 · ${item.pluginName}`,
      icon: Package,
      action: () => { void nativePluginHostRef.current?.executeCommand(item.pluginId, item.command).catch((cause) => notify(formatError(cause), 'error')) },
    }))
    const files = projectFiles.map((entry) => ({ label: entry.name, hint: root ? relativePath(root, entry.path) : '', action: () => void openFile(entry.path), icon: entryIcon(entry), ignored: entry.ignored }))
    // Recent files come from the navigation history's newest-first entries.
    const recentFiles = historyRef.current.recent(12).map((location) => ({
      label: displayName(location.path),
      hint: root && isWorkspaceFile(root, location.path) ? relativePath(root, location.path) : location.path,
      action: () => void navigateTo({ path: location.path, line: location.line, column: location.column }),
      icon: entryIcon({ name: displayName(location.path), path: location.path, is_dir: false, ignored: false }),
    }))
    const symbolItems = symbolResults.map((symbol) => ({
      label: symbol.name,
      hint: `${symbol.kind}${symbol.container ? ` · ${symbol.container}` : ''} · ${root && isWorkspaceFile(root, symbol.path) ? relativePath(root, symbol.path) : symbol.path}:${symbol.line}`,
      action: () => void navigateTo({ path: symbol.path, line: symbol.line, column: symbol.column }),
      icon: Braces,
    }))
    // Generate menu (⌘N): one entry per generator for the struct at the cursor.
    const cursorStructs = goStructs(activeFileContent)
    const targetStruct = cursorStructs.find((item) => item.startLine <= cursor.line && cursor.line <= item.endLine) ?? cursorStructs[0] ?? null
    const generateEntries: Array<[Parameters<typeof runGenerate>[0], string]> = [
      ['constructor', '生成构造函数'],
      ['getter', '生成 Getter 方法'],
      ['setter', '生成 Setter 方法'],
      ['tag-json', '生成 JSON 标签'],
      ['tag-yaml', '生成 YAML 标签'],
      ['tag-db', '生成 DB 标签'],
      ['test', '生成测试文件'],
    ]
    const generateItems = generateEntries.map(([kind, label]) => ({
      label: targetStruct && kind !== 'test' ? `${label} · ${targetStruct.name}` : label,
      hint: targetStruct && kind !== 'test' ? t('Generate') : t('需要 Go 文件'),
      icon: Braces,
      action: () => runGenerate(kind, targetStruct?.name),
    }))
    const intentionPaletteItems = intentionItems.map((action) => ({
      label: action.title,
      hint: action.kind ?? 'quickfix',
      icon: Wrench,
      action: () => {
        const path = activePathRef.current
        if (!path || !lspRef.current) return
        void lspRef.current.applyCodeAction(action)
          .then(() => notify(t('已应用：{name}', { name: action.title })))
          .catch((cause) => notify(formatError(cause), 'error'))
      },
    }))
    const query = paletteQuery.trim().toLowerCase()
    const candidates = paletteMode === 'files' ? files
      : paletteMode === 'actions' ? [...actions, ...pluginItems, ...nativePluginItems]
        : paletteMode === 'symbols' ? symbolItems
          : paletteMode === 'recent' ? recentFiles
            : paletteMode === 'generate' ? generateItems
              : paletteMode === 'intentions' ? intentionPaletteItems
                : [...actions, ...pluginItems, ...nativePluginItems, ...files]
    return candidates.filter((item) => !query || `${item.label} ${item.hint}`.toLowerCase().includes(query)).slice(0, 60)
  }, [activeFileContent, chooseWorkspace, cursor.line, formatError, historyAvailability, intentionItems, locale, navigateTo, nativePluginCommands, notify, openEmptyWindow, openFile, openNewProject, paletteMode, paletteQuery, pluginActions, projectFiles, refreshGit, root, runGenerate, runTask, symbolResults, t])

  /** Reveal any workspace path in the project tree (expands ancestors, selects, scrolls). */
  const revealTreePath = useCallback((path: string) => {
    if (!root || !isWorkspaceFile(root, path)) return
    setSideView('files')
    setSidebarOpen(true)
    setSelectedTreePath(path)
    const relative = relativePath(root, path)
    const directories = [root]
    for (const segment of relative.split('/').slice(0, -1)) {
      directories.push(joinPath(directories[directories.length - 1], segment))
    }
    setExpanded((current) => new Set([...current, ...directories]))
    for (const directory of directories) if (!tree[directory]) void refreshDirectory(directory)
    setRevealPath(path)
  }, [refreshDirectory, root, tree])

  const revealCurrentFile = () => {
    if (!activePath) return
    revealTreePath(activePath)
  }

  useEffect(() => {
    if (!revealPath || sideView !== 'files' || !sidebarOpen) return
    const row = [...(treeScrollRef.current?.querySelectorAll<HTMLButtonElement>('.tree-row[data-entry-path]') ?? [])]
      .find((candidate) => candidate.dataset.entryPath === revealPath)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    row.focus({ preventScroll: true })
    setRevealPath(null)
  }, [expanded, revealPath, sideView, sidebarOpen, tree])

  /** Open the project's GoMavo style file inside its hidden config folder. */
  const openStyleFile = useCallback(async () => {
    if (!root) {
      notify(localeRef.current === 'zh-CN' ? '请先打开一个项目。' : 'Open a project first.', 'error')
      return
    }
    const path = projectCodeStylePath(root)
    try {
      // The initial load may still be migrating browser-local settings. Wait
      // for it and any queued settings save before creating or opening the file.
      const load = projectStyleLoadRef.current
      if (load?.root === root) await load.promise.catch(() => undefined)
      await projectStyleSaveRef.current.catch(() => undefined)
      if (rootRef.current !== root) return
      if (!await projectCodeStyleExists(root, projectCodeStyleIO)) {
        const previous = loadProjectGoOverrides(root)
        const initial = Object.keys(previous).length ? previous : projectGoOverrides
        const created = await createProjectCodeStyleIfMissing(root, initial, projectCodeStyleIO)
        if (created) {
          projectStyleDiskRef.current.set(root, serializeProjectCodeStyle(initial))
          if (Object.keys(previous).length) saveProjectGoOverrides(root, {})
        } else await reloadProjectCodeStyle(root)
        const entries = await command<FileEntry[]>('list_directory', { path: root })
        setTree((current) => ({ ...current, [root]: entries }))
      }
    } catch (cause) {
      notify(formatError(cause), 'error')
      return
    }
    if (rootRef.current !== root) return
    await openFile(path)
  }, [formatError, notify, openFile, projectGoOverrides, reloadProjectCodeStyle, root])

  // Native menu items reuse the shortcut dispatchers plus a few menu-only actions.
  goGetRef.current = (target) => {
    notify(t('正在获取依赖 {target}…', { target }))
    void runTask('mod_get', { module: target, label: t('go get {target}', { target }) }).then((ok) => {
      if (ok) notify(t('依赖已写入 go.mod：{target}。', { target }))
    })
  }

  menuActionRef.current = (id: string, path?: string) => {
    switch (id) {
      case 'project.new': void openNewProject(); break
      case 'project.open': void chooseWorkspace(); break
      case 'app.settings': setSettingsSection('editor'); setSettingsOpen(true); break
      case 'file.new-go-file': if (root) showDialog('go', root); break
      case 'file.save': if (activePathRef.current) void saveFile(activePathRef.current); break
      case 'file.save-all': for (const file of tabsRef.current.filter((item) => item.content !== item.savedContent)) void saveFile(file.path); break
      case 'recent-project': if (path) void openRecentProject(path); break
      case 'view.toggle-project': runShortcutAction('toggleProject'); break
      case 'view.toggle-git': runShortcutAction('toggleGit'); break
      case 'view.toggle-structure': runShortcutAction('toggleStructure'); break
      case 'view.toggle-bookmarks': runShortcutAction('toggleBookmarks'); break
      case 'view.toggle-todo': runShortcutAction('toggleTodoPanel'); break
      case 'view.toggle-terminal': runShortcutAction('toggleTerminal'); break
      case 'view.toggle-run': runShortcutAction('toggleRun'); break
      case 'view.toggle-problems': runShortcutAction('toggleProblems'); break
      case 'view.toggle-debug': runShortcutAction('toggleDebugPanel'); break
      case 'view.toggle-search': runShortcutAction('toggleSearch'); break
      case 'nav.search-everywhere': runShortcutAction('searchEverywhere'); break
      case 'nav.recent-files': runShortcutAction('recentFiles'); break
      case 'nav.go-to-definition': runShortcutAction('goToDefinition'); break
      case 'nav.go-to-implementation': runShortcutAction('goToImplementation'); break
      case 'nav.go-to-test': runShortcutAction('goToTest'); break
      case 'nav.find-usages': runShortcutAction('findUsages'); break
      case 'nav.jump-to-line': runShortcutAction('jumpToLine'); break
      case 'nav.back': runShortcutAction('navigateBack'); break
      case 'nav.forward': runShortcutAction('navigateForward'); break
      case 'code.organize-imports': void organizeCurrentFile(); break
      case 'code.format': void formatCurrentFile(); break
      case 'code.quick-fix': editorRef.current?.trigger('gomavo', 'editor.action.codeAction', { kind: 'quickfix' }); break
      case 'code.run-intentions': openPalette('intentions'); break
      case 'code.cleanup': void codeCleanup(); break
      case 'refactor.rename': editorRef.current?.trigger('source', 'editor.action.rename', undefined); break
      case 'refactor.extract-variable': void runRefactor(['refactor.extract.variable', 'refactor.extract.constant'], /variable/i); break
      case 'refactor.extract-constant': void runRefactor(['refactor.extract.constant'], /constant/i); break
      case 'refactor.extract-function': void runRefactor(['refactor.extract.function', 'refactor.extract.method']); break
      case 'refactor.inline': void runRefactor(['refactor.inline.call']); break
      case 'refactor.extract-interface': notify(t('gopls 暂不支持提取接口。'), 'error'); break
      case 'run.run': runShortcutAction('run'); break
      case 'run.debug': runShortcutAction('debug'); break
      case 'run.coverage': runShortcutAction('runWithCoverage'); break
      case 'run.build': runShortcutAction('build'); break
      case 'run.stop': runShortcutAction('stop'); break
      case 'run.configs': setRunConfigEditorOpen(true); break
      case 'tools.go-mod-tidy': runShortcutAction('goModTidy'); break
      case 'tools.restart-gopls': setLspEpoch((value) => value + 1); break
      case 'vcs.tool-window': runShortcutAction('toggleGit'); break
      case 'vcs.commit': openGitPanel('diff'); break
      case 'vcs.update': void gitPull(); break
      case 'vcs.fetch': void gitFetch(); break
      case 'vcs.push': void gitPush(); break
      case 'help.shortcuts': setSettingsSection('shortcuts'); setSettingsOpen(true); break
    }
  }

  return <div className={`app-shell ${isMac && desktopAvailable ? 'mac-native' : isMac ? 'mac-preview' : ''} ${preferences.appearance.compactMode ? 'compact' : ''}`}>
    <TitleBar
      locale={locale} t={t} isMac={isMac} root={root}
      projectMenuOpen={projectMenuOpen} setProjectMenuOpen={setProjectMenuOpen}
      openEmptyWindow={openEmptyWindow} openNewProject={openNewProject} chooseWorkspace={chooseWorkspace}
      git={git} gitError={gitError} gitBranches={gitBranches} branchBusy={branchBusy}
      branchMenu={branchMenu} setBranchMenu={setBranchMenu} changeBranch={changeBranch}
      newBranchName={newBranchName} setNewBranchName={setNewBranchName} refreshGit={refreshGit}
      gitMerge={gitMerge}
      runConfig={runConfig} setRunConfig={setRunConfig} runOptions={runOptions} setRunOptions={setRunOptions}
      configMenu={configMenu} setConfigMenu={setConfigMenu} moduleMenu={moduleMenu} setModuleMenu={setModuleMenu}
      activeFile={activeFile} activeTestDeclarations={activeTestDeclarations} cursor={cursor}
      runEditorContext={runEditorContext} runningTask={runningTask} runTask={runTask}
      activePath={activePath} saveFile={saveFile} formatOnSave={effectiveGo.formatOnSave}
      lspState={lspState} openPalette={openPalette}
      setSettingsSection={setSettingsSection} setSettingsOpen={setSettingsOpen}
      setLocale={setLocale} notify={notify} formatError={formatError}
      savedRunConfigurations={preferences.run.runConfigurations}
      onSelectRunConfiguration={selectRunConfiguration}
      onEditRunConfigurations={() => setRunConfigEditorOpen(true)}
      debugState={debugState} debugCurrentContext={debugCurrentContext}
      debugStop={() => void debugControl('disconnect')}
      runWithCoverage={() => void runTask('test', { ...(lastTestOptionsRef.current || {}), coverage: true, label: `覆盖率 · ${lastTestOptionsRef.current?.label ?? 'go test ./...'}` })}
      recentProjects={recentProjects} openRecentProject={openRecentProject}
      onGoGet={(module) => void runTask('mod_get', { module, label: `go get ${module}` })}
      onVulncheck={() => void runTask('vulncheck', { label: 'govulncheck ./...' })}
    />

    <div className="workspace">
      <nav className="activity-bar" aria-label={t('工具窗口')}>
        <button className={`activity-button ${sidebarOpen && sideView === 'files' ? 'selected' : ''}`} type="button" title={t('Project')} aria-label={t('Project')} aria-pressed={sidebarOpen && sideView === 'files'} onClick={() => { if (sidebarOpen && sideView === 'files') setSidebarOpen(false); else { setSideView('files'); setSidebarOpen(true) } }}><Folder size={20} strokeWidth={1.7} /></button>
        <button className={`activity-button ${sidebarOpen && sideView === 'git' ? 'selected' : ''}`} type="button" title="Git" aria-label="Git" aria-pressed={sidebarOpen && sideView === 'git'} onClick={() => { if (sidebarOpen && sideView === 'git') setSidebarOpen(false); else { setSideView('git'); setSidebarOpen(true); if (root) void refreshGit(root, { refreshIgnored: true }) } }}><GitBranch size={19} strokeWidth={1.7} /></button>
        <button className={`activity-button ${sidebarOpen && sideView === 'structure' ? 'selected' : ''}`} type="button" title={t('结构')} aria-label={t('结构')} aria-pressed={sidebarOpen && sideView === 'structure'} onClick={() => { if (sidebarOpen && sideView === 'structure') setSidebarOpen(false); else { setSideView('structure'); setSidebarOpen(true) } }}><ListTree size={19} strokeWidth={1.7} /></button>
        <button className={`activity-button ${sidebarOpen && sideView === 'bookmarks' ? 'selected' : ''}`} type="button" title={t('书签')} aria-label={t('书签')} aria-pressed={sidebarOpen && sideView === 'bookmarks'} onClick={() => { if (sidebarOpen && sideView === 'bookmarks') setSidebarOpen(false); else { setSideView('bookmarks'); setSidebarOpen(true) } }}><Bookmark size={19} strokeWidth={1.7} /></button>
        <div className="activity-spacer" />
        <button className={`activity-button ${panelOpen && panelView === 'todo' ? 'selected' : ''}`} type="button" title="TODO" aria-label="TODO" onClick={() => { setPanelView('todo'); setPanelOpen((value) => panelView === 'todo' ? !value : true) }}><Braces size={19} strokeWidth={1.7} /></button>
        <button className={`activity-button ${panelOpen && panelView === 'output' ? 'selected' : ''}`} type="button" title={t('Run')} aria-label={t('Run')} onClick={() => { setPanelView('output'); setPanelOpen((value) => panelView === 'output' ? !value : true) }}><Play size={19} /></button>
        <button className={`activity-button ${panelOpen && panelView === 'tests' ? 'selected' : ''}`} type="button" title={t('Test')} aria-label={t('Test')} onClick={() => { setPanelView('tests'); setPanelOpen((value) => panelView === 'tests' ? !value : true) }}><FlaskConical size={19} /></button>
        <button className={`activity-button ${panelOpen && panelView === 'terminal' ? 'selected' : ''}`} type="button" title={t('Terminal')} aria-label={t('Terminal')} onClick={() => { setPanelView('terminal'); setPanelOpen((value) => panelView === 'terminal' ? !value : true) }}><TerminalSquare size={19} /></button>
        <button className={`activity-button ${panelOpen && panelView === 'problems' ? 'selected' : ''}`} type="button" title={t('Problems')} aria-label={t('Problems')} onClick={() => { setPanelView('problems'); setPanelOpen((value) => panelView === 'problems' ? !value : true) }}><AlertCircle size={19} /></button>
      </nav>
      {sidebarOpen && <Sidebar
        t={t} locale={locale} sideView={sideView} root={root} tree={tree} expanded={expanded}
        setExpanded={setExpanded} setRevealPath={setRevealPath} toggleFolder={toggleFolder}
        refreshDirectory={refreshDirectory} refreshProjectFiles={refreshProjectFiles} refreshGit={refreshGit}
        showHiddenFiles={preferences.project.showHiddenFiles} treeScrollRef={treeScrollRef}
        selectedTreePath={selectedTreePath} setSelectedTreePath={setSelectedTreePath}
        openingPath={openingPath} mutationBusyPath={mutationBusyPath} activePath={activePath}
        openFile={openFile} chooseWorkspace={chooseWorkspace} showDialog={showDialog}
        showContextMenu={showContextMenu} showNewMenu={showNewMenu} deleteEntry={deleteEntry}
        revealCurrentFile={revealCurrentFile} context={context} setSidebarOpen={setSidebarOpen}
        git={git} gitError={gitError} formatError={formatError} gitLog={gitLog}
        setBranchMenu={setBranchMenu} commitMessage={commitMessage} setCommitMessage={setCommitMessage}
        openGitDiff={openGitDiff} updateGitIndex={updateGitIndex} commitGit={commitGit}
        remoteBusy={remoteBusy} gitFetch={gitFetch} gitPull={gitPull} gitPush={gitPush}
        mergeConflicts={mergeConflicts ?? []} gitAbortMerge={gitAbortMerge} openMergeResolver={openMergeResolver}
        openGitGraph={openGitGraph} stashEntries={stashEntries}
        gitStashPush={gitStashPush} gitStashPop={gitStashPop} gitStashDrop={gitStashDrop}
        recentProjects={recentProjects} openRecentProject={openRecentProject}
        goMod={goMod} goSdkVersion={/go\d+\.\d+(?:\.\d+)?/.exec(versions?.go ?? '')?.[0]?.replace(/^go/, '') ?? null}
        structureSymbols={structureSymbols} structureLoading={structureLoading}
        bookmarks={bookmarks} removeBookmark={toggleBookmark} navigateTo={navigateTo}
      />}
      <EditorArea
        t={t} locale={locale} root={root} tabs={tabs} activePath={activePath} activeFile={activeFile}
        tabContext={tabContext} git={git} showTabContextMenu={showTabContextMenu} selectTab={selectTab}
        closeTab={closeTab} navigateHistory={navigateHistory}
        historyNavigationBusy={historyNavigationBusy} historyAvailability={historyAvailability}
        editorTabListRef={editorTabListRef} beforeEditorMount={beforeEditorMount}
        onEditorMount={onEditorMount} onSplitEditorMount={onSplitEditorMount} changeFile={changeFile}
        externalContent={externalContent}
        editorPreferences={{ fontSize: preferences.editor.fontSize, lineHeight: preferences.editor.lineHeight, minimap: preferences.editor.minimap, showLineNumbers: preferences.editor.showLineNumbers, showWhitespace: preferences.editor.showWhitespace, wordWrap: preferences.editor.wordWrap, inlayHints: effectiveGo.inlayHints }}
        activeIndentOptions={activeIndentOptions}
        chooseWorkspace={chooseWorkspace} openNewProject={openNewProject} showDialog={showDialog}
        setPanelView={setPanelView} setPanelOpen={setPanelOpen}
        splitPath={splitPath} setSplitPath={setSplitPath} theme={monacoTheme}
        lineNumbersFormatter={lineNumbersFormatter}
        mdPreviewOpen={mdPreviewOpen} setMdPreviewOpen={setMdPreviewOpen}
      >
      <BottomPanel
        t={t} locale={locale} root={root} panelOpen={panelOpen} setPanelOpen={setPanelOpen}
        panelView={panelView} setPanelView={setPanelView} terminalFontSize={preferences.terminal.fontSize}
        runningTask={runningTask} runTask={runTask} lastTestOptionsRef={lastTestOptionsRef}
        output={output} setOutput={setOutput} testResults={testResults} testPassed={testPassed}
        testFailed={testFailed} testPackages={testPackages} testOutput={testOutput}
        testOutputByCase={testOutputByCase} coverageProfile={coverageProfile}
        packageDirectory={packageDirectory} runSelection={runSelection} jumpToTest={jumpToTest}
        rerunTest={rerunTest} diagnostics={diagnostics} navigateTo={navigateTo} gitDiff={gitDiff}
        openFile={openFile} gitFileHistory={gitFileHistory} fileHistorySource={fileHistorySource}
        setFileHistorySource={setFileHistorySource} localHistoryEntries={localHistoryEntries}
        selectedLocalHistoryEntry={selectedLocalHistoryEntry}
        setSelectedLocalHistoryId={setSelectedLocalHistoryId} selectedLocalDiff={selectedLocalDiff}
        selectedHistoryEntry={selectedHistoryEntry} openGitFileCommitDiff={openGitFileCommitDiff}
        projectFiles={projectFiles} openDocuments={tabs} searchRevision={searchRevision} onReplaced={onReplaced}
        debugState={debugState} debugFrames={debugFrames} debugSelectedFrameIndex={debugSelectedFrameIndex}
        debugSelectFrame={hookSelectFrame} debugVariables={debugVariables} debugExpandVariable={expandVariable}
        debugConsole={debugConsole} debugControl={debugControl} debugCurrentThreadId={debugCurrentThreadId}
        debugThreads={debugThreads} debugSelectThread={selectThread}
        debugWatches={debugWatches} debugAddWatch={addWatch} debugRemoveWatch={removeWatch}
        debugEvaluateRepl={evaluateRepl}
        usages={usages} usagesBusy={usagesBusy}
        dlvInstalled={!!versions?.dlv} installDlv={() => void runTask('install_dlv')}
        startDebug={debugCurrentContext}
        gitGraph={gitGraph} gitGraphLoading={gitGraphLoading} refreshGitGraph={openGitGraph}
        mergeConflicts={mergeConflicts ?? []} mergeResolverPath={mergeResolverPath}
        openMergeResolver={openMergeResolver} mergeResolved={mergeResolved}
        refreshGit={refreshGit} notify={notify} formatError={formatError}
      />
      </EditorArea>
      <nav className="right-stripe" aria-label={t('右侧工具窗口')}>
        <button type="button" title={t('随处搜索')} aria-label={t('随处搜索')} onClick={() => openPalette()}><Search size={18} /></button>
        <button className={panelOpen && panelView === 'problems' ? 'selected' : ''} type="button" title={t('Problems')} aria-label={t('Problems')} onClick={() => { setPanelView('problems'); setPanelOpen(true) }}><AlertCircle size={18} /></button>
      </nav>
    </div>

    <StatusBar
      t={t} root={root} activeFile={activeFile} dirtyCount={dirtyCount} problemCount={problemCount}
      lspState={lspState} lspError={lspError} goplsLog={goplsLog} formatError={formatError} runningTask={runningTask}
      runTask={runTask} setLspEpoch={setLspEpoch} cursor={cursor} versions={versions}
      setPanelView={setPanelView} setPanelOpen={setPanelOpen}
      activeSymbol={activeSymbol}
      revealTreePath={revealTreePath}
      jumpToLine={(line) => { if (activePath) void navigateTo({ path: activePath, line, column: 1 }) }}
    />

    <Dialogs
      t={t} locale={locale} root={root} dialog={dialog} dialogName={dialogName}
      setDialogName={setDialogName} dialogError={dialogError} setDialogError={setDialogError}
      dialogBusy={dialogBusy} closeDialog={closeDialog} submitDialog={submitDialog}
      windowClosePrompt={windowClosePrompt} windowCloseBusy={windowCloseBusy}
      dirtyFiles={dirtyFiles} cancelWindowClose={cancelWindowClose}
      discardAndCloseWindow={discardAndCloseWindow} saveAndCloseWindow={saveAndCloseWindow}
      newProjectOpen={newProjectOpen} setNewProjectOpen={setNewProjectOpen}
      activateWorkspace={activateWorkspace}
    />

    <ContextMenus
      t={t} locale={locale} root={root} context={context} newSubmenuOpen={newSubmenuOpen}
      setNewSubmenuOpen={setNewSubmenuOpen} closeContextMenu={closeContextMenu}
      tabContext={tabContext} tabSubmenu={tabSubmenu} setTabSubmenu={setTabSubmenu}
      closeTabContextMenu={closeTabContextMenu} tabs={tabs} mutationBusyPath={mutationBusyPath}
      git={git} editorRef={editorRef} toggleFolder={toggleFolder} expanded={expanded}
      openFile={openFile} openGitFileHistory={openGitFileHistory}
      setFileHistorySource={setFileHistorySource} openGitDiff={openGitDiff}
      setSideView={setSideView} setSidebarOpen={setSidebarOpen} runSelection={runSelection}
      createTestsForSource={createTestsForSource} copyEntryPath={copyEntryPath}
      copyTabValue={copyTabValue} showDialog={showDialog} deleteEntry={deleteEntry}
      closeTab={closeTab} closeTabs={closeTabs} togglePinnedTab={togglePinnedTab}
      setConfigMenu={setConfigMenu}
    />

    {runConfigEditorOpen && <RunConfigDialog
      t={t} locale={locale} configurations={preferences.run.runConfigurations}
      activePath={activePath}
      onChange={(configurations) => setPreferences(savePreferences({ ...preferences, run: { ...preferences.run, runConfigurations: configurations } }))}
      onClose={() => setRunConfigEditorOpen(false)}
    />}

    {paletteOpen && <Palette
      t={t} locale={locale} paletteMode={paletteMode} paletteQuery={paletteQuery}
      setPaletteQuery={setPaletteQuery} paletteSelection={paletteSelection}
      setPaletteSelection={setPaletteSelection} items={paletteItems} closePalette={closePalette}
    />}

    {settingsOpen && <SettingsPane preferences={projectStyleReady && goScope === 'project' ? { ...preferences, go: effectiveGo } : preferences} onChange={(next) => {
      if (projectStyleReady && goScope === 'project' && root) {
        const changed = (Object.keys(next.go) as (keyof GoPreferences)[]).filter((key) => next.go[key] !== preferences.go[key])
        const overrides = Object.fromEntries(changed.map((key) => [key, next.go[key]])) as Partial<GoPreferences>
        persistProjectGoOverrides(root, overrides)
        setPreferences(savePreferences({ ...next, go: preferences.go }))
      } else {
        setPreferences(savePreferences(next))
      }
    }} locale={locale} onLocaleChange={setLocale} initialSection={settingsSection} versions={versions} lspState={lspState} onInstallGopls={() => void runTask('install_gopls')} onRestartGopls={() => setLspEpoch((value) => value + 1)} goToolBusy={!!runningTask} onInstallTool={(task) => void runTask(task)} pluginManager={{ projectRoot: root, busy: !!runningTask, onRunGoTask: runTask, onOpenFile: openFile, nativePlugins, onNativePluginsChanged: refreshNativePlugins }} onClose={() => setSettingsOpen(false)} goScope={projectStyleReady ? goScope : 'global'} onGoScopeChange={setGoScope} hasProject={!!root} projectScopeAvailable={projectStyleReady} projectOverrideCount={Object.keys(projectGoOverrides).length} onClearProjectGoOverrides={() => { if (root) persistProjectGoOverrides(root, {}) }} onOpenStyleFile={() => void openStyleFile()} />}
    {lineJumpOpen && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLineJumpOpen(false) }}>
      <form className="line-jump-dialog" role="dialog" aria-modal="true" aria-label={t('跳转到行:列')} onSubmit={(event) => { event.preventDefault(); submitLineJump() }}>
        <label htmlFor="mg-line-jump-input">{t('跳转到行:列')}</label>
        <input
          id="mg-line-jump-input"
          ref={lineJumpInputRef}
          value={lineJumpDraft}
          placeholder="120:8"
          autoComplete="off"
          onChange={(event) => setLineJumpDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setLineJumpOpen(false) }}
        />
        <div className="dialog-actions"><button type="button" onClick={() => setLineJumpOpen(false)}>{t('取消')}</button><button type="submit" className="primary">{t('跳转')}</button></div>
      </form>
    </div>}
    {breakpointEdit && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBreakpointEdit(null) }}>
      <form className="line-jump-dialog" role="dialog" aria-modal="true" aria-label={t('编辑断点条件')} onSubmit={(event) => { event.preventDefault(); saveBreakpointEdit() }}>
        <label htmlFor="mg-bp-condition">{t('断点条件')} · {displayName(breakpointEdit.path)}:{breakpointEdit.line}</label>
        <input
          id="mg-bp-condition"
          value={breakpointEdit.condition}
          placeholder={t('表达式为真时中断，如 count > 10')}
          autoComplete="off"
          onChange={(event) => setBreakpointEdit({ ...breakpointEdit, condition: event.target.value })}
        />
        <label htmlFor="mg-bp-log" style={{ marginTop: 10 }}>{t('日志消息（命中时记录而不暂停）')}</label>
        <input
          id="mg-bp-log"
          value={breakpointEdit.logMessage}
          placeholder={t('支持 {expr} 插值，如 count={count}')}
          autoComplete="off"
          onChange={(event) => setBreakpointEdit({ ...breakpointEdit, logMessage: event.target.value })}
        />
        <div className="dialog-actions">
          <button type="button" onClick={() => { toggleBreakpoint(breakpointEdit.path, breakpointEdit.line); setBreakpointEdit(null) }}>{t('移除断点')}</button>
          <button type="button" onClick={() => setBreakpointEdit(null)}>{t('取消')}</button>
          <button type="submit" className="primary">{t('保存断点')}</button>
        </div>
      </form>
    </div>}
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === 'success' ? <Check size={16} /> : <CircleHelp size={16} />}<span>{toast.text}</span><button type="button" aria-label={t('关闭提示')} onClick={() => setToast(null)}><X size={14} /></button></div>}
    {!desktopAvailable && <div className="browser-hint"><AlertCircle size={15} />{t('当前为浏览器预览。本机开发功能请使用 {command}。', { command: 'npm run tauri dev' })}</div>}
  </div>
}

export default App
