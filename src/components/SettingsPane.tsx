import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { RotateCcw, X } from 'lucide-react'
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, shortcutConflicts, shortcutFromKeyboardEvent,
  shortcutLabel, type AppearancePreferences, type EditorPreferences, type ThemePreference,
  type GitAutoRefreshSeconds, type Preferences, type ProjectPreferences, type Shortcut,
  type ShortcutAction, type TerminalPreferences, type VersionControlPreferences,
} from '../lib/preferences'
import type { ToolVersions } from '../lib/api'
import type { Locale } from '../lib/i18n'
import type { PluginsPaneProps } from './PluginsPane'
import { PluginsPane } from './PluginsPane'
import { Dropdown } from '../app/ui/Dropdown'
import './SettingsPane.css'

export interface SettingsPaneProps {
  preferences: Preferences
  /** The owner persists the returned value after Apply or OK. */
  onChange: (next: Preferences) => void
  onClose: () => void
  initialSection?: SettingsSection
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  onOpenPlugins?: () => void
  versions?: ToolVersions | null
  lspState?: 'idle' | 'starting' | 'ready' | 'missing' | 'error'
  onInstallGopls?: () => void | Promise<void>
  onRestartGopls?: () => void | Promise<void>
  goToolBusy?: boolean
  /** Runs a go task such as install_dlv / install_govulncheck for the Go tools page. */
  onInstallTool?: (task: string) => void | Promise<void>
  pluginManager?: Omit<PluginsPaneProps, 'onClose' | 'embedded' | 'locale'>
  /** Where style-family Go settings are written: the global scheme or the project scheme. */
  goScope?: 'global' | 'project'
  onGoScopeChange?: (scope: 'global' | 'project') => void
  hasProject?: boolean
  projectScopeAvailable?: boolean
  /** How many Go settings the project scheme overrides; 0 = inheriting global. */
  projectOverrideCount?: number
  onClearProjectGoOverrides?: () => void
  onOpenStyleFile?: () => void
}

export type SettingsSection = 'go' | 'editor' | 'editorCodeStyle' | 'project' | 'appearance' | 'language' | 'shortcuts' | 'editorGeneral' | 'editorFont' | 'plugins' | 'versionControl' | 'run' | 'terminal'
type Section = SettingsSection
type StyleTab = 'indent' | 'imports' | 'other'
type Conflict = { action: ShortcutAction; shortcut: Shortcut; previous: ShortcutAction[] }

type NavPage = { id: Section; label: string; keywords: string }
type NavGroup = { id: string; label: string; children: NavPage[] }
type NavItem = NavPage | NavGroup

export const NAV_ITEMS: NavItem[] = [
  { id: 'go', label: 'Go', keywords: 'Go SDK gopls Go 工具链 保存时格式化 format on save' },
  { id: 'project', label: '项目结构', keywords: '项目树 隐藏文件 当前文件 Project Structure' },
  { id: 'appearanceGroup', label: '外观与行为', children: [
    { id: 'appearance', label: '外观', keywords: '紧凑模式 界面布局 Appearance compact' },
    { id: 'language', label: '语言', keywords: '界面语言 简体中文 English language' },
  ] },
  { id: 'shortcuts', label: '按键映射', keywords: '快捷键 Keymap 键位 搜索 运行 保存' },
  { id: 'editorGroup', label: '编辑器', children: [
    { id: 'editorGeneral', label: '常规', keywords: '自动换行 缩略图 行号 空白字符 word wrap minimap line numbers whitespace' },
    { id: 'editorFont', label: '字体', keywords: '字体大小 行高 font size line height' },
    { id: 'editorCodeStyle', label: '代码样式', keywords: 'Tab 宽度 插入空格 EditorConfig 缩进 import 顺序 分组 空行 code style tab indent spaces' },
  ] },
  { id: 'plugins', label: '插件', keywords: '插件 安装 导入 原生 JSON marketplace 本地 .gomavo-plugin Plugins Install from Disk' },
  { id: 'versionControl', label: '版本控制', keywords: 'Git 自动刷新 version control refresh' },
  { id: 'runGroup', label: '构建、执行、部署', children: [
    { id: 'run', label: '运行与测试', keywords: '运行前保存 测试 编译 save before run build test deployment' },
  ] },
  { id: 'toolsGroup', label: '工具', children: [
    { id: 'terminal', label: '终端', keywords: '终端文字大小 Terminal font size' },
  ] },
]

