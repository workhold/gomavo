/** Settings supported by MGLand. Shortcuts use physical key names and macOS modifiers. */
export type ShortcutAction =
  | 'searchEverywhere'
  | 'quickOpen'
  | 'findAction'
  | 'findInFiles'
  | 'recentFiles'
  | 'symbolSearch'
  | 'toggleProject'
  | 'toggleGit'
  | 'toggleStructure'
  | 'toggleBookmarks'
  | 'toggleTodoPanel'
  | 'toggleTerminal'
  | 'toggleRun'
  | 'toggleProblems'
  | 'toggleSearch'
  | 'toggleDebugPanel'
  | 'goToDefinition'
  | 'goToImplementation'
  | 'goToTest'
  | 'findUsages'
  | 'jumpToLine'
  | 'generate'
  | 'navigateBack'
  | 'navigateForward'
  | 'saveCurrent'
  | 'saveAll'
  | 'run'
  | 'debug'
  | 'testAll'
  | 'runWithCoverage'
  | 'build'
  | 'stop'
  | 'format'
  | 'goModTidy'
  | 'toggleBookmark'
  | 'openSettings'

export type Shortcut = string | null

export interface EditorPreferences {
  fontSize: number
  lineHeight: number
  tabSize: number
  insertSpaces: boolean
  minimap: boolean
  wordWrap: boolean
  showLineNumbers: boolean
  showWhitespace: boolean
}

export interface GoPreferences {
  formatOnSave: boolean
  /** GoLand "Optimize imports on save": sort, group, and drop unused imports. */
  organizeImportsOnSave: boolean
  /** gopls staticcheck lint diagnostics. */
  staticcheck: boolean
  /** gopls gofumpt formatter: stricter code-style rules on top of gofmt. */
  gofumpt: boolean
  inlayHints: boolean
  /** Comma-separated module prefixes goimports groups as "local" imports. */
  localPrefix: string
}

