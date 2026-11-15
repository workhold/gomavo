import * as monaco from 'monaco-editor/editor/editor.api'
import { readNativePluginCode, type InstalledNativePlugin } from './nativePlugins'
import type {
  HostToPluginMessage, PluginCompletionItem, PluginDocument, PluginPosition,
  PluginToHostMessage,
} from './nativePluginProtocol'

interface HostCallbacks {
  getProjectRoot(): string | null
  notify(text: string, kind: 'success' | 'error'): void
}

type RegisteredCapability =
  | { kind: 'command'; command: string }
  | { kind: 'provider'; disposable: monaco.IDisposable }

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: number
}

interface RuntimeState {
  record: InstalledNativePlugin
  worker: Worker | null
  activation: Promise<void> | null
  resolveActivation: (() => void) | null
  rejectActivation: ((error: Error) => void) | null
  activationTimer: number | null
  registrations: Map<number, RegisteredCapability>
  pending: Map<number, PendingRequest>
  nextRequestId: number
  disposed: boolean
}

const ACTIVATION_TIMEOUT_MS = 10_000
const INVOCATION_TIMEOUT_MS = 10_000
const MAX_DOCUMENT_CHARS = 2_000_000

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function completionKind(kind: PluginCompletionItem['kind']): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'function': return monaco.languages.CompletionItemKind.Function
    case 'method': return monaco.languages.CompletionItemKind.Method
    case 'variable': return monaco.languages.CompletionItemKind.Variable
    case 'keyword': return monaco.languages.CompletionItemKind.Keyword
    case 'snippet': return monaco.languages.CompletionItemKind.Snippet
    default: return monaco.languages.CompletionItemKind.Text
  }
}

function documentFor(model: monaco.editor.ITextModel): PluginDocument | null {
  if (model.getValueLength() > MAX_DOCUMENT_CHARS) return null
  return { uri: model.uri.toString(), languageId: model.getLanguageId(), text: model.getValue() }
}

function positionFor(position: monaco.Position): PluginPosition {
  return { lineNumber: position.lineNumber, column: position.column }
}

/** Runs MGLand-native, single-file browser extensions in individual Web Workers. */
export class NativePluginHost {
  private readonly states = new Map<string, RuntimeState>()
  private disposed = false

  constructor(private readonly callbacks: HostCallbacks) {}

  sync(records: readonly InstalledNativePlugin[]): void {
    if (this.disposed) return
    const enabled = new Map(records.filter((record) => record.enabled).map((record) => [record.manifest.id, record]))
    for (const [id, state] of this.states) {
      const next = enabled.get(id)
      if (next && next.installedAt === state.record.installedAt && next.manifest.version === state.record.manifest.version) continue
      this.stop(state, new Error('插件已停用或更新。'))
      this.states.delete(id)
    }
    for (const [id, record] of enabled) {
      if (this.states.has(id)) continue
      const state: RuntimeState = {
        record, worker: null, activation: null, resolveActivation: null, rejectActivation: null,
        activationTimer: null, registrations: new Map(), pending: new Map(), nextRequestId: 1, disposed: false,
      }
      this.states.set(id, state)
      if (record.manifest.activationEvents.includes('onStartupFinished')) {
        void this.activate(state).catch((cause) => this.report(state, cause))
      }
    }
  }

  workspaceChanged(): void {
    const rootPath = this.callbacks.getProjectRoot()
    for (const state of this.states.values()) {
      state.worker?.postMessage({ type: 'workspaceChanged', rootPath } satisfies HostToPluginMessage)
    }
  }

  activateForLanguage(language: string): void {
    for (const state of this.states.values()) {
      if (state.record.manifest.activationEvents.includes(`onLanguage:${language}`)) {
        void this.activate(state).catch((cause) => this.report(state, cause))
      }
    }
  }