const GROUPS = ['导航', '工具窗口', '代码', '运行'] as const
const ENGLISH: Record<string, string> = {
  '设置': 'Settings', '编辑器和快捷键': 'Configure GoMavo for your workflow',
  '关闭设置': 'Close settings', '设置分类': 'Settings categories',
  '搜索设置': 'Search settings', '搜索设置…': 'Search settings…', '清除搜索': 'Clear search',
  '没有匹配的设置': 'No matching settings', '尝试搜索“插件”“字体”或“Go”': 'Try “plugins”, “font”, or “Go”',
  '应用': 'Apply', '确定': 'OK', '未应用的更改': 'Unapplied changes',
  'Go 工具链': 'Go toolchain', '保存时格式化 Go 文件': 'Format Go files on save',
  '使用 gopls 格式化后再写入磁盘；gopls 不可用时仍会保存原文。': 'Format with gopls before writing to disk. Saving still works when gopls is unavailable.',
  '已就绪': 'Ready', '启动中': 'Starting', '未安装': 'Not installed', '未连接': 'Not connected', '启动失败': 'Failed to start',
  '安装 gopls': 'Install gopls', '重启 gopls': 'Restart gopls',
  'Go 版本': 'Go version', '语言服务': 'Language server', '未检测到 Go 工具链': 'Go toolchain not found',
  '安装 Go 后重启 GoMavo，才能使用运行、测试和语言服务。': 'Install Go and restart GoMavo to use run, test, and language services.',
  '使用本机 Go 工具链与 gopls；此处显示当前检测结果。': 'Uses your local Go toolchain and gopls. Current detection is shown here.',
  '项目结构': 'Project Structure', '外观与行为': 'Appearance & Behavior', '按键映射': 'Keymap',
  '常规': 'General', '字体': 'Font', '代码样式': 'Code Style', '构建、执行、部署': 'Build, Execution, Deployment',
  '运行与测试': 'Run & Test', '工具': 'Tools',
  '显示行号': 'Show line numbers', '在代码左侧显示行号': 'Show line numbers beside code',
  '显示空白字符': 'Show whitespace', '显示空格和 Tab 标记': 'Show spaces and tab markers',
  '运行前保存修改': 'Save modified files before running',
  '运行、测试或编译前保存打开的修改；关闭后任务使用磁盘上的上次保存内容。': 'Save open changes before running, testing, or building. Off uses the last saved version on disk.',
  'Go 任务': 'Go tasks', '运行与测试选项': 'Run and test options',
  '按顶部运行配置选择项目、文件或测试方法的运行范围。': 'Choose project, file, or test method scope from the toolbar run configuration.',
  '设置保存后生效；插件安装和启停立即生效。': 'Settings take effect when applied. Plugin installation and activation take effect immediately.',
  '后退到上一设置': 'Back to previous setting', '前进到下一设置': 'Forward to next setting',
  '外观': 'Appearance', '编辑器': 'Editor', '项目': 'Project', '版本控制': 'Version Control',
  '终端': 'Terminal', '快捷键': 'Keymap', '语言': 'Language', '插件': 'Plugins',
  '界面布局': 'Interface layout', '紧凑模式': 'Compact mode',
  '缩小工具栏、列表和标签的间距': 'Use less space in the toolbar, lists and tabs',
  '调整代码阅读和输入方式。': 'Adjust code display and input.',
  '项目中的 .editorconfig 会覆盖缩进设置，并在保存时应用换行和空白规则。': 'Project .editorconfig files override indentation and apply line ending and whitespace rules on save.',
  '字体大小': 'Font size', '代码编辑器中的文字大小': 'Text size in the code editor',
  '行高': 'Line height', '每行代码占用的高度': 'Height of each code line',
  'Tab 宽度': 'Tab size', '一个 Tab 对应的列数': 'Number of columns in one tab',
  '列': 'columns', '按 Tab 时插入空格': 'Insert spaces for Tab', '关闭时插入 Tab 字符': 'Off inserts a tab character',
  '显示代码缩略图': 'Show minimap', '在编辑器右侧显示 minimap': 'Show a code overview on the right',
  '自动换行': 'Word wrap', '长代码行在编辑器视口内折行': 'Wrap long lines within the editor',
  '项目文件显示': 'Project files', '显示隐藏文件': 'Show hidden files',
  '在项目树中显示以点开头的文件（不含 .git 等排除目录）': 'Show dotfiles in the project tree (excluding directories such as .git)',
  '自动定位当前文件': 'Always select opened file',
  '打开或切换文件时在项目树中展开并选中它': 'Expand and select the active file in the project tree',
  'Git 状态刷新': 'Git status refresh', '自动刷新间隔': 'Auto refresh interval',
  '定期更新分支和更改列表；关闭时仍可手动刷新': 'Update branch and changes on a timer; manual refresh remains available',
  '关闭': 'Off', '每 5 秒': 'Every 5 seconds', '每 15 秒': 'Every 15 seconds', '每 30 秒': 'Every 30 seconds',
  '终端显示': 'Terminal display', '终端文字大小': 'Terminal font size',
  '新终端会话和现有终端的文字大小': 'Text size in existing and new terminal sessions',
  '默认采用 macOS 常用键位。点击键位后按新组合键，按 Delete 清除。': 'Uses common macOS shortcuts by default. Click a shortcut and press a new combination; Delete clears it.',
  '恢复默认': 'Restore defaults', '取消': 'Cancel', '改绑': 'Reassign',
  '已用于': 'is already assigned to', '是否改绑到': 'Reassign it to',
  '双击 Shift 可设为“搜索所有内容”；Esc 取消录制。系统或应用保留的组合键可能无法覆盖。': 'Press Shift twice to assign Search Everywhere. Esc cancels recording. System shortcuts may be unavailable.',
  '再按一次 ⇧': 'Press ⇧ again', '请按组合键…': 'Press shortcut…', '未设置': 'Unassigned',
  '正在录制快捷键': 'Recording shortcut', '恢复': 'Restore',
  '界面语言': 'Interface language', '更改 GoMavo 界面的显示语言': 'Change the language shown in GoMavo',
  '简体中文': 'Simplified Chinese', 'English': 'English',
  '本地命令插件': 'Local command plugins', '管理插件': 'Manage plugins',
  '导入、启停或移除 GoMavo JSON 命令扩展': 'Import, enable, disable or remove GoMavo JSON command extensions',
  '导航': 'Navigation', '工具窗口': 'Tool Windows', '代码': 'Code', '运行': 'Run',
  '搜索所有内容': 'Search Everywhere', '打开文件与命令搜索': 'Search files and commands',
  '转到文件': 'Go to File', '搜索工作区文件': 'Search workspace files',
  '查找操作': 'Find Action', '搜索可执行操作': 'Search available actions',
  '跳转到定义': 'Go to Declaration', '打开光标处符号的定义': 'Open the symbol under the cursor',
  '后退': 'Back', '返回上一个代码位置': 'Return to the previous code location',
  '前进': 'Forward', '前往下一个代码位置': 'Move to the next code location',
  'Project 工具窗口': 'Project tool window', '显示或隐藏项目文件': 'Show or hide project files',
  'Git 工具窗口': 'Git tool window', '显示或隐藏 Git 状态': 'Show or hide Git status',
  'Terminal 工具窗口': 'Terminal tool window', '显示或隐藏集成终端': 'Show or hide the terminal',
  'Run 工具窗口': 'Run tool window', '显示或隐藏运行输出': 'Show or hide run output',
  'Problems 工具窗口': 'Problems tool window', '显示或隐藏诊断列表': 'Show or hide diagnostics',
  '保存当前文件': 'Save Current File', '保存当前编辑标签': 'Save the active editor tab',
  '保存所有文件': 'Save All', '保存全部未保存的编辑标签': 'Save all unsaved editor tabs',
  '格式化 Go 代码': 'Reformat Go Code', '执行格式化操作': 'Format code',
  '打开设置': 'Open Settings', '打开编辑器与快捷键设置': 'Open editor and keymap settings',
  '运行当前上下文': 'Run Current Context', '测试文件中运行光标方法或当前文件；其他情况运行顶部配置': 'Run the test at the cursor or the current test file; otherwise run the selected configuration',
  '运行全部测试': 'Run All Tests', '运行项目中的所有 Go 测试': 'Run every Go test in the project',
  '编译项目': 'Build Project', '编译项目中的 Go 包': 'Build Go packages in the project',
  '停止任务': 'Stop Task', '停止当前运行或测试任务': 'Stop the current run or test task',
  '整理 Go 模块': 'Tidy Go Modules', '执行 go mod tidy': 'Run go mod tidy',
  '格式化、import 整理与代码风格在「代码样式 · Go」中按方案设置': 'Formatting, import optimizing, and code style live in Code Style · Go, organized by scheme',
  '缩进、导入分组与保存动作；Go 设置可使用全局或当前项目方案': 'Indentation, import grouping, and save actions; Go settings can use a global or project scheme',
  '方案': 'Scheme', 'Go 风格设置对所有项目生效，或仅作用于当前项目': 'Go style settings apply to all projects or to the current project only.',
  '全局（所有项目）': 'Global (all projects)', '仅当前项目': 'Current project only',
  '当前项目覆盖': 'Project overrides', '{count} 项设置在当前项目使用独立值': '{count} settings use project-specific values', '还原全局默认': 'Restore global defaults',
  '当前项目的 Go 设置保存在 .gomavo/code-style.json；已有 .editorconfig 仍控制缩进、换行和空白规则。': 'Project Go settings are saved in .gomavo/code-style.json; existing .editorconfig files still control indentation, line endings, and whitespace.',
  '打开或创建项目配置': 'Open or create project config',
  '制表符和缩进': 'Tabs and Indents', '导入': 'Imports', '其他': 'Other',
  '保存时整理 imports': 'Optimize imports on save', '对应 GoLand 的 Optimize imports：排序、按分组排列并删除未使用的导入': 'Matches GoLand’s Optimize Imports: sort, group, and drop unused imports',
  '导入顺序': 'Import order', '标准库 → 第三方模块 → 匹配本地前缀的模块；组内按路径排序。由 gopls 固定。': 'Standard library → third-party modules → modules matching the local prefix; sorted by path within each group. Fixed by gopls.',
  '分组之间的空行': 'Blank lines between groups', '每两个非空导入组之间一个空行；组内无空行。由 gopls 固定。': 'One blank line separates each pair of nonempty import groups; no blank lines within a group. Fixed by gopls.',
  '本地导入分组前缀': 'Local import prefix', '逗号分隔的模块路径；匹配的导入排在第三方模块之后': 'Comma-separated module paths; matching imports are placed after third-party modules',
  'gofumpt 严格代码风格': 'gofumpt strict code style', '在 gofmt 基础上套用更严格的风格规则（保存格式化时生效）': 'Stricter style rules on top of gofmt (applied when formatting on save)',
  'staticcheck 代码检查': 'staticcheck inspections', 'gopls 的 staticcheck 诊断与快速修复（对应 GoLand 的 inspection）': 'gopls staticcheck diagnostics and quick fixes (GoLand-style inspections)',
  'Inlay Hints 内联提示': 'Inlay hints', 'gopls 显示参数名、推断类型和常量值': 'gopls shows parameter names, inferred types, and constant values',
}