export interface RunPreferences {
  saveBeforeRun: boolean
  runConfigurations: RunConfiguration[]
  selectedRunConfigurationId: string | null
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppearancePreferences {
  compactMode: boolean
  theme: ThemePreference
}

/** A saved run/debug configuration shown in the run widget. */
export interface RunConfiguration {
  id: string
  name: string
  kind: 'run' | 'test' | 'build' | 'bench'
  scope: 'workspace' | 'file' | 'package' | 'directory'
  targetPath: string | null
  testName: string | null
  programArgs: string
  envVars: string
  buildTags: string
  race: boolean
  /** Task chained before launch: none / go mod tidy / go build ./... */
  beforeLaunch: 'none' | 'tidy' | 'build'
  /** Benchmark pattern for the bench kind; empty means all benchmarks. */
  benchPattern: string
}

export interface ProjectPreferences {
  showHiddenFiles: boolean
  autoRevealCurrentFile: boolean
}

export type GitAutoRefreshSeconds = 0 | 5 | 15 | 30

export interface VersionControlPreferences {
  gitAutoRefreshSeconds: GitAutoRefreshSeconds
}

export interface TerminalPreferences {
  fontSize: number
}

export interface Preferences {
  version: 1
  editor: EditorPreferences
  go: GoPreferences
  run: RunPreferences
  appearance: AppearancePreferences
  project: ProjectPreferences
  versionControl: VersionControlPreferences
  terminal: TerminalPreferences
  shortcuts: Record<ShortcutAction, Shortcut>
}

export interface ShortcutActionInfo {
  id: ShortcutAction
  label: string
  group: '导航' | '工具窗口' | '代码' | '运行'
  description: string
}

/** The default MGLand macOS keymap. */
export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, Shortcut>> = {
  searchEverywhere: 'DoubleShift',
  quickOpen: 'Meta+Shift+O',
  findAction: 'Meta+Shift+A',
  findInFiles: 'Meta+Shift+F',
  recentFiles: 'Meta+E',
  symbolSearch: 'Meta+Alt+O',
  toggleProject: 'Meta+1',
  toggleGit: 'Meta+9',
  toggleStructure: 'Meta+7',
  toggleBookmarks: 'Meta+2',
  toggleTodoPanel: null,
  toggleTerminal: 'Alt+F12',
  toggleRun: 'Meta+4',
  toggleProblems: 'Meta+6',
  toggleSearch: 'Meta+Shift+F',
  toggleDebugPanel: 'Meta+5',
  goToDefinition: 'Meta+B',
  goToImplementation: 'Meta+Alt+B',
  goToTest: 'Meta+Shift+T',
  findUsages: 'Alt+F7',
  jumpToLine: 'Meta+L',
  generate: 'Meta+N',
  navigateBack: 'Meta+Alt+ArrowLeft',
  navigateForward: 'Meta+Alt+ArrowRight',
  saveCurrent: 'Meta+S',
  saveAll: 'Meta+Alt+S',
  run: 'Control+R',
  debug: 'Control+D',
  testAll: null,
  runWithCoverage: null,
  build: 'Meta+F9',
  stop: 'Meta+F2',
  format: 'Meta+Alt+L',
  goModTidy: null,
  toggleBookmark: 'F3',
  openSettings: 'Meta+Comma',
}

export const SHORTCUT_ACTIONS: readonly ShortcutActionInfo[] = [
  { id: 'searchEverywhere', label: '搜索所有内容', group: '导航', description: '打开文件与命令搜索' },
  { id: 'quickOpen', label: '转到文件', group: '导航', description: '搜索工作区文件' },
  { id: 'findAction', label: '查找操作', group: '导航', description: '搜索可执行操作' },
  { id: 'findInFiles', label: '在文件中查找', group: '导航', description: '全项目文本搜索与替换' },
  { id: 'recentFiles', label: '最近文件', group: '导航', description: '切换到最近打开的文件' },
  { id: 'symbolSearch', label: '转到符号', group: '导航', description: '搜索工作区中的 Go 符号' },
  { id: 'goToDefinition', label: '跳转到定义', group: '导航', description: '打开光标处符号的定义' },
  { id: 'goToImplementation', label: '跳转到实现', group: '导航', description: '打开光标处接口方法的实现' },
  { id: 'goToTest', label: '跳转到测试（或被测代码）', group: '导航', description: '在源码与其测试文件之间跳转' },
  { id: 'findUsages', label: '查找用法', group: '导航', description: '在工具窗口中列出光标处符号的所有引用' },
  { id: 'jumpToLine', label: '跳转到行:列', group: '导航', description: '在当前文件按行号定位' },
  { id: 'generate', label: 'Generate 代码生成', group: '导航', description: '在 Go 文件中打开生成菜单（构造函数/Getter/Setter/标签/测试）' },
  { id: 'navigateBack', label: '后退', group: '导航', description: '返回上一个代码位置' },
  { id: 'navigateForward', label: '前进', group: '导航', description: '前往下一个代码位置' },
  { id: 'toggleBookmark', label: '切换书签', group: '导航', description: '在当前行添加或移除书签' },
  { id: 'toggleProject', label: 'Project 工具窗口', group: '工具窗口', description: '显示或隐藏项目文件' },
  { id: 'toggleGit', label: 'Git 工具窗口', group: '工具窗口', description: '显示或隐藏 Git 状态' },
  { id: 'toggleStructure', label: 'Structure 工具窗口', group: '工具窗口', description: '显示或隐藏当前文件的结构' },
  { id: 'toggleBookmarks', label: '书签工具窗口', group: '工具窗口', description: '显示或隐藏全部书签列表' },
  { id: 'toggleTodoPanel', label: 'TODO 工具窗口', group: '工具窗口', description: '显示或隐藏 TODO 注释列表' },
  { id: 'toggleTerminal', label: 'Terminal 工具窗口', group: '工具窗口', description: '显示或隐藏集成终端' },
  { id: 'toggleRun', label: 'Run 工具窗口', group: '工具窗口', description: '显示或隐藏运行输出' },
  { id: 'toggleProblems', label: 'Problems 工具窗口', group: '工具窗口', description: '显示或隐藏诊断列表' },
  { id: 'toggleSearch', label: 'Search 工具窗口', group: '工具窗口', description: '显示或隐藏全项目搜索' },
  { id: 'toggleDebugPanel', label: 'Debug 工具窗口', group: '工具窗口', description: '显示或隐藏调试器' },
  { id: 'saveCurrent', label: '保存当前文件', group: '代码', description: '保存当前编辑标签' },
  { id: 'saveAll', label: '保存所有文件', group: '代码', description: '保存全部未保存的编辑标签' },
  { id: 'format', label: '格式化 Go 代码', group: '代码', description: '执行格式化操作' },
  { id: 'openSettings', label: '打开设置', group: '代码', description: '打开编辑器与快捷键设置' },
  { id: 'run', label: '运行当前上下文', group: '运行', description: '测试文件中运行光标方法或当前文件；其他情况运行顶部配置' },
  { id: 'debug', label: '调试当前上下文', group: '运行', description: '使用 Delve 调试当前包或测试' },
  { id: 'testAll', label: '运行全部测试', group: '运行', description: '运行项目中的所有 Go 测试' },
  { id: 'runWithCoverage', label: '带覆盖率运行测试', group: '运行', description: '运行测试并收集覆盖率' },
  { id: 'build', label: '编译项目', group: '运行', description: '编译项目中的 Go 包' },
  { id: 'stop', label: '停止任务', group: '运行', description: '停止当前运行或测试任务' },
  { id: 'goModTidy', label: '整理 Go 模块', group: '运行', description: '执行 go mod tidy' },
]

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  version: 1,
  editor: {
    fontSize: 13,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: false,
    minimap: true,
    wordWrap: false,
    showLineNumbers: true,
    showWhitespace: false,
  },
  go: { formatOnSave: false, organizeImportsOnSave: true, staticcheck: true, gofumpt: false, inlayHints: true, localPrefix: '' },
  run: { saveBeforeRun: true, runConfigurations: [], selectedRunConfigurationId: null },
  appearance: { compactMode: false, theme: 'dark' },
  project: { showHiddenFiles: true, autoRevealCurrentFile: false },
  versionControl: { gitAutoRefreshSeconds: 15 },
  terminal: { fontSize: 12 },
  shortcuts: DEFAULT_SHORTCUTS,
}

