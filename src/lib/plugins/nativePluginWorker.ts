import type {
  HostToPluginMessage, NativePluginContext, PluginCompletionItem, PluginDisposable,
  PluginDocument, PluginPosition, PluginToHostMessage,
} from './nativePluginProtocol'
import type { NativePluginManifest } from './nativePlugins'

type WorkerScope = {
  onmessage: ((event: MessageEvent<HostToPluginMessage>) => void) | null
  postMessage: (message: PluginToHostMessage) => void
}
type Registration =
  | { kind: 'command'; handler: () => void | Promise<void> }
  | { kind: 'completion'; handler: (document: PluginDocument, position: PluginPosition) => PluginCompletionItem[] | Promise<PluginCompletionItem[]> }
  | { kind: 'hover'; handler: (document: PluginDocument, position: PluginPosition) => string | null | Promise<string | null> }
type RegistrationNotice =
  | { kind: 'command'; command: string }
  | { kind: 'completion'; language: string; triggerCharacters: string[] }
  | { kind: 'hover'; language: string }

const scope = self as unknown as WorkerScope
const registrations = new Map<number, Registration>()
const workspaceListeners = new Set<(rootPath: string | null) => void>()
let nextRegistrationId = 1
let rootPath: string | null = null
let extensionModule: { activate: (context: NativePluginContext) => unknown; deactivate?: () => unknown } | null = null
let context: NativePluginContext | null = null

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500)
}

function register(registration: Registration, message: RegistrationNotice): PluginDisposable {
  if (registrations.size >= 64) throw new Error('每个插件最多注册 64 项能力。')
  const registrationId = nextRegistrationId++
  registrations.set(registrationId, registration)
  scope.postMessage({ type: 'register', registrationId, ...message } as PluginToHostMessage)
  return {
    dispose() {
      if (!registrations.delete(registrationId)) return
      scope.postMessage({ type: 'unregister', registrationId })
    },
  }
}

function makeContext(manifest: NativePluginManifest): NativePluginContext {
  return {
    subscriptions: [],
    workspace: {
      get rootPath() { return rootPath },
      onDidChangeWorkspace(listener) {
        if (typeof listener !== 'function') throw new Error('工作区监听器必须是函数。')
        workspaceListeners.add(listener)
        return { dispose: () => { workspaceListeners.delete(listener) } }
      },
    },
    window: {
      showInformationMessage(message) { scope.postMessage({ type: 'notice', kind: 'success', text: String(message).slice(0, 500) }) },
      showErrorMessage(message) { scope.postMessage({ type: 'notice', kind: 'error', text: String(message).slice(0, 500) }) },
    },
    commands: {
      registerCommand(command, handler) {
        if (!manifest.contributes.commands.some((item) => item.command === command)) {
          throw new Error(`命令 ${command} 未在 manifest.json 的 contributes.commands 中声明。`)
        }
        if (typeof handler !== 'function') throw new Error('命令处理器必须是函数。')
        return register({ kind: 'command', handler }, { kind: 'command', command })
      },
    },
    languages: {
      registerCompletionItemProvider(language, provider) {
        if (!/^[a-z][a-z0-9+.#-]{0,39}$/i.test(language) || typeof provider?.provideCompletionItems !== 'function') {
          throw new Error('补全提供器需要有效的语言 ID 和处理函数。')
        }
        const triggerCharacters = (provider.triggerCharacters ?? []).filter((item) => typeof item === 'string' && item.length === 1).slice(0, 16)
        return register({ kind: 'completion', handler: provider.provideCompletionItems }, { kind: 'completion', language, triggerCharacters })
      },
      registerHoverProvider(language, provider) {
        if (!/^[a-z][a-z0-9+.#-]{0,39}$/i.test(language) || typeof provider?.provideHover !== 'function') {
          throw new Error('悬停提供器需要有效的语言 ID 和处理函数。')
        }
        return register({ kind: 'hover', handler: provider.provideHover }, { kind: 'hover', language })
      },
    },
  }
}

async function activate(message: Extract<HostToPluginMessage, { type: 'activate' }>): Promise<void> {
  if (extensionModule) throw new Error('插件已激活。')
  rootPath = message.rootPath
  context = makeContext(message.manifest)
  const blobUrl = URL.createObjectURL(new Blob([message.code], { type: 'text/javascript' }))
  try {
    const loaded: unknown = await import(/* @vite-ignore */ blobUrl)
    if (!loaded || typeof loaded !== 'object' || !('activate' in loaded) || typeof loaded.activate !== 'function') {
      throw new Error('main.js 必须导出 activate(context) 函数。')
    }
    const module = loaded as unknown as { activate: (context: NativePluginContext) => unknown; deactivate?: () => unknown }
    extensionModule = module
    await module.activate(context)
    scope.postMessage({ type: 'activated' })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function invoke(message: Extract<HostToPluginMessage, { type: 'invoke' }>): Promise<void> {
  const registration = registrations.get(message.registrationId)
  if (!registration) {
    scope.postMessage({ type: 'response', requestId: message.requestId, error: '插件能力已取消注册。' })
    return
  }
  try {
    let value: unknown
    if (registration.kind === 'command') value = await registration.handler()
    else {
      if (!message.document || !message.position) throw new Error('缺少编辑器文档或光标位置。')
      value = await registration.handler(message.document, message.position)
    }
    scope.postMessage({ type: 'response', requestId: message.requestId, value })
  } catch (cause) {
    scope.postMessage({ type: 'response', requestId: message.requestId, error: errorText(cause) })
  }
}

async function deactivate(): Promise<void> {
  try { await extensionModule?.deactivate?.() } catch { /* shutdown still disposes registrations */ }
  for (const item of context?.subscriptions ?? []) {
    try { item.dispose() } catch { /* continue cleanup */ }
  }
  for (const registrationId of registrations.keys()) scope.postMessage({ type: 'unregister', registrationId })
  registrations.clear()
  workspaceListeners.clear()
  extensionModule = null
  context = null
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'activate') {
    void activate(message).catch((cause) => scope.postMessage({ type: 'activationError', error: errorText(cause) }))
  } else if (message.type === 'invoke') {
    void invoke(message)
  } else if (message.type === 'workspaceChanged') {
    rootPath = message.rootPath
    for (const listener of workspaceListeners) {
      try { listener(rootPath) } catch { /* keep other listeners running */ }
    }
  } else if (message.type === 'deactivate') {
    void deactivate()
  }
}
