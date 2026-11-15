/**
 * MGLand's deliberately small local command extension format.
 *
 * A manifest is data, never executable JavaScript or a shell command. The only
 * effects available to it are the host's existing Go tasks and opening a file
 * beneath the current project root. JetBrains JVM ZIP/JAR plugins are unrelated.
 */

export const PLUGINS_STORAGE_KEY = 'mgland.plugins.v1'

export const GO_TASKS = [
  'run', 'test', 'build', 'fmt', 'vet', 'mod_tidy', 'mod_download',
] as const

export type GoTask = typeof GO_TASKS[number]

export type PluginAction =
  | { id: string; name: string; type: 'goTask'; task: GoTask }
  | { id: string; name: string; type: 'openFile'; path: string }

export interface PluginManifest {
  id: string
  name: string
  description: string
  actions: PluginAction[]
}

export interface InstalledPlugin {
  manifest: PluginManifest
  enabled: boolean
  installedAt: string
}

export interface PluginCommand {
  /** Stable and unique across plugins; useful as a React key or palette ID. */
  key: string
  pluginId: string
  pluginName: string
  action: PluginAction
}

export interface PluginActionHost {
  projectRoot: string | null
  runGoTask: (task: GoTask) => void | Promise<unknown>
  /** Receives an absolute path resolved beneath projectRoot. */
  openFile: (absolutePath: string) => boolean | void | Promise<boolean | void>
}

export type PluginErrorCode =
  | 'INVALID_JSON' | 'INVALID_MANIFEST' | 'CONFLICT' | 'NOT_FOUND'
  | 'DISABLED' | 'NO_WORKSPACE' | 'STORAGE'

export class PluginError extends Error {
  constructor(readonly code: PluginErrorCode, message: string) {
    super(message)
    this.name = 'PluginError'
  }
}

type PluginStore = { version: 1; plugins: InstalledPlugin[] }
type RecordValue = Record<string, unknown>

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_PLUGINS = 100
const MAX_ACTIONS = 32
const ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const BAD_TEXT_RE = /[\u0000-\u001f\u007f]/
const listeners = new Set<() => void>()
let store: PluginStore | null = null
let loadWarning: string | null = null
let storageListening = false

function invalid(message: string): never {
  throw new PluginError('INVALID_MANIFEST', message)
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: RecordValue, allowed: readonly string[], location: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) invalid(`${location} 不支持字段“${extra}”。插件不能声明脚本或 Shell 命令。`)
}

function boundedText(value: unknown, location: string, max: number): string {
  if (typeof value !== 'string') invalid(`${location} 必须是文本。`)
  const text = value.trim()
  if (!text || text.length > max || BAD_TEXT_RE.test(text)) invalid(`${location} 应为 1–${max} 个可见字符。`)
  return text
}

function identifier(value: unknown, location: string): string {
  const id = boundedText(value, location, 80)
  if (!ID_RE.test(id)) invalid(`${location} 只能由小写英文字母、数字、点或连字符组成，并须以字母开头。`)
  return id
}

/** No absolute paths, parent traversal, alternate separators, URLs, or Windows devices. */
export function normalizePluginFilePath(value: unknown): string {
  const path = boundedText(value, '文件路径', 240)
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\') || path.includes(':')) {
    invalid('打开文件动作只能使用项目内的相对路径。')
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[<>"|?*]/.test(segment))) {
    invalid('文件路径不能包含空目录、.、.. 或特殊设备字符。')
  }
  return segments.join('/')
}

/** Strict runtime validation at both import and storage restoration. */
export function validatePluginManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) invalid('插件清单必须是 JSON 对象。')
  onlyKeys(input, ['id', 'name', 'description', 'actions'], '插件清单')
  const id = identifier(input.id, '插件 ID')
  const name = boundedText(input.name, '插件名称', 80)
  const description = boundedText(input.description, '插件说明', 500)
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > MAX_ACTIONS) {
    invalid(`actions 必须包含 1–${MAX_ACTIONS} 个动作。`)
  }
  const seen = new Set<string>()
  const actions = input.actions.map((raw, index): PluginAction => {
    if (!isRecord(raw)) invalid(`动作 ${index + 1} 必须是 JSON 对象。`)
    const location = `动作 ${index + 1}`
    const actionId = identifier(raw.id, `${location} ID`)
    if (seen.has(actionId)) invalid(`动作 ID“${actionId}”重复。`)
    seen.add(actionId)
    const actionName = boundedText(raw.name, `${location} 名称`, 80)
    if (raw.type === 'goTask') {
      onlyKeys(raw, ['id', 'name', 'type', 'task'], location)
      if (typeof raw.task !== 'string' || !(GO_TASKS as readonly string[]).includes(raw.task)) {
        invalid(`${location} 的 Go 任务无效。只允许 ${GO_TASKS.join('、')}。`)
      }
      return { id: actionId, name: actionName, type: 'goTask', task: raw.task as GoTask }
    }
    if (raw.type === 'openFile') {
      onlyKeys(raw, ['id', 'name', 'type', 'path'], location)
      return { id: actionId, name: actionName, type: 'openFile', path: normalizePluginFilePath(raw.path) }
    }
    invalid(`${location} 的 type 无效。只允许 goTask 或 openFile。`)
  })
  return { id, name, description, actions }
}

export function parsePluginJson(text: string): PluginManifest {
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) {
    invalid('JSON 清单超过 64 KB。')
  }
  let value: unknown
  try { value = JSON.parse(text) as unknown }
  catch { throw new PluginError('INVALID_JSON', 'JSON 格式错误。请选择 MGLand 命令清单；JetBrains ZIP/JAR 插件不兼容。') }
  return validatePluginManifest(value)
}