export const PREFERENCES_STORAGE_KEY = 'mgland.preferences.v1'
export const PREFERENCES_CHANGED_EVENT = 'mgland:preferences-changed'
const PROJECT_GO_STORAGE_KEY = 'mgland.project-go.v1'

/** Per-project Go style overrides (.mgland project scope), falling back to the global defaults. */
export function loadProjectGoOverrides(root: string | null): Partial<GoPreferences> {
  if (!root) return {}
  try {
    const store = JSON.parse(localStorage.getItem(PROJECT_GO_STORAGE_KEY) ?? '{}') as Record<string, Partial<GoPreferences>>
    return store[root] ?? {}
  } catch { return {} }
}

export function saveProjectGoOverrides(root: string | null, overrides: Partial<GoPreferences>): void {
  if (!root) return
  let store: Record<string, Partial<GoPreferences>> = {}
  try { store = JSON.parse(localStorage.getItem(PROJECT_GO_STORAGE_KEY) ?? '{}') as Record<string, Partial<GoPreferences>> } catch { store = {} }
  if (Object.keys(overrides).length) store[root] = overrides
  else delete store[root]
  localStorage.setItem(PROJECT_GO_STORAGE_KEY, JSON.stringify(store))
}

const ACTION_IDS = SHORTCUT_ACTIONS.map((action) => action.id)
const KEY_NAMES = new Set([
  'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Delete',
  'Enter', 'Equal', 'Escape', 'Minus', 'Period', 'Semicolon', 'Slash', 'Space',
  'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace',
])
const MODIFIER_ORDER = ['Meta', 'Control', 'Alt', 'Shift'] as const

function cloneDefaults(): Preferences {
  return {
    version: 1,
    editor: { ...DEFAULT_PREFERENCES.editor },
    go: { ...DEFAULT_PREFERENCES.go },
    run: { ...DEFAULT_PREFERENCES.run },
    appearance: { ...DEFAULT_PREFERENCES.appearance },
    project: { ...DEFAULT_PREFERENCES.project },
    versionControl: { ...DEFAULT_PREFERENCES.versionControl },
    terminal: { ...DEFAULT_PREFERENCES.terminal },
    shortcuts: { ...DEFAULT_SHORTCUTS },
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

function normalizedKey(raw: string): string | null {
  const aliases: Record<string, string> = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote', '\\': 'Backslash',
    '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', ' ': 'Space',
    Esc: 'Escape', Ctrl: 'Control', Cmd: 'Meta', Option: 'Alt',
  }
  const key = aliases[raw] ?? raw
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || KEY_NAMES.has(key)) return key
  return null
}

/** Returns a canonical shortcut or null when the input cannot be bound. */
export function normalizeShortcut(value: unknown): Shortcut {
  if (value === 'DoubleShift') return 'DoubleShift'
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim())
  const key = normalizedKey(parts.pop() ?? '')
  if (!key) return null
  const modifiers = new Set<string>()
  for (const raw of parts) {
    const modifier = raw === 'Ctrl' ? 'Control' : raw === 'Cmd' ? 'Meta' : raw === 'Option' ? 'Alt' : raw
    if (!MODIFIER_ORDER.some((item) => item === modifier) || modifiers.has(modifier)) return null
    modifiers.add(modifier)
  }
  if (!modifiers.size && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return null
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+')
}

