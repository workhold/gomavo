import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  AlertTriangle, Check, ChevronRight, Code2, FileCode2, FolderOpen,
  Package, Play, Puzzle, Search, Trash2, Upload, X,
} from 'lucide-react'
import {
  executePluginAction, getEnabledPluginActions, getPluginLoadWarning, getPlugins,
  installPlugin, parsePluginJson, removePlugin, setPluginEnabled, subscribePlugins,
  type GoTask, type PluginAction, type PluginManifest,
} from '../lib/plugins/plugins'
import {
  installNativePlugin, removeNativePlugin, setNativePluginEnabled,
  type InstalledNativePlugin,
} from '../lib/plugins/nativePlugins'
import type { Locale } from '../lib/i18n'
import './PluginsPane.css'

export interface PluginsPaneProps {
  projectRoot: string | null
  busy?: boolean
  nativePlugins: readonly InstalledNativePlugin[]
  onNativePluginsChanged: () => Promise<void>
  onRunGoTask: (task: GoTask) => void | Promise<unknown>
  /** The existing host file opener; receives a project-rooted absolute path. */
  onOpenFile: (absolutePath: string) => boolean | void | Promise<boolean | void>
  /** Render the manager inside Settings instead of opening its own modal. */
  embedded?: boolean
  locale?: Locale
  onClose?: () => void
}

type Notice = { kind: 'error' | 'success'; text: string }

const EXAMPLE = `{
  "id": "local.go-workflow",
  "name": "Go Workflow",
  "description": "常用 Go 项目操作",
  "actions": [
    { "id": "test-all", "name": "运行全部测试", "type": "goTask", "task": "test" },
    { "id": "open-mod", "name": "打开 go.mod", "type": "openFile", "path": "go.mod" }
  ]
}`

const ENGLISH: Record<string, string> = {
  '插件': 'Plugins', '管理原生插件与本地命令': 'Manage installed plugins and local commands',
  '关闭插件设置': 'Close plugin settings', '插件类型': 'Plugin types',
  '原生插件': 'Native plugins', 'JSON 命令': 'JSON commands',
  '处理中…': 'Working…', '从磁盘安装': 'Install from Disk', '导入 JSON': 'Import JSON',
  '选择插件 JSON 清单': 'Select a plugin JSON manifest',
  '取消': 'Cancel', '替换': 'Replace', '关闭提示': 'Dismiss notice',
  '已安装原生插件': 'Installed native plugins', '搜索原生插件': 'Search native plugins',
  '停用': 'Disable', '启用': 'Enable', '没有匹配的插件。': 'No matching plugins.',
  '尚未安装原生插件。': 'No native plugins installed.', '此插件未提供说明。': 'This plugin has no description.',
  '移除': 'Remove', '确认移除': 'Confirm removal', '原生插件命令': 'Native plugin commands',
  '命令': 'Commands', '未声明命令。': 'No commands declared.',
  '激活事件': 'Activation events', '未声明激活事件。': 'No activation events declared.',
  '安装原生插件': 'Install native plugin',
  '选择本地 .gomavo-plugin 安装包。插件 JavaScript 将在 Worker 中运行。': 'Choose a local .gomavo-plugin package. Plugin JavaScript runs in a Worker.',
  '已安装插件': 'Installed plugins', '搜索已安装插件': 'Search installed plugins',
  '搜索 JSON 命令插件': 'Search JSON command plugins', '本地命令': 'Local commands',
  '尚未安装命令插件。': 'No command plugins installed.', '插件命令': 'Plugin commands',
  '运行': 'Run', '打开 Go 项目后即可运行插件命令。': 'Open a Go project to run plugin commands.',
  '导入本地命令插件': 'Import local command plugin',
  '从 JSON 清单添加自己的 Go 工作流命令。': 'Add your own Go workflow commands from a JSON manifest.',
  '原生插件 JavaScript 在 Worker 中运行；支持 .gomavo-plugin 和旧版 .mgland-plugin 安装包，不兼容 VSIX 或 GoLand 插件。': 'Native plugin JavaScript runs in a Worker. .gomavo-plugin and older .mgland-plugin packages are supported; VSIX and GoLand plugins are incompatible.',
  'JSON 命令插件仅使用 GoMavo 清单，不运行脚本。': 'JSON command plugins use GoMavo manifests and do not run scripts.',
  '清单示例': 'Manifest example',
  '导入 GoMavo 插件': 'Install GoMavo plugin', 'GoMavo 插件': 'GoMavo plugin',
  '请选择 .gomavo-plugin 或旧版 .mgland-plugin 安装包。': 'Choose a .gomavo-plugin or older .mgland-plugin package.',
  '原生插件已启用。': 'Native plugin enabled.', '原生插件已停用。': 'Native plugin disabled.',
  '原生插件已移除。': 'Native plugin removed.',
  '请选择 GoMavo 的 .json 命令清单。JetBrains ZIP/JAR 插件不兼容。': 'Choose a GoMavo .json command manifest. JetBrains ZIP/JAR plugins are incompatible.',
  'JSON 清单不能超过 64 KB。': 'JSON manifests must be 64 KB or smaller.',
  '插件已启用。': 'Plugin enabled.', '插件已停用，命令已从搜索中移除。': 'Plugin disabled; its commands were removed from search.',
  '插件已移除。可以随时重新导入 JSON 清单。': 'Plugin removed. You can import its JSON manifest again.',
  '该插件已停用或动作已移除。': 'This plugin is disabled or its action was removed.',
}