function decodeStored(raw: string): PluginStore {
  const value = JSON.parse(raw) as unknown
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.plugins)) throw new Error('存储格式不正确')
  const plugins: InstalledPlugin[] = []
  const seen = new Set<string>()
  let rejected = 0
  for (const item of value.plugins.slice(0, MAX_PLUGINS)) {
    try {
      if (!isRecord(item) || typeof item.enabled !== 'boolean' || typeof item.installedAt !== 'string') throw new Error('记录不完整')
      const manifest = validatePluginManifest(item.manifest)
      if (seen.has(manifest.id)) throw new Error('插件 ID 重复')
      seen.add(manifest.id)
      plugins.push({ manifest, enabled: item.enabled, installedAt: item.installedAt })
    } catch { rejected += 1 }
  }
  rejected += Math.max(0, value.plugins.length - MAX_PLUGINS)
  if (rejected) loadWarning = `${rejected} 个已保存的插件记录无效，已跳过。请重新导入。`
  return { version: 1, plugins }
}

function initialize(): PluginStore {
  if (store) return store
  loadWarning = null
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PLUGINS_STORAGE_KEY)
    store = raw ? decodeStored(raw) : { version: 1, plugins: [] }
  } catch {
    loadWarning = '无法读取已保存的插件。请检查本地存储，然后重新导入 JSON 清单。'
    store = { version: 1, plugins: [] }
  }
  return store
}

function notify(): void {
  for (const listener of listeners) listener()
}

function persist(next: PluginStore): void {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage 不可用')
    localStorage.setItem(PLUGINS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    throw new PluginError('STORAGE', '无法保存插件设置。请检查本地存储空间或应用权限。')
  }
  store = next
  loadWarning = null
  notify()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== PLUGINS_STORAGE_KEY && event.key !== null) return
  store = null
  initialize()
  notify()
}

/** Stable snapshot for useSyncExternalStore. */
export function getPlugins(): readonly InstalledPlugin[] {
  return initialize().plugins
}

export function getPluginLoadWarning(): string | null {
  initialize()
  return loadWarning
}

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener)
  if (!storageListening && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    storageListening = true
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && storageListening && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
      storageListening = false
    }
  }
}

/** Same-ID imports fail unless the caller explicitly chooses replacement. */
export function installPlugin(input: unknown, options?: { replace?: boolean }): InstalledPlugin {
  const manifest = validatePluginManifest(input)
  const current = initialize().plugins
  const previous = current.find((plugin) => plugin.manifest.id === manifest.id)
  if (previous && !options?.replace) {
    throw new PluginError('CONFLICT', `插件 ID“${manifest.id}”已安装。请选择替换或取消导入。`)
  }
  if (!previous && current.length >= MAX_PLUGINS) invalid(`最多只能安装 ${MAX_PLUGINS} 个本地插件。`)
  const installed: InstalledPlugin = {
    manifest,
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
  }
  const plugins = previous
    ? current.map((plugin) => plugin.manifest.id === manifest.id ? installed : plugin)
    : [...current, installed]
  persist({ version: 1, plugins })
  return installed
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const current = initialize().plugins
  if (!current.some((plugin) => plugin.manifest.id === id)) throw new PluginError('NOT_FOUND', `未找到插件“${id}”。`)
  persist({
    version: 1,
    plugins: current.map((plugin) => plugin.manifest.id === id ? { ...plugin, enabled } : plugin),
  })
}

export function removePlugin(id: string): void {
  const current = initialize().plugins
  if (!current.some((plugin) => plugin.manifest.id === id)) throw new PluginError('NOT_FOUND', `未找到插件“${id}”。`)
  persist({ version: 1, plugins: current.filter((plugin) => plugin.manifest.id !== id) })
}

export function getEnabledPluginActions(): PluginCommand[] {
  return getPlugins().flatMap((plugin) => plugin.enabled
    ? plugin.manifest.actions.map((action) => ({
      key: `${plugin.manifest.id}:${action.id}`,
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
      action,
    }))
    : [])
}

export function resolvePluginFile(projectRoot: string, relativePath: string): string {
  const root = projectRoot.trim().replace(/[\\/]+$/, '')
  if (!root) throw new PluginError('NO_WORKSPACE', '请先打开 Go 项目。')
  return `${root}/${normalizePluginFilePath(relativePath)}`
}

/** Rechecks enablement and the whitelist at invocation time. */
export async function executePluginAction(pluginId: string, actionId: string, host: PluginActionHost): Promise<void> {
  const installed = getPlugins().find((plugin) => plugin.manifest.id === pluginId)
  if (!installed) throw new PluginError('NOT_FOUND', `未找到插件“${pluginId}”。`)
  if (!installed.enabled) throw new PluginError('DISABLED', `插件“${installed.manifest.name}”已停用。`)
  const manifest = validatePluginManifest(installed.manifest)
  const action = manifest.actions.find((item) => item.id === actionId)
  if (!action) throw new PluginError('NOT_FOUND', `未找到插件动作“${actionId}”。`)
  if (!host.projectRoot) throw new PluginError('NO_WORKSPACE', '请先打开 Go 项目。')
  if (action.type === 'goTask') await host.runGoTask(action.task)
  else if (await host.openFile(resolvePluginFile(host.projectRoot, action.path)) === false) {
    throw new PluginError('NOT_FOUND', `无法打开文件“${action.path}”。`)
  }
}