/** Keep old or malformed storage from breaking the editor. */
export function normalizePreferences(value: unknown): Preferences {
  const defaults = cloneDefaults()
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return defaults
  const saved = value as {
    editor?: Record<string, unknown>
    go?: Record<string, unknown>
    run?: Record<string, unknown>
    appearance?: Record<string, unknown>
    project?: Record<string, unknown>
    versionControl?: Record<string, unknown>
    terminal?: Record<string, unknown>
    shortcuts?: Record<string, unknown>
  }
  const editor = saved.editor
  if (editor && typeof editor === 'object') {
    defaults.editor.fontSize = boundedInteger(editor.fontSize, defaults.editor.fontSize, 10, 28)
    defaults.editor.lineHeight = boundedInteger(editor.lineHeight, defaults.editor.lineHeight, 16, 44)
    defaults.editor.tabSize = boundedInteger(editor.tabSize, defaults.editor.tabSize, 1, 8)
    if (typeof editor.insertSpaces === 'boolean') defaults.editor.insertSpaces = editor.insertSpaces
    if (typeof editor.minimap === 'boolean') defaults.editor.minimap = editor.minimap
    if (typeof editor.wordWrap === 'boolean') defaults.editor.wordWrap = editor.wordWrap
    if (typeof editor.showLineNumbers === 'boolean') defaults.editor.showLineNumbers = editor.showLineNumbers
    if (typeof editor.showWhitespace === 'boolean') defaults.editor.showWhitespace = editor.showWhitespace
  }
  if (saved.go && typeof saved.go === 'object') {
    if (typeof saved.go.formatOnSave === 'boolean') defaults.go.formatOnSave = saved.go.formatOnSave
    if (typeof saved.go.organizeImportsOnSave === 'boolean') defaults.go.organizeImportsOnSave = saved.go.organizeImportsOnSave
    if (typeof saved.go.staticcheck === 'boolean') defaults.go.staticcheck = saved.go.staticcheck
    if (typeof saved.go.gofumpt === 'boolean') defaults.go.gofumpt = saved.go.gofumpt
    if (typeof saved.go.inlayHints === 'boolean') defaults.go.inlayHints = saved.go.inlayHints
    if (typeof saved.go.localPrefix === 'string') defaults.go.localPrefix = saved.go.localPrefix.slice(0, 500)
  }
  if (saved.run && typeof saved.run === 'object') {
    if (typeof saved.run.saveBeforeRun === 'boolean') defaults.run.saveBeforeRun = saved.run.saveBeforeRun
    if (Array.isArray(saved.run.runConfigurations)) {
      defaults.run.runConfigurations = saved.run.runConfigurations
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item): RunConfiguration => ({
          id: typeof item.id === 'string' && item.id ? item.id : `config-${Math.random().toString(36).slice(2, 9)}`,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Run',
          kind: item.kind === 'test' || item.kind === 'build' || item.kind === 'bench' ? item.kind : 'run',
          scope: item.scope === 'file' || item.scope === 'package' || item.scope === 'directory' ? item.scope : 'workspace',
          targetPath: typeof item.targetPath === 'string' && item.targetPath ? item.targetPath : null,
          testName: typeof item.testName === 'string' && item.testName ? item.testName : null,
          programArgs: typeof item.programArgs === 'string' ? item.programArgs : '',
          envVars: typeof item.envVars === 'string' ? item.envVars : '',
          buildTags: typeof item.buildTags === 'string' ? item.buildTags : '',
          race: item.race === true,
          beforeLaunch: item.beforeLaunch === 'tidy' || item.beforeLaunch === 'build' ? item.beforeLaunch : 'none',
          benchPattern: typeof item.benchPattern === 'string' ? item.benchPattern : '',
        }))
        .slice(0, 40)
    }
    if (typeof saved.run.selectedRunConfigurationId === 'string' || saved.run.selectedRunConfigurationId === null) {
      defaults.run.selectedRunConfigurationId = saved.run.selectedRunConfigurationId
    }
  }
  if (saved.appearance && typeof saved.appearance === 'object') {
    if (typeof saved.appearance.compactMode === 'boolean') defaults.appearance.compactMode = saved.appearance.compactMode
    if (saved.appearance.theme === 'light' || saved.appearance.theme === 'system') defaults.appearance.theme = saved.appearance.theme
  }
  if (saved.project && typeof saved.project === 'object') {
    if (typeof saved.project.showHiddenFiles === 'boolean') defaults.project.showHiddenFiles = saved.project.showHiddenFiles
    if (typeof saved.project.autoRevealCurrentFile === 'boolean') defaults.project.autoRevealCurrentFile = saved.project.autoRevealCurrentFile
  }
  if (saved.versionControl && typeof saved.versionControl === 'object') {
    const seconds = saved.versionControl.gitAutoRefreshSeconds
    if (seconds === 0 || seconds === 5 || seconds === 15 || seconds === 30) defaults.versionControl.gitAutoRefreshSeconds = seconds
  }
  if (saved.terminal && typeof saved.terminal === 'object') {
    defaults.terminal.fontSize = boundedInteger(saved.terminal.fontSize, defaults.terminal.fontSize, 10, 24)
  }
  const shortcuts = saved.shortcuts
  if (shortcuts && typeof shortcuts === 'object') {
    for (const id of ACTION_IDS) {
      if (!(id in shortcuts)) continue
      if (shortcuts[id] === null) defaults.shortcuts[id] = null
      else defaults.shortcuts[id] = normalizeShortcut(shortcuts[id]) ?? DEFAULT_SHORTCUTS[id]
    }
    // Earlier versions used ⌘S for Save All. Move that old default when the
    // newly introduced Save Current binding is absent, so both remain usable.
    if (!('saveCurrent' in shortcuts) && defaults.shortcuts.saveAll === 'Meta+S') {
      defaults.shortcuts.saveAll = DEFAULT_SHORTCUTS.saveAll
    }
  }
  return defaults
}

