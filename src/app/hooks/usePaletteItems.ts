import { useEffect, useMemo, useState, useSyncExternalStore, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { AppWindow, Braces, Download, FlaskConical, FolderOpen, FolderPlus, GitBranch, Hammer, Package, Play, Settings2, TerminalSquare, Wrench } from 'lucide-react'
import { displayName, relativePath, type FileEntry } from '../../lib/api'
import { type GoplsClient, type WorkspaceSymbolEntry } from '../../lib/lsp'
import { goStructs } from '../../lib/goGenerate'
import { getEnabledPluginActions, getPlugins, subscribePlugins, executePluginAction } from '../../lib/plugins/plugins'
import type { NativePluginHost } from '../../lib/plugins/nativePluginHost'
import type { InstalledNativePlugin } from '../../lib/plugins/nativePlugins'
import type { LspCodeAction } from '../../lib/lsp/protocol'
import type { Locale, MessageKey } from '../../lib/i18n'
import { entryIcon, isWorkspaceFile } from '../helpers'
import type { LspState, PaletteMode, PanelView } from '../types'
import type { SettingsSection } from '../../components/SettingsPane'
import type { useNavigation } from './useNavigation'
import type { useTasks } from './useTasks'
import type { useGit } from './useGit'
import type { useCodeActions } from './useCodeActions'

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

interface UsePaletteItemsParams {
  root: string | null
  projectFiles: FileEntry[]
  activeFileContent: string
  cursor: { line: number; column: number }
  paletteOpen: boolean
  paletteMode: PaletteMode
  paletteQuery: string
  lspState: LspState
  lspRef: RefObject<GoplsClient | null>
  activePathRef: RefObject<string | null>
  historyRef: ReturnType<typeof useNavigation>['historyRef']
  historyAvailability: { back: boolean; forward: boolean }
  intentionItems: LspCodeAction[]
  nativePlugins: InstalledNativePlugin[]
  nativePluginHostRef: RefObject<NativePluginHost | null>
  locale: Locale
  navigateTo: ReturnType<typeof useNavigation>['navigateTo']
  openEmptyWindow: () => Promise<void>
  openNewProject: () => Promise<void>
  chooseWorkspace: () => Promise<void>
  openFile: (path: string, options?: { preserveNavigation?: boolean }) => Promise<boolean>
  runTask: ReturnType<typeof useTasks>['runTask']
  refreshGit: ReturnType<typeof useGit>['refreshGit']
  runGenerate: ReturnType<typeof useCodeActions>['runGenerate']
  setPanelOpen: Dispatch<SetStateAction<boolean>>
  setPanelView: Dispatch<SetStateAction<PanelView>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: Translate
}

/** Builds the search palette from commands, files, symbols and plugins. */
export function usePaletteItems({
  root, projectFiles, activeFileContent, cursor, paletteOpen, paletteMode,
  paletteQuery, lspState, lspRef, activePathRef, historyRef, historyAvailability,
  intentionItems, nativePlugins, nativePluginHostRef, locale, navigateTo,
  openEmptyWindow, openNewProject, chooseWorkspace, openFile, runTask,
  refreshGit, runGenerate, setPanelOpen, setPanelView, setSettingsOpen,
  setSettingsSection, notify, formatError, t,
}: UsePaletteItemsParams) {
  const installedPlugins = useSyncExternalStore(subscribePlugins, getPlugins, getPlugins)
  const [symbolResults, setSymbolResults] = useState<WorkspaceSymbolEntry[]>([])

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

  return paletteItems
}
