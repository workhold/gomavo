import type { NativePluginManifest } from './nativePlugins'

export interface PluginDocument {
  uri: string
  languageId: string
  text: string
}

export interface PluginPosition {
  lineNumber: number
  column: number
}

export interface PluginCompletionItem {
  label: string
  insertText?: string
  detail?: string
  documentation?: string
  kind?: 'text' | 'function' | 'method' | 'variable' | 'keyword' | 'snippet'
}

export interface PluginDisposable {
  dispose(): void
}

export interface NativePluginContext {
  subscriptions: PluginDisposable[]
  workspace: {
    readonly rootPath: string | null
    onDidChangeWorkspace(listener: (rootPath: string | null) => void): PluginDisposable
  }
  window: {
    showInformationMessage(message: string): void
    showErrorMessage(message: string): void
  }
  commands: {
    registerCommand(command: string, handler: () => void | Promise<void>): PluginDisposable
  }
  languages: {
    registerCompletionItemProvider(language: string, provider: {
      triggerCharacters?: string[]
      provideCompletionItems(document: PluginDocument, position: PluginPosition): PluginCompletionItem[] | Promise<PluginCompletionItem[]>
    }): PluginDisposable
    registerHoverProvider(language: string, provider: {
      provideHover(document: PluginDocument, position: PluginPosition): string | null | Promise<string | null>
    }): PluginDisposable
  }
}

export type HostToPluginMessage =
  | { type: 'activate'; code: string; manifest: NativePluginManifest; rootPath: string | null }
  | { type: 'invoke'; requestId: number; registrationId: number; document?: PluginDocument; position?: PluginPosition }
  | { type: 'workspaceChanged'; rootPath: string | null }
  | { type: 'deactivate' }

export type PluginToHostMessage =
  | { type: 'activated' }
  | { type: 'activationError'; error: string }
  | { type: 'register'; registrationId: number; kind: 'command'; command: string }
  | { type: 'register'; registrationId: number; kind: 'completion'; language: string; triggerCharacters: string[] }
  | { type: 'register'; registrationId: number; kind: 'hover'; language: string }
  | { type: 'unregister'; registrationId: number }
  | { type: 'response'; requestId: number; value?: unknown; error?: string }
  | { type: 'notice'; kind: 'success' | 'error'; text: string }