export function loadPreferences(): Preferences {
  if (typeof localStorage === 'undefined') return cloneDefaults()
  try {
    const saved = localStorage.getItem(PREFERENCES_STORAGE_KEY)
    return saved ? normalizePreferences(JSON.parse(saved) as unknown) : cloneDefaults()
  } catch {
    return cloneDefaults()
  }
}

/** Persists and broadcasts the normalized preferences. The returned value is safe to put in React state. */
export function savePreferences(value: Preferences): Preferences {
  const normalized = normalizePreferences(value)
  try { localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalized)) }
  catch { /* An unavailable storage backend should not prevent changing this session's settings. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Preferences>(PREFERENCES_CHANGED_EVENT, { detail: normalized }))
  return normalized
}

export function subscribePreferences(listener: (preferences: Preferences) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onChange = (event: Event) => listener((event as CustomEvent<Preferences>).detail)
  const onStorage = (event: StorageEvent) => {
    if (event.key === PREFERENCES_STORAGE_KEY) listener(loadPreferences())
  }
  window.addEventListener(PREFERENCES_CHANGED_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PREFERENCES_CHANGED_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function eventKey(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (KEY_NAMES.has(event.code) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code
  return normalizedKey(event.key)
}

/** Modifier-only keydowns return null; use createShortcutMatcher for DoubleShift. */
export function shortcutFromKeyboardEvent(event: KeyboardEvent): Shortcut {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null
  const key = eventKey(event)
  if (!key) return null
  return normalizeShortcut([
    event.metaKey && 'Meta', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key,
  ].filter(Boolean).join('+'))
}

export function shortcutLabel(shortcut: Shortcut): string {
  if (!shortcut) return '未设置'
  if (shortcut === 'DoubleShift') return '⇧ ⇧'
  const symbols: Record<string, string> = {
    Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧',
    Backquote: '`', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', Enter: '↩',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Delete: '⌦', Backspace: '⌫', Tab: '⇥', Minus: '-', Equal: '=', Semicolon: ';',
  }
  return shortcut.split('+').map((part) => symbols[part] ?? part).join('')
}

export function shortcutConflicts(shortcuts: Preferences['shortcuts'], action: ShortcutAction, shortcut: Shortcut): ShortcutAction[] {
  if (!shortcut) return []
  return ACTION_IDS.filter((id) => id !== action && shortcuts[id] === shortcut)
}

/** Keeps the double Shift gesture separate from ordinary key combinations. */
export function createShortcutMatcher() {
  let lastShift = -Infinity
  return (event: KeyboardEvent, shortcuts: Preferences['shortcuts']): ShortcutAction | null => {
    if (event.key === 'Shift' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const current = event.timeStamp
      const doubleShift = current - lastShift <= 500
      lastShift = doubleShift ? -Infinity : current
      return doubleShift ? ACTION_IDS.find((id) => shortcuts[id] === 'DoubleShift') ?? null : null
    }
    lastShift = -Infinity
    const binding = shortcutFromKeyboardEvent(event)
    return binding ? ACTION_IDS.find((id) => shortcuts[id] === binding) ?? null : null
  }
}