const EXAMPLE_EN = EXAMPLE
  .replace('常用 Go 项目操作', 'Common Go project tasks')
  .replace('运行全部测试', 'Run all tests')
  .replace('打开 go.mod', 'Open go.mod')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actionDescription(action: PluginAction): string {
  if (action.type === 'openFile') return action.path
  const tasks: Record<GoTask, string> = {
    run: 'go run .', test: 'go test ./...', build: 'go build ./...',
    fmt: 'go fmt ./...', vet: 'go vet ./...',
    mod_tidy: 'go mod tidy', mod_download: 'go mod download',
  }
  return tasks[action.task]
}

export function PluginsPane({ projectRoot, busy = false, nativePlugins, onNativePluginsChanged, onRunGoTask, onOpenFile, embedded = false, locale, onClose }: PluginsPaneProps) {
  const t = (value: string) => locale === 'en-US' ? ENGLISH[value] ?? value : value
  const [activeTab, setActiveTab] = useState<'native' | 'json'>('native')
  const plugins = useSyncExternalStore(subscribePlugins, getPlugins, getPlugins)
  const [selectedId, setSelectedId] = useState<string | null>(() => getPlugins()[0]?.manifest.id ?? null)
  const [nativeSelectedId, setNativeSelectedId] = useState<string | null>(nativePlugins[0]?.manifest.id ?? null)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(() => {
    const warning = getPluginLoadWarning()
    return warning ? { kind: 'error', text: warning } : null
  })
  const [pendingReplace, setPendingReplace] = useState<PluginManifest | null>(null)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [nativePendingRemove, setNativePendingRemove] = useState<string | null>(null)
  const [nativeBusy, setNativeBusy] = useState(false)
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const nativeTabRef = useRef<HTMLButtonElement | null>(null)
  const jsonTabRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => { if (!embedded) closeButtonRef.current?.focus() }, [embedded])
  useEffect(() => {
    if (selectedId && plugins.some((plugin) => plugin.manifest.id === selectedId)) return
    setSelectedId(plugins[0]?.manifest.id ?? null)
  }, [plugins, selectedId])
  useEffect(() => {
    if (nativeSelectedId && nativePlugins.some((plugin) => plugin.manifest.id === nativeSelectedId)) return
    setNativeSelectedId(nativePlugins[0]?.manifest.id ?? null)
  }, [nativePlugins, nativeSelectedId])

  const selected = plugins.find((plugin) => plugin.manifest.id === selectedId) ?? null
  const filtered = plugins.filter((plugin) => {
    const needle = query.trim().toLowerCase()
    return !needle || [plugin.manifest.id, plugin.manifest.name, plugin.manifest.description]
      .some((value) => value.toLowerCase().includes(needle))
  })
  const nativeSelected = nativePlugins.find((plugin) => plugin.manifest.id === nativeSelectedId) ?? null
  const nativeFiltered = nativePlugins.filter((plugin) => {
    const needle = query.trim().toLowerCase()
    return !needle || [plugin.manifest.id, plugin.manifest.name, plugin.manifest.description ?? '']
      .some((value) => value.toLowerCase().includes(needle))
  })

  const changeTab = (tab: 'native' | 'json') => {
    setActiveTab(tab)
    setQuery('')
    setNotice(null)
    setPendingReplace(null)
    setPendingRemove(null)
    setNativePendingRemove(null)
  }

  const importNative = async () => {
    if (nativeBusy) return
    setNotice(null)
    setNativeBusy(true)
    try {
      const picked = await open({
        title: t('导入 GoMavo 插件'),
        multiple: false,
        filters: [{ name: t('GoMavo 插件'), extensions: ['gomavo-plugin', 'mgland-plugin'] }],
      })
      if (!picked) return
      if (Array.isArray(picked) || !/\.(?:gomavo|mgland)-plugin$/i.test(picked)) {
        throw new Error(t('请选择 .gomavo-plugin 或旧版 .mgland-plugin 安装包。'))
      }
      const installed = await installNativePlugin(picked, true)
      await onNativePluginsChanged()
      setNativeSelectedId(installed.manifest.id)
      setNotice({ kind: 'success', text: locale === 'en-US'
        ? `Installed “${installed.manifest.name}” v${installed.manifest.version}. Updates with the same ID retain the previous enabled state.`
        : `已安装“${installed.manifest.name}” v${installed.manifest.version}。同 ID 更新会保留原有启停状态。` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setNativeBusy(false)
    }
  }

  const toggleNativeEnabled = async (id: string, enabled: boolean) => {
    if (nativeBusy) return
    setNativeBusy(true)
    setNotice(null)
    try {
      await setNativePluginEnabled(id, enabled)
      await onNativePluginsChanged()
      setNotice({ kind: 'success', text: t(enabled ? '原生插件已启用。' : '原生插件已停用。') })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setNativeBusy(false)
    }
  }

  const confirmNativeRemove = async (id: string) => {
    if (nativeBusy) return
    setNativeBusy(true)
    setNotice(null)
    try {
      await removeNativePlugin(id)
      await onNativePluginsChanged()
      setNativePendingRemove(null)
      setNotice({ kind: 'success', text: t('原生插件已移除。') })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setNativeBusy(false)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setNotice(null)
    setPendingReplace(null)
    if (!file.name.toLowerCase().endsWith('.json')) {
      setNotice({ kind: 'error', text: t('请选择 GoMavo 的 .json 命令清单。JetBrains ZIP/JAR 插件不兼容。') })
      return
    }
    if (file.size > 64 * 1024) {
      setNotice({ kind: 'error', text: t('JSON 清单不能超过 64 KB。') })
      return
    }
    try {
      const manifest = parsePluginJson(await file.text())
      if (plugins.some((plugin) => plugin.manifest.id === manifest.id)) {
        setPendingReplace(manifest)
        return
      }
      installPlugin(manifest)
      setSelectedId(manifest.id)
      setNotice({ kind: 'success', text: locale === 'en-US' ? `Imported “${manifest.name}”; its commands are now available.` : `已导入“${manifest.name}”，其命令现已可用。` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  const replacePlugin = () => {
    if (!pendingReplace) return
    try {
      installPlugin(pendingReplace, { replace: true })
      setSelectedId(pendingReplace.id)
      setNotice({ kind: 'success', text: locale === 'en-US' ? `Replaced “${pendingReplace.name}”. The previous enabled state was retained.` : `已替换“${pendingReplace.name}”。原有启停状态已保留。` })
      setPendingReplace(null)
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  const toggleEnabled = (id: string, enabled: boolean) => {
    try {
      setPluginEnabled(id, enabled)
      setNotice({ kind: 'success', text: t(enabled ? '插件已启用。' : '插件已停用，命令已从搜索中移除。') })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  const confirmRemove = (id: string) => {
    try {
      removePlugin(id)
      setPendingRemove(null)
      setNotice({ kind: 'success', text: t('插件已移除。可以随时重新导入 JSON 清单。') })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  const runAction = async (pluginId: string, action: PluginAction) => {
    const key = `${pluginId}:${action.id}`
    if (!getEnabledPluginActions().some((command) => command.key === key)) {
      setNotice({ kind: 'error', text: t('该插件已停用或动作已移除。') })
      return
    }
    setRunningAction(key)
    setNotice(null)
    try {
      await executePluginAction(pluginId, action.id, {
        projectRoot,
        runGoTask: onRunGoTask,
        openFile: onOpenFile,
      })
      setNotice({ kind: 'success', text: locale === 'en-US' ? `Ran “${action.name}”.` : `已执行“${action.name}”。` })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setRunningAction(null)
    }
  }

  const content = <div className={`mg-plugins-dialog${embedded ? ' mg-plugins-embedded' : ''}`}
      role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true}
      aria-label={embedded ? t('插件') : undefined} aria-labelledby={embedded ? undefined : 'mg-plugins-title'}
      data-plugins-pane="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (pendingReplace) { setPendingReplace(null); event.stopPropagation(); return }
          if (pendingRemove) { setPendingRemove(null); event.stopPropagation(); return }
          if (nativePendingRemove) { setNativePendingRemove(null); event.stopPropagation(); return }
          if (!embedded) onClose?.()
        }
        if (!embedded && event.key === 'Tab') {
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([type="file"]), summary')).filter((element) => element.getClientRects().length > 0)
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
        if (!embedded) event.stopPropagation()
      }}>
      {!embedded && <header className="mg-plugins-header">
        <div><h2 id="mg-plugins-title">{t('插件')}</h2><p>{t('管理原生插件与本地命令')}</p></div>
        <button ref={closeButtonRef} type="button" className="mg-plugins-icon-button" aria-label={t('关闭插件设置')} onClick={() => onClose?.()}><X size={18} /></button>
      </header>}
      <div className="mg-plugins-toolbar">
        <div className="mg-plugins-tabs" role="tablist" aria-label={t('插件类型')}>
          <button ref={nativeTabRef} type="button" role="tab" id="mg-native-tab" aria-controls="mg-native-panel" aria-selected={activeTab === 'native'} tabIndex={activeTab === 'native' ? 0 : -1} className={`mg-plugins-tab${activeTab === 'native' ? ' active' : ''}`} onClick={() => changeTab('native')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); changeTab('json'); jsonTabRef.current?.focus() } }}>{t('原生插件')} <small>{nativePlugins.length}</small></button>
          <button ref={jsonTabRef} type="button" role="tab" id="mg-json-tab" aria-controls="mg-json-panel" aria-selected={activeTab === 'json'} tabIndex={activeTab === 'json' ? 0 : -1} className={`mg-plugins-tab${activeTab === 'json' ? ' active' : ''}`} onClick={() => changeTab('json')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); changeTab('native'); nativeTabRef.current?.focus() } }}>{t('JSON 命令')} <small>{plugins.length}</small></button>
        </div>
        <div className="mg-plugins-toolbar-spacer" />
        {activeTab === 'native'
          ? <button type="button" className="mg-plugins-import" disabled={nativeBusy} onClick={() => void importNative()}><Upload size={15} />{t(nativeBusy ? '处理中…' : '从磁盘安装')}</button>
          : <><input ref={fileInputRef} type="file" accept=".json,application/json" onChange={(event) => void importFile(event)} className="mg-plugins-file-input" tabIndex={-1} aria-label={t('选择插件 JSON 清单')} />
            <button type="button" className="mg-plugins-import" onClick={() => fileInputRef.current?.click()}><Upload size={15} />{t('导入 JSON')}</button></>}
      </div>
      {activeTab === 'json' && pendingReplace && <div className="mg-plugins-conflict" role="alert">
        <AlertTriangle size={17} />
        <span>{locale === 'en-US' ? `ID “${pendingReplace.id}” is already installed. Replacing it uses the new manifest and keeps its enabled state.` : `ID“${pendingReplace.id}”已安装。替换后将使用新清单，原有启停状态会保留。`}</span>
        <button type="button" onClick={() => setPendingReplace(null)}>{t('取消')}</button>
        <button type="button" className="primary" onClick={replacePlugin}>{t('替换')}</button>
      </div>}
      {notice && <div className={`mg-plugins-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{notice.text}</span><button type="button" aria-label={t('关闭提示')} onClick={() => setNotice(null)}><X size={14} /></button></div>}
      <div className="mg-plugins-body" role="tabpanel" id="mg-native-panel" aria-labelledby="mg-native-tab" hidden={activeTab !== 'native'}>
        <aside className="mg-plugins-list" aria-label={t('已安装原生插件')}>
          <label className="mg-plugins-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索原生插件')} aria-label={t('搜索原生插件')} /></label>
          <div className="mg-plugins-list-label">{t('原生插件')} <span>{nativePlugins.length}</span></div>
          <div className="mg-plugins-list-scroll">
            {nativeFiltered.length ? nativeFiltered.map((plugin) => <div className={`mg-plugins-list-row${nativeSelectedId === plugin.manifest.id ? ' active' : ''}`} key={plugin.manifest.id}>
              <button type="button" className="mg-plugins-list-select" aria-current={nativeSelectedId === plugin.manifest.id ? 'true' : undefined} onClick={() => { setNativeSelectedId(plugin.manifest.id); setNativePendingRemove(null) }}>
                <span className="mg-plugins-list-icon"><Puzzle size={17} /></span>
                <span className="mg-plugins-list-text"><strong>{plugin.manifest.name}</strong><small>v{plugin.manifest.version} · {plugin.manifest.description || plugin.manifest.id}</small></span>
              </button>
              <button type="button" className="mg-plugins-switch" role="switch" aria-label={`${t(plugin.enabled ? '停用' : '启用')} ${plugin.manifest.name}`} aria-checked={plugin.enabled} disabled={nativeBusy} onClick={() => void toggleNativeEnabled(plugin.manifest.id, !plugin.enabled)}><span /></button>
            </div>) : <div className="mg-plugins-list-empty">{t(nativePlugins.length ? '没有匹配的插件。' : '尚未安装原生插件。')}</div>}
          </div>
        </aside>
        <div className="mg-plugins-detail">
          {nativeSelected ? <>
            <div className="mg-plugins-detail-header"><div className="mg-plugins-detail-icon"><Puzzle size={25} /></div><div><h3>{nativeSelected.manifest.name}</h3><small>{nativeSelected.manifest.id}</small></div><span className="mg-plugins-version">v{nativeSelected.manifest.version}</span></div>
            <p className="mg-plugins-description">{nativeSelected.manifest.description || t('此插件未提供说明。')}</p>
            <div className="mg-plugins-detail-actions">
              <button type="button" disabled={nativeBusy} onClick={() => void toggleNativeEnabled(nativeSelected.manifest.id, !nativeSelected.enabled)}>{t(nativeSelected.enabled ? '停用' : '启用')}</button>
              <button type="button" className="danger" disabled={nativeBusy} onClick={() => setNativePendingRemove(nativeSelected.manifest.id)}><Trash2 size={14} />{t('移除')}</button>
            </div>
            {nativePendingRemove === nativeSelected.manifest.id && <div className="mg-plugins-remove-confirm" role="alert"><span>{locale === 'en-US' ? `Remove “${nativeSelected.manifest.name}” and its commands?` : `移除“${nativeSelected.manifest.name}”及其命令？`}</span><button type="button" disabled={nativeBusy} onClick={() => setNativePendingRemove(null)}>{t('取消')}</button><button type="button" className="danger" disabled={nativeBusy} onClick={() => void confirmNativeRemove(nativeSelected.manifest.id)}>{t('确认移除')}</button></div>}
            <section className="mg-plugins-actions-section" aria-label={t('原生插件命令')}><h4>{t('命令')} <span>{nativeSelected.manifest.contributes.commands.length}</span></h4>
              {nativeSelected.manifest.contributes.commands.length ? nativeSelected.manifest.contributes.commands.map((command) => <div className="mg-plugins-action-row" key={command.command}>
                <span className="mg-plugins-action-icon"><Code2 size={16} /></span>
                <div><strong>{command.title}</strong><small>{command.command}</small></div>
              </div>) : <p className="mg-plugins-section-empty">{t('未声明命令。')}</p>}
            </section>
            <section className="mg-plugins-events-section" aria-label={t('激活事件')}><h4>{t('激活事件')} <span>{nativeSelected.manifest.activationEvents.length}</span></h4>
              {nativeSelected.manifest.activationEvents.length
                ? <div className="mg-plugins-events">{nativeSelected.manifest.activationEvents.map((event) => <code key={event}>{event}</code>)}</div>
                : <p className="mg-plugins-section-empty">{t('未声明激活事件。')}</p>}
            </section>
          </> : <div className="mg-plugins-empty-detail"><Puzzle size={31} /><h3>{t('安装原生插件')}</h3><p>{t('选择本地 .gomavo-plugin 安装包。插件 JavaScript 将在 Worker 中运行。')}</p><button type="button" disabled={nativeBusy} onClick={() => void importNative()}><Upload size={15} />{t('从磁盘安装')}</button></div>}
        </div>
      </div>
      <div className="mg-plugins-body" role="tabpanel" id="mg-json-panel" aria-labelledby="mg-json-tab" hidden={activeTab !== 'json'}>
        <aside className="mg-plugins-list" aria-label={t('已安装插件')}>
          <label className="mg-plugins-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索已安装插件')} aria-label={t('搜索 JSON 命令插件')} /></label>
          <div className="mg-plugins-list-label">{t('本地命令')} <span>{plugins.length}</span></div>
          <div className="mg-plugins-list-scroll">
            {filtered.length ? filtered.map((plugin) => <div className={`mg-plugins-list-row${selectedId === plugin.manifest.id ? ' active' : ''}`} key={plugin.manifest.id}>
              <button type="button" className="mg-plugins-list-select" aria-current={selectedId === plugin.manifest.id ? 'true' : undefined} onClick={() => { setSelectedId(plugin.manifest.id); setPendingRemove(null) }}>
                <span className="mg-plugins-list-icon"><Package size={17} /></span>
                <span className="mg-plugins-list-text"><strong>{plugin.manifest.name}</strong><small>{plugin.manifest.description}</small></span>
              </button>
              <button type="button" className="mg-plugins-switch" role="switch" aria-label={`${t(plugin.enabled ? '停用' : '启用')} ${plugin.manifest.name}`} aria-checked={plugin.enabled} onClick={() => toggleEnabled(plugin.manifest.id, !plugin.enabled)}><span /></button>
            </div>) : <div className="mg-plugins-list-empty">{t(plugins.length ? '没有匹配的插件。' : '尚未安装命令插件。')}</div>}
          </div>
        </aside>
        <div className="mg-plugins-detail">
          {selected ? <>
            <div className="mg-plugins-detail-header"><div className="mg-plugins-detail-icon"><Package size={25} /></div><div><h3>{selected.manifest.name}</h3><small>{selected.manifest.id}</small></div></div>
            <p className="mg-plugins-description">{selected.manifest.description}</p>
            <div className="mg-plugins-detail-actions">
              <button type="button" onClick={() => toggleEnabled(selected.manifest.id, !selected.enabled)}>{t(selected.enabled ? '停用' : '启用')}</button>
              <button type="button" className="danger" onClick={() => setPendingRemove(selected.manifest.id)}><Trash2 size={14} />{t('移除')}</button>
            </div>
            {pendingRemove === selected.manifest.id && <div className="mg-plugins-remove-confirm" role="alert"><span>{locale === 'en-US' ? `Remove “${selected.manifest.name}” and all its commands?` : `移除“${selected.manifest.name}”及其所有命令？`}</span><button type="button" onClick={() => setPendingRemove(null)}>{t('取消')}</button><button type="button" className="danger" onClick={() => confirmRemove(selected.manifest.id)}>{t('确认移除')}</button></div>}
            <section className="mg-plugins-actions-section" aria-label={t('插件命令')}><h4>{t('命令')} <span>{selected.manifest.actions.length}</span></h4>
              {selected.manifest.actions.map((action) => <div className="mg-plugins-action-row" key={action.id}>
                <span className="mg-plugins-action-icon">{action.type === 'openFile' ? <FileCode2 size={16} /> : <Code2 size={16} />}</span>
                <div><strong>{action.name}</strong><small>{actionDescription(action)}</small></div>
                <button type="button" title={locale === 'en-US' ? `Run ${action.name}` : `执行 ${action.name}`} disabled={!selected.enabled || !projectRoot || (action.type === 'goTask' && busy) || runningAction !== null} onClick={() => void runAction(selected.manifest.id, action)}><Play size={13} />{t('运行')}</button>
              </div>)}
            </section>
            {!projectRoot && <p className="mg-plugins-workspace-hint"><FolderOpen size={14} />{t('打开 Go 项目后即可运行插件命令。')}</p>}
          </> : <div className="mg-plugins-empty-detail"><Package size={31} /><h3>{t('导入本地命令插件')}</h3><p>{t('从 JSON 清单添加自己的 Go 工作流命令。')}</p><button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={15} />{t('导入 JSON')}</button></div>}
        </div>
      </div>
      <footer className="mg-plugins-footer">
        {activeTab === 'native'
          ? <span><ChevronRight size={13} />{t('原生插件 JavaScript 在 Worker 中运行；支持 .gomavo-plugin 和旧版 .mgland-plugin 安装包，不兼容 VSIX 或 GoLand 插件。')}</span>
          : <><span><ChevronRight size={13} />{t('JSON 命令插件仅使用 GoMavo 清单，不运行脚本。')}</span><details><summary>{t('清单示例')}</summary><pre>{locale === 'en-US' ? EXAMPLE_EN : EXAMPLE}</pre></details></>}
      </footer>
    </div>
  return embedded ? content : <div className="mg-plugins-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose?.()
  }}>{content}</div>
}