  async executeCommand(pluginId: string, command: string): Promise<void> {
    const state = this.states.get(pluginId)
    if (!state || state.disposed) throw new Error('插件未安装或已停用。')
    if (!state.record.manifest.contributes.commands.some((item) => item.command === command)) {
      throw new Error(`插件未声明命令 ${command}。`)
    }
    await this.activate(state)
    const registration = [...state.registrations.entries()]
      .find(([, capability]) => capability.kind === 'command' && capability.command === command)?.[0]
    if (registration === undefined) throw new Error(`插件未注册命令 ${command}。`)
    await this.invoke(state, registration)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) this.stop(state, new Error('插件宿主已关闭。'))
    this.states.clear()
  }

  private report(state: RuntimeState, cause: unknown): void {
    if (state.disposed && this.states.get(state.record.manifest.id) !== state) return
    this.callbacks.notify(`${state.record.manifest.name}: ${asError(cause).message}`, 'error')
  }

  private activate(state: RuntimeState): Promise<void> {
    if (state.disposed) return Promise.reject(new Error('插件已停用。'))
    if (state.activation) return state.activation
    state.activation = this.loadAndActivate(state)
    return state.activation
  }

  private async loadAndActivate(state: RuntimeState): Promise<void> {
    const code = await readNativePluginCode(state.record.manifest.id)
    if (state.disposed || this.disposed) throw new Error('插件已停用。')
    return new Promise<void>((resolve, reject) => {
      let worker: Worker
      try { worker = new Worker(new URL('./nativePluginWorker.ts', import.meta.url), { type: 'module' }) }
      catch (cause) { reject(asError(cause)); return }
      state.worker = worker
      state.resolveActivation = resolve
      state.rejectActivation = reject
      state.activationTimer = window.setTimeout(() => this.failActivation(state, new Error('插件激活超时。')), ACTIVATION_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<PluginToHostMessage>) => this.onMessage(state, event.data)
      worker.onerror = (event) => this.failActivation(state, new Error(event.message || '插件 Worker 发生错误。'))
      worker.postMessage({ type: 'activate', code, manifest: state.record.manifest, rootPath: this.callbacks.getProjectRoot() } satisfies HostToPluginMessage)
    })
  }

  private failActivation(state: RuntimeState, error: Error): void {
    if (state.disposed) return
    state.rejectActivation?.(error)
    state.rejectActivation = null
    state.resolveActivation = null
    this.stop(state, error)
  }

  private onMessage(state: RuntimeState, message: PluginToHostMessage): void {
    if (state.disposed || this.states.get(state.record.manifest.id) !== state) return
    if (message.type === 'activated') {
      if (state.activationTimer !== null) window.clearTimeout(state.activationTimer)
      state.activationTimer = null
      state.resolveActivation?.()
      state.resolveActivation = null
      state.rejectActivation = null
    } else if (message.type === 'activationError') {
      this.failActivation(state, new Error(message.error))
    } else if (message.type === 'register') {
      this.register(state, message)
    } else if (message.type === 'unregister') {
      this.unregister(state, message.registrationId)
    } else if (message.type === 'response') {
      const pending = state.pending.get(message.requestId)
      if (!pending) return
      state.pending.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.value)
    } else if (message.type === 'notice') {
      if (typeof message.text === 'string') this.callbacks.notify(`${state.record.manifest.name}: ${message.text.slice(0, 500)}`, message.kind === 'error' ? 'error' : 'success')
    }
  }

  private register(state: RuntimeState, message: Extract<PluginToHostMessage, { type: 'register' }>): void {
    if (!Number.isSafeInteger(message.registrationId) || message.registrationId < 1 || state.registrations.has(message.registrationId) || state.registrations.size >= 64) return
    if (message.kind === 'command') {
      if (!state.record.manifest.contributes.commands.some((item) => item.command === message.command)) return
      if ([...state.registrations.values()].some((item) => item.kind === 'command' && item.command === message.command)) return
      state.registrations.set(message.registrationId, { kind: 'command', command: message.command })
      return
    }
    if (!/^[a-z][a-z0-9+.#-]{0,39}$/i.test(message.language)) return
    if (message.kind === 'completion') {
      const triggerCharacters = Array.isArray(message.triggerCharacters)
        ? message.triggerCharacters.filter((item) => typeof item === 'string' && item.length === 1).slice(0, 16)
        : []
      const disposable = monaco.languages.registerCompletionItemProvider(message.language, {
        triggerCharacters,
        provideCompletionItems: async (model, position) => {
          const document = documentFor(model)
          if (!document || state.disposed) return { suggestions: [] }
          try {
            const value = await this.invoke(state, message.registrationId, document, positionFor(position))
            if (!Array.isArray(value)) return { suggestions: [] }
            const word = model.getWordUntilPosition(position)
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
            const suggestions: monaco.languages.CompletionItem[] = value.slice(0, 100).flatMap((item: unknown) => {
              if (!item || typeof item !== 'object' || !('label' in item) || typeof item.label !== 'string' || item.label.length > 200) return []
              const completion = item as PluginCompletionItem
              return [{
                label: completion.label,
                kind: completionKind(completion.kind),
                insertText: typeof completion.insertText === 'string' ? completion.insertText : completion.label,
                insertTextRules: completion.kind === 'snippet' ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                detail: typeof completion.detail === 'string' ? completion.detail : undefined,
                documentation: typeof completion.documentation === 'string' ? completion.documentation : undefined,
                range,
              }]
            })
            return { suggestions }
          } catch { return { suggestions: [] } }
        },
      })
      state.registrations.set(message.registrationId, { kind: 'provider', disposable })
    } else {
      const disposable = monaco.languages.registerHoverProvider(message.language, {
        provideHover: async (model, position) => {
          const document = documentFor(model)
          if (!document || state.disposed) return null
          try {
            const value = await this.invoke(state, message.registrationId, document, positionFor(position))
            if (typeof value !== 'string' || !value.trim()) return null
            return { contents: [{ value: value.slice(0, 8_000) }] }
          } catch { return null }
        },
      })
      state.registrations.set(message.registrationId, { kind: 'provider', disposable })
    }
  }

  private unregister(state: RuntimeState, registrationId: number): void {
    const registration = state.registrations.get(registrationId)
    if (!registration) return
    if (registration.kind === 'provider') registration.disposable.dispose()
    state.registrations.delete(registrationId)
  }

  private invoke(state: RuntimeState, registrationId: number, document?: PluginDocument, position?: PluginPosition): Promise<unknown> {
    if (!state.worker || state.disposed) return Promise.reject(new Error('插件未运行。'))
    return new Promise<unknown>((resolve, reject) => {
      const requestId = state.nextRequestId++
      const timer = window.setTimeout(() => {
        state.pending.delete(requestId)
        reject(new Error('插件响应超时。'))
      }, INVOCATION_TIMEOUT_MS)
      state.pending.set(requestId, { resolve, reject, timer })
      state.worker!.postMessage({ type: 'invoke', requestId, registrationId, document, position } satisfies HostToPluginMessage)
    })
  }

  private stop(state: RuntimeState, reason: Error): void {
    if (state.disposed) return
    state.disposed = true
    if (state.activationTimer !== null) window.clearTimeout(state.activationTimer)
    state.rejectActivation?.(reason)
    state.resolveActivation = null
    state.rejectActivation = null
    for (const pending of state.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(reason)
    }
    state.pending.clear()
    for (const registration of state.registrations.values()) {
      if (registration.kind === 'provider') registration.disposable.dispose()
    }
    state.registrations.clear()
    if (state.worker) {
      const worker = state.worker
      worker.postMessage({ type: 'deactivate' } satisfies HostToPluginMessage)
      window.setTimeout(() => worker.terminate(), 250)
      state.worker = null
    }
  }
}