function localize(locale: Locale | undefined, text: string): string {
  return locale === 'en-US' ? ENGLISH[text] ?? text : text
}

function NumberSetting({ id, label, description, value, min, max, unit, onChange }: {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  unit: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return <div className="mg-settings-field">
    <div><label htmlFor={id}>{label}</label><span>{description}</span></div>
    <div className="mg-settings-number"><input id={id} type="number" min={min} max={max} step="1" value={draft} onChange={(event) => {
      const next = event.target.value
      setDraft(next)
      const numeric = Number(next)
      if (next !== '' && Number.isInteger(numeric) && numeric >= min && numeric <= max) onChange(numeric)
    }} onBlur={() => setDraft(String(value))} /><span>{unit}</span></div>
  </div>
}

export function SettingsPane({ preferences, onChange, onClose, initialSection, locale, onLocaleChange, versions, lspState, onInstallGopls, onRestartGopls, goToolBusy, onInstallTool, pluginManager, goScope, onGoScopeChange, hasProject, projectScopeAvailable, projectOverrideCount, onClearProjectGoOverrides, onOpenStyleFile }: SettingsPaneProps) {
  const [section, setSection] = useState<Section>(initialSection ?? 'editor')
  const [styleTab, setStyleTab] = useState<StyleTab>('indent')
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [shiftArmed, setShiftArmed] = useState(false)
  const shiftAtRef = useRef(-Infinity)
  const recordButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const t = (text: string, values?: Record<string, string | number>) => { const base = localize(locale, text); return values ? base.replace(/\{([^{}]+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match) : base }

  useEffect(() => { closeButtonRef.current?.focus() }, [])
  useEffect(() => {
    if (recording) recordButtonRef.current?.focus()
  }, [recording])

  const updateEditor = <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => {
    onChange({ ...preferences, editor: { ...preferences.editor, [key]: value } })
  }

  const updateAppearance = <K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => {
    onChange({ ...preferences, appearance: { ...preferences.appearance, [key]: value } })
  }

  const updateProject = <K extends keyof ProjectPreferences>(key: K, value: ProjectPreferences[K]) => {
    onChange({ ...preferences, project: { ...preferences.project, [key]: value } })
  }

  const updateVersionControl = <K extends keyof VersionControlPreferences>(key: K, value: VersionControlPreferences[K]) => {
    onChange({ ...preferences, versionControl: { ...preferences.versionControl, [key]: value } })
  }

  const updateTerminal = <K extends keyof TerminalPreferences>(key: K, value: TerminalPreferences[K]) => {
    onChange({ ...preferences, terminal: { ...preferences.terminal, [key]: value } })
  }

  const cancelRecording = () => {
    setRecording(null)
    setShiftArmed(false)
    shiftAtRef.current = -Infinity
  }

  const assignShortcut = (action: ShortcutAction, shortcut: Shortcut) => {
    const previous = shortcutConflicts(preferences.shortcuts, action, shortcut)
    if (previous.length) {
      setConflict({ action, shortcut, previous })
      cancelRecording()
      return
    }
    onChange({ ...preferences, shortcuts: { ...preferences.shortcuts, [action]: shortcut } })
    setConflict(null)
    cancelRecording()
  }

  const acceptConflict = () => {
    if (!conflict) return
    const shortcuts = { ...preferences.shortcuts }
    for (const action of conflict.previous) shortcuts[action] = null
    shortcuts[conflict.action] = conflict.shortcut
    onChange({ ...preferences, shortcuts })
    setConflict(null)
  }

  const recordKey = (event: ReactKeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    if (recording !== action) return
    event.preventDefault()
    event.stopPropagation()
    const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (event.key === 'Escape' && plainKey) { cancelRecording(); return }
    if ((event.key === 'Backspace' || event.key === 'Delete') && plainKey) { assignShortcut(action, null); return }
    if (event.key === 'Shift' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.timeStamp - shiftAtRef.current <= 500) {
        assignShortcut(action, 'DoubleShift')
      } else {
        shiftAtRef.current = event.timeStamp
        setShiftArmed(true)
      }
      return
    }
    shiftAtRef.current = -Infinity
    setShiftArmed(false)
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    if (shortcut) assignShortcut(action, shortcut)
  }

  const switchSection = (next: Section) => {
    setSection(next)
    cancelRecording()
    setConflict(null)
  }

  return <div className="mg-settings-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <div
      className="mg-settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mg-settings-title"
      data-settings-pane="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !recording) {
          if (conflict) setConflict(null)
          else onClose()
        }
        if (event.key === 'Tab' && !recording) {
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
        event.stopPropagation()
      }}
    >
      <header className="mg-settings-header">
        <div>
          <h2 id="mg-settings-title">{t('设置')}</h2>
          <p>{t('编辑器和快捷键')}</p>
        </div>
        <button ref={closeButtonRef} type="button" className="mg-settings-icon-button" aria-label={t('关闭设置')} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="mg-settings-body">
        <nav className="mg-settings-nav" aria-label={t('设置分类')}>
          {([
            ['go', 'Go 工具链'], ['appearance', '外观'], ['editor', '编辑器'], ['editorCodeStyle', '代码样式'], ['project', '项目'],
            ['versionControl', '版本控制'], ['run', '运行'], ['terminal', '终端'], ['shortcuts', '快捷键'],
            ['plugins', '插件'],
            ...(locale && onLocaleChange ? [['language', '语言']] : []),
          ] as [Section, string][]).map(([id, label]) => <button key={id} type="button" className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => switchSection(id)}>{t(label)}</button>)}
        </nav>
        <main className="mg-settings-content">
          {section === 'go' && <>
            <div className="mg-settings-section-heading"><h3>{t('Go 工具链')}</h3><p>{t('工具链版本、gopls 语言服务与代码辅助')}</p></div>
            <div className="mg-settings-tools">
              {([['go', 'Go', versions?.go], ['gopls', 'gopls', versions?.gopls], ['git', 'Git', versions?.git], ['dlv', 'Delve (dlv)', versions?.dlv], ['govulncheck', 'govulncheck', versions?.govulncheck]] as [string, string, string | null | undefined][]).map(([id, label, value]) => <div className="mg-settings-field mg-settings-tool-row" key={id}>
                <div><strong>{label}</strong><span>{value ?? t('未安装')}</span></div>
                <div className="mg-settings-tool-actions">
                  {!value && id !== 'git' && <button type="button" className="mg-settings-action-button" disabled={goToolBusy} onClick={() => id === 'gopls' ? void onInstallGopls?.() : void onInstallTool?.(`install_${id}`)}>{t('安装')}</button>}
                  {id === 'gopls' && value && <button type="button" className="mg-settings-action-button" disabled={goToolBusy} onClick={() => void onInstallGopls?.()}>{t('升级到最新版')}</button>}
                  {id === 'gopls' && <button type="button" className="mg-settings-action-button" onClick={() => void onRestartGopls?.()}>{t('重启')}</button>}
                </div>
              </div>)}
            </div>
            <div className="mg-settings-field">
              <div><strong>{t('gopls 状态')}</strong><span>{lspState === 'ready' ? t('已就绪') : lspState === 'starting' ? t('gopls 启动中') : lspState === 'missing' ? t('gopls 未安装') : lspState === 'error' ? t('gopls 错误') : t('空闲')}</span></div>
            </div>
            <p className="mg-settings-shortcut-hint">{t('格式化、import 整理与代码风格在「代码样式 · Go」中按方案设置')}</p>
          </>}
          {section === 'appearance' && <>
            <div className="mg-settings-section-heading"><h3>{t('外观')}</h3><p>{t('界面布局')}</p></div>
            <div className="mg-settings-field">
              <div><label htmlFor="mg-setting-theme">{t('主题')}</label><span>{t('深色或浅色界面，可跟随系统')}</span></div>
              <Dropdown ariaLabel={t('主题')} value={preferences.appearance.theme} options={[{ value: 'dark', label: t('深色') }, { value: 'light', label: t('浅色') }, { value: 'system', label: t('跟随系统') }]} onChange={(theme) => updateAppearance('theme', theme as ThemePreference)} />
            </div>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('紧凑模式')}</strong><span>{t('缩小工具栏、列表和标签的间距')}</span></div>
              <input type="checkbox" checked={preferences.appearance.compactMode} onChange={(event) => updateAppearance('compactMode', event.target.checked)} />
            </label>
          </>}
          {section === 'editor' && <>
            <div className="mg-settings-section-heading">
              <h3>{t('编辑器')}</h3>
              <p>{t('调整代码阅读和输入方式。修改会立即生效。')}</p>
              <p>{t('项目中的 .editorconfig 会覆盖缩进设置，并在保存时应用换行和空白规则。')}</p>
            </div>
            <NumberSetting id="mg-setting-font-size" label={t('字体大小')} description={t('代码编辑器中的文字大小')} value={preferences.editor.fontSize} min={10} max={28} unit="px" onChange={(value) => updateEditor('fontSize', value)} />
            <NumberSetting id="mg-setting-line-height" label={t('行高')} description={t('每行代码占用的高度')} value={preferences.editor.lineHeight} min={16} max={44} unit="px" onChange={(value) => updateEditor('lineHeight', value)} />
            <NumberSetting id="mg-setting-tab-size" label={t('Tab 宽度')} description={t('一个 Tab 对应的列数')} value={preferences.editor.tabSize} min={1} max={8} unit={t('列')} onChange={(value) => updateEditor('tabSize', value)} />
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('按 Tab 时插入空格')}</strong><span>{t('关闭时插入 Tab 字符')}</span></div>
              <input type="checkbox" checked={preferences.editor.insertSpaces} onChange={(event) => updateEditor('insertSpaces', event.target.checked)} />
            </label>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('显示代码缩略图')}</strong><span>{t('在编辑器右侧显示 minimap')}</span></div>
              <input type="checkbox" checked={preferences.editor.minimap} onChange={(event) => updateEditor('minimap', event.target.checked)} />
            </label>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('自动换行')}</strong><span>{t('长代码行在编辑器视口内折行')}</span></div>
              <input type="checkbox" checked={preferences.editor.wordWrap} onChange={(event) => updateEditor('wordWrap', event.target.checked)} />
            </label>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('Inlay Hints 内联提示')}</strong><span>{t('gopls 显示参数名、推断类型和常量值')}</span></div>
              <input type="checkbox" checked={preferences.go.inlayHints} onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, inlayHints: event.target.checked } })} />
            </label>
          </>}
          {section === 'editorCodeStyle' && <>
            <div className="mg-settings-section-heading"><h3>{t('代码样式')} · Go</h3><p>{t('缩进、导入分组与保存动作；Go 设置可使用全局或当前项目方案')}</p></div>
            <div className="mg-settings-field">
              <div><label htmlFor="mg-setting-go-scheme">{t('方案')}</label><span>{t('Go 风格设置对所有项目生效，或仅作用于当前项目')}</span></div>
              <Dropdown ariaLabel={t('方案')} value={goScope ?? 'global'} options={[{ value: 'global', label: t('全局（所有项目）') }, ...(hasProject && projectScopeAvailable !== false ? [{ value: 'project', label: t('仅当前项目') }] : [])]} onChange={(next) => onGoScopeChange?.(next === 'project' ? 'project' : 'global')} />
            </div>
            {goScope === 'project' && (projectOverrideCount ?? 0) > 0 && <div className="mg-settings-field">
              <div><strong>{t('当前项目覆盖')}</strong><span>{t('{count} 项设置在当前项目使用独立值', { count: projectOverrideCount ?? 0 })}</span></div>
              <button type="button" className="mg-settings-action-button" onClick={() => onClearProjectGoOverrides?.()}>{t('还原全局默认')}</button>
            </div>}
            <div className="mg-settings-field">
              <div><strong>.gomavo/code-style.json</strong><span>{t('当前项目的 Go 设置保存在 .gomavo/code-style.json；已有 .editorconfig 仍控制缩进、换行和空白规则。')}</span></div>
              <button type="button" className="mg-settings-action-button" disabled={!hasProject} onClick={() => onOpenStyleFile?.()}>{t('打开或创建项目配置')}</button>
            </div>
            <div className="mg-settings-tabs" role="tablist" aria-label={t('代码样式')}>
              {([['indent', '制表符和缩进'], ['imports', '导入'], ['other', '其他']] as [StyleTab, string][]).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={styleTab === id} className={styleTab === id ? 'active' : ''} onClick={() => setStyleTab(id)}>{t(label)}</button>)}
            </div>
            {styleTab === 'indent' && <>
              <NumberSetting id="mg-setting-style-tab-size" label={t('Tab 宽度')} description={t('一个 Tab 对应的列数')} value={preferences.editor.tabSize} min={1} max={8} unit={t('列')} onChange={(value) => updateEditor('tabSize', value)} />
              <label className="mg-settings-field mg-settings-check-field">
                <div><strong>{t('按 Tab 时插入空格')}</strong><span>{t('关闭时插入 Tab 字符')}</span></div>
                <input type="checkbox" checked={preferences.editor.insertSpaces} onChange={(event) => updateEditor('insertSpaces', event.target.checked)} />
              </label>
            </>}
            {styleTab === 'imports' && <>
              <div className="mg-settings-field">
                <div><strong>{t('导入顺序')}</strong><span>{t('标准库 → 第三方模块 → 匹配本地前缀的模块；组内按路径排序。由 gopls 固定。')}</span></div>
              </div>
              <div className="mg-settings-field">
                <div><strong>{t('分组之间的空行')}</strong><span>{t('每两个非空导入组之间一个空行；组内无空行。由 gopls 固定。')}</span></div>
              </div>
              <label className="mg-settings-field mg-settings-check-field">
                <div><strong>{t('保存时整理 imports')}</strong><span>{t('对应 GoLand 的 Optimize imports：排序、按分组排列并删除未使用的导入')}</span></div>
                <input type="checkbox" checked={preferences.go.organizeImportsOnSave} onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, organizeImportsOnSave: event.target.checked } })} />
              </label>
              <div className="mg-settings-field">
                <div><label htmlFor="mg-setting-local-prefix">{t('本地导入分组前缀')}</label><span>{t('逗号分隔的模块路径；匹配的导入排在第三方模块之后')}</span></div>
                <input id="mg-setting-local-prefix" className="mg-settings-input" value={preferences.go.localPrefix} placeholder="my-company/internal" onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, localPrefix: event.target.value } })} />
              </div>
            </>}
            {styleTab === 'other' && <>
              <label className="mg-settings-field mg-settings-check-field">
                <div><strong>{t('保存时格式化 Go 代码')}</strong><span>{t('保存前交给 gopls gofmt，并套用 EditorConfig 规则')}</span></div>
                <input type="checkbox" checked={preferences.go.formatOnSave} onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, formatOnSave: event.target.checked } })} />
              </label>
              <label className="mg-settings-field mg-settings-check-field">
                <div><strong>{t('gofumpt 严格代码风格')}</strong><span>{t('在 gofmt 基础上套用更严格的风格规则（保存格式化时生效）')}</span></div>
                <input type="checkbox" checked={preferences.go.gofumpt} onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, gofumpt: event.target.checked } })} />
              </label>
              <label className="mg-settings-field mg-settings-check-field">
                <div><strong>{t('staticcheck 代码检查')}</strong><span>{t('gopls 的 staticcheck 诊断与快速修复（对应 GoLand 的 inspection）')}</span></div>
                <input type="checkbox" checked={preferences.go.staticcheck} onChange={(event) => onChange({ ...preferences, go: { ...preferences.go, staticcheck: event.target.checked } })} />
              </label>
            </>}
          </>}
          {section === 'project' && <>
            <div className="mg-settings-section-heading"><h3>{t('项目')}</h3><p>{t('项目文件显示')}</p></div>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('显示隐藏文件')}</strong><span>{t('在项目树中显示以点开头的文件（不含 .git 等排除目录）')}</span></div>
              <input type="checkbox" checked={preferences.project.showHiddenFiles} onChange={(event) => updateProject('showHiddenFiles', event.target.checked)} />
            </label>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('自动定位当前文件')}</strong><span>{t('打开或切换文件时在项目树中展开并选中它')}</span></div>
              <input type="checkbox" checked={preferences.project.autoRevealCurrentFile} onChange={(event) => updateProject('autoRevealCurrentFile', event.target.checked)} />
            </label>
          </>}
          {section === 'versionControl' && <>
            <div className="mg-settings-section-heading"><h3>{t('版本控制')}</h3><p>{t('Git 状态刷新')}</p></div>
            <div className="mg-settings-field">
              <div><label htmlFor="mg-setting-git-refresh">{t('自动刷新间隔')}</label><span>{t('定期更新分支和更改列表；关闭时仍可手动刷新')}</span></div>
              <Dropdown ariaLabel={t('自动刷新间隔')} value={String(preferences.versionControl.gitAutoRefreshSeconds)} options={[
                { value: '0', label: t('关闭') }, { value: '5', label: t('每 5 秒') }, { value: '15', label: t('每 15 秒') }, { value: '30', label: t('每 30 秒') },
              ]} onChange={(next) => updateVersionControl('gitAutoRefreshSeconds', Number(next) as GitAutoRefreshSeconds)} />
            </div>
          </>}
          {section === 'terminal' && <>
            <div className="mg-settings-section-heading"><h3>{t('终端')}</h3><p>{t('终端显示')}</p></div>
            <NumberSetting id="mg-setting-terminal-font-size" label={t('终端文字大小')} description={t('新终端会话和现有终端的文字大小')} value={preferences.terminal.fontSize} min={10} max={24} unit="px" onChange={(value) => updateTerminal('fontSize', value)} />
          </>}
          {section === 'language' && locale && onLocaleChange && <>
            <div className="mg-settings-section-heading"><h3>{t('语言')}</h3><p>{t('更改 GoMavo 界面的显示语言')}</p></div>
            <div className="mg-settings-field">
              <label htmlFor="mg-setting-locale">{t('界面语言')}</label>
              <Dropdown ariaLabel={t('界面语言')} value={locale} options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]} onChange={(next) => onLocaleChange(next as Locale)} />
            </div>
          </>}
          {section === 'run' && <>
            <div className="mg-settings-section-heading"><h3>{t('运行')}</h3><p>{t('运行与测试行为，运行配置在顶栏的配置菜单中编辑')}</p></div>
            <label className="mg-settings-field mg-settings-check-field">
              <div><strong>{t('运行前保存所有文件')}</strong><span>{t('启动 go run / go test 前自动保存未保存的修改')}</span></div>
              <input type="checkbox" checked={preferences.run.saveBeforeRun} onChange={(event) => onChange({ ...preferences, run: { ...preferences.run, saveBeforeRun: event.target.checked } })} />
            </label>
            <div className="mg-settings-field">
              <div><strong>{t('已保存的运行配置')}</strong><span>{t('{count} 个配置。通过顶栏运行配置菜单 → 编辑运行配置…管理', { count: preferences.run.runConfigurations.length })}</span></div>
            </div>
          </>}
          {section === 'plugins' && pluginManager && <>
            <div className="mg-settings-section-heading"><h3>{t('插件')}</h3><p>{t('导入、启停或移除 GoMavo JSON 命令扩展')}</p></div>
            <PluginsPane {...pluginManager} embedded locale={locale} onClose={onClose} />
          </>}
          {section === 'shortcuts' && <>
            <div className="mg-settings-section-heading mg-settings-shortcut-heading">
              <div><h3>{t('快捷键')}</h3><p>{t('默认采用 macOS 常用键位。点击键位后按新组合键，按 Delete 清除。')}</p></div>
              <button type="button" className="mg-settings-reset" onClick={() => {
                onChange({ ...preferences, shortcuts: { ...DEFAULT_SHORTCUTS } })
                cancelRecording()
                setConflict(null)
              }}><RotateCcw size={14} />{t('恢复默认')}</button>
            </div>
            {conflict && <div className="mg-settings-conflict" role="alert">
              <span><strong>{shortcutLabel(conflict.shortcut)}</strong> {t('已用于')} {conflict.previous.map((id) => t(SHORTCUT_ACTIONS.find((item) => item.id === id)?.label ?? id)).join(locale === 'en-US' ? ', ' : '、')}{locale === 'en-US' ? '. ' : '。'}{t('是否改绑到')} {t(SHORTCUT_ACTIONS.find((item) => item.id === conflict.action)?.label ?? conflict.action)}{locale === 'en-US' ? '?' : '？'}</span>
              <div><button type="button" onClick={() => setConflict(null)}>{t('取消')}</button><button type="button" className="primary" onClick={acceptConflict}>{t('改绑')}</button></div>
            </div>}
            {GROUPS.map((group) => <section key={group} className="mg-settings-shortcut-group" aria-label={`${t(group)} ${t('快捷键')}`}>
              <h4>{t(group)}</h4>
              {SHORTCUT_ACTIONS.filter((item) => item.group === group).map((item) => <div className="mg-settings-shortcut-row" key={item.id}>
                <div className="mg-settings-action-text"><strong>{t(item.label)}</strong><span>{t(item.description)}</span></div>
                <button
                  type="button"
                  ref={recording === item.id ? recordButtonRef : undefined}
                  data-shortcut-recorder={recording === item.id ? 'true' : undefined}
                  className={`mg-settings-keycap${recording === item.id ? ' recording' : ''}`}
                  aria-label={`${t(item.label)}：${recording === item.id ? t('正在录制快捷键') : preferences.shortcuts[item.id] ? shortcutLabel(preferences.shortcuts[item.id]) : t('未设置')}`}
                  aria-pressed={recording === item.id}
                  onClick={() => {
                    setConflict(null)
                    if (recording === item.id) cancelRecording()
                    else { shiftAtRef.current = -Infinity; setShiftArmed(false); setRecording(item.id) }
                  }}
                  onKeyDown={(event) => recordKey(event, item.id)}
                >{recording === item.id ? shiftArmed ? t('再按一次 ⇧') : t('请按组合键…') : preferences.shortcuts[item.id] ? shortcutLabel(preferences.shortcuts[item.id]) : t('未设置')}</button>
                <button type="button" className="mg-settings-row-reset" title={`${t('恢复')} ${t(item.label)}`} aria-label={`${t('恢复')} ${t(item.label)}`} disabled={preferences.shortcuts[item.id] === DEFAULT_SHORTCUTS[item.id]} onClick={() => assignShortcut(item.id, DEFAULT_SHORTCUTS[item.id])}><RotateCcw size={14} /></button>
              </div>)}
            </section>)}
            <p className="mg-settings-shortcut-hint">{t('双击 Shift 可设为“搜索所有内容”；Esc 取消录制。系统或应用保留的组合键可能无法覆盖。')}</p>
          </>}
        </main>
      </div>
    </div>
  </div>
}
