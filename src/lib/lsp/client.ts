import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type * as Monaco from 'monaco-editor'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
import type {
  LspCodeAction,
  LspCompletionDefaults,
  LspCompletionItem,
  LspCompletionList,
  LspDiagnostic,
  LspDocumentSymbol,
  LspEvent,
  LspHover,
  LspInlayHint,
  LspLocation,
  LspLocationLink,
  LspPosition,
  LspSemanticTokens,
  LspSemanticTokensCapability,
  LspSignatureHelp,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
  OpenDocument,
  PendingRequest,
  RpcMessage,
} from './protocol'
import { fileUri, normalizePath, uriToPath } from './uri'

type MonacoApi = typeof import('monaco-editor')

export interface DefinitionTarget {
  path: string
  /** Monaco coordinates are one based. */
  line: number
  column: number
}

export interface DiagnosticEntry {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
}

export interface WorkspaceSymbolEntry {
  name: string
  kind: string
  container: string
  path: string
  line: number
  column: number
}

export type DiagnosticsCallback = (items: DiagnosticEntry[]) => void
export type OpenDefinitionCallback = (target: DefinitionTarget, source: Monaco.editor.ICodeEditor) => boolean | Promise<boolean>
/** Apply gopls edits (rename, quick fixes) across files, including unopened ones. */
export type WorkspaceEditCallback = (changes: Record<string, LspTextEdit[]>) => Promise<void>

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split('\n')
  return { line: lines.length - 1, character: lines[lines.length - 1].length }
}

/** Rewrite one document's text with LSP text edits. */
export function applyTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  if (!edits.length) return text
  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1)
  }
  const offset = (position: { line: number; character: number }): number => {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character)
      || position.line < 0 || position.line >= lineStarts.length || position.character < 0) {
      throw new Error('gopls returned an invalid formatting range')
    }
    const start = lineStarts[position.line]
    let end = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] - 1 : text.length
    if (end > start && text[end - 1] === '\r') end -= 1
    if (start + position.character > end) throw new Error('gopls returned an invalid formatting range')
    return start + position.character
  }
  const ordered = edits.map((edit) => ({
    start: offset(edit.range.start),
    end: offset(edit.range.end),
    text: edit.newText,
  })).sort((left, right) => right.start - left.start || right.end - left.end)
  let previousStart = text.length + 1
  let result = text
  for (const edit of ordered) {
    if (edit.end < edit.start || edit.end > previousStart) throw new Error('gopls returned overlapping formatting edits')
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    previousStart = edit.start
  }
  return result
}

function isLocationLink(value: LspLocation | LspLocationLink): value is LspLocationLink {
  return 'targetUri' in value
}

function locations(value: unknown): LspLocation[] {
  if (!value) return []
  const items = Array.isArray(value) ? value : [value]
  return items
    .filter((item): item is LspLocation | LspLocationLink =>
      typeof item === 'object' && item !== null && ('uri' in item || 'targetUri' in item),
    )
    .map((item) =>
      isLocationLink(item)
        ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
        : item,
    )
}

const lifecycleQueues = new Map<string, Promise<void>>()

function withLifecycleLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = lifecycleQueues.get(root) ?? Promise.resolve()
  const task = previous.then(action)
  const settled = task.then(() => undefined, () => undefined)
  lifecycleQueues.set(root, settled)
  void settled.then(() => {
    if (lifecycleQueues.get(root) === settled) lifecycleQueues.delete(root)
  })
  return task
}

/** A small, workspace scoped JSON-RPC client for the Rust gopls bridge. */
export class GoplsClient {
  private readonly root: string
  private readonly monaco: MonacoApi
  private readonly onDiagnostics?: DiagnosticsCallback
  private readonly onFailure?: (message: string) => void
  private readonly onOpenDefinition?: OpenDefinitionCallback
  private readonly onWorkspaceEdit?: WorkspaceEditCallback
  private readonly documents = new Map<string, OpenDocument>()
  private readonly diagnostics = new Map<string, LspDiagnostic[]>()
  private readonly semanticListeners = new Set<() => void>()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly disposables: Monaco.IDisposable[] = []
  private unlistenMessage?: UnlistenFn
  private nextId = 1
  private ready = false
  private stopped = false
  private failureInProgress = false
  private startTask?: Promise<void>
  private backendStopTask?: Promise<void>
  private sendQueue: Promise<unknown> = Promise.resolve()
  private syncKind = 1
  private semanticLegend?: Monaco.languages.SemanticTokensLegend
  private serverCommandId?: string
  private goplsSettings: { localPrefix?: string } = {}

  constructor(
    root: string,
    monaco: MonacoApi,
    onDiagnostics?: DiagnosticsCallback,
    onFailure?: (message: string) => void,
    onOpenDefinition?: OpenDefinitionCallback,
    onWorkspaceEdit?: WorkspaceEditCallback,
  ) {
    this.root = normalizePath(root)
    this.monaco = monaco
    this.onDiagnostics = onDiagnostics
    this.onFailure = onFailure
    this.onOpenDefinition = onOpenDefinition
    this.onWorkspaceEdit = onWorkspaceEdit
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('gopls client has stopped')
    if (this.ready) return
    if (this.startTask) return this.startTask

    this.startTask = this.startInner()
    try {
      await this.startTask
    } finally {
      this.startTask = undefined
    }
  }

  private async startInner(): Promise<void> {
    try {
      this.unlistenMessage = await listen<LspEvent>('lsp-message', (event) => {
        if (normalizePath(event.payload.root) !== this.root) return
        this.receive(event.payload.message)
      }, { target: getCurrentWebviewWindow().label })

      if (this.stopped) throw new Error('gopls client has stopped')
      this.backendStopTask = undefined
      await withLifecycleLock(this.root, () => {
        if (this.stopped) throw new Error('gopls client has stopped')
        return invoke<void>('lsp_start', { root: this.root })
      })
      if (this.stopped) throw new Error('gopls client has stopped')
      const result = await this.request<{
        capabilities?: {
          textDocumentSync?: number | { change?: number }
          semanticTokensProvider?: LspSemanticTokensCapability
        }
      }>('initialize', {
        processId: null,
        clientInfo: { name: 'mgland', version: '0.1.0' },
        rootUri: fileUri(this.root),
        workspaceFolders: [{ uri: fileUri(this.root), name: this.root.split('/').pop() || this.root }],
        initializationOptions: { semanticTokens: true },
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
            codeAction: {
              dynamicRegistration: false,
              isPreferredSupport: true,
              disabledSupport: false,
              dataSupport: true,
              resolveSupport: { properties: ['edit'] },
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports', 'source.fixall'],
                },
              },
            },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            // resolveSupport must be an object per LSP; a boolean makes gopls
            // reject the whole initialize params. Hints arrive fully resolved.
            inlayHint: { dynamicRegistration: false },
            formatting: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true },
              tokenTypes: [
                'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
                'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
                'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp',
                'operator', 'decorator', 'label',
              ],
              tokenModifiers: [
                'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
                'async', 'modification', 'documentation', 'defaultLibrary',
                // gopls also describes the underlying Go type and format verbs.
                'array', 'bool', 'chan', 'format', 'interface', 'map', 'number',
                'pointer', 'signature', 'slice', 'string', 'struct', 'shadowing',
              ],
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
            },
          },
        },
      }, 15000)

      const sync = result?.capabilities?.textDocumentSync
      if (this.stopped) throw new Error('gopls client has stopped')
      this.syncKind = typeof sync === 'number' ? sync : (sync?.change ?? 1)
      const semantic = result?.capabilities?.semanticTokensProvider
      this.semanticLegend = semantic?.full && semantic.legend?.tokenTypes?.length
        ? semantic.legend
        : undefined
      await this.notify('initialized', {})
      if (this.stopped) throw new Error('gopls client has stopped')
      this.ready = true
      this.registerProviders()
    } catch (error) {
      await this.cleanup()
      throw new Error(`Unable to start gopls: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.cleanup()
  }

  private async cleanup(): Promise<void> {
    this.ready = false
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    for (const documentUri of this.documents.keys()) {
      const model = this.monaco.editor.getModel(this.monaco.Uri.parse(documentUri))
      if (model) this.monaco.editor.setModelMarkers(model, 'gopls', [])
    }
    this.documents.clear()
    this.diagnostics.clear()
    this.semanticLegend = undefined
    this.semanticListeners.clear()
    this.emitDiagnostics()
    this.rejectPending(new Error('gopls stopped'))
    this.unlistenMessage?.()
    this.unlistenMessage = undefined
    this.backendStopTask ??= withLifecycleLock(this.root, () => invoke<void>('lsp_stop', { root: this.root }))
      .catch(() => undefined)
    await this.backendStopTask
  }

  private handleServerFailure(message: string): void {
    if (this.stopped || this.failureInProgress) return
    this.failureInProgress = true
    const wasReady = this.ready
    this.stopped = true
    this.rejectPending(new Error(message))
    void this.cleanup()
    if (wasReady) this.onFailure?.(message)
  }

  async openDocument(path: string, text: string): Promise<void> {
    await this.start()
    const uri = fileUri(path)
    if (this.documents.has(uri)) {
      await this.changeDocument(path, text)
      return
    }
    this.documents.set(uri, { text, version: 1 })
    const name = normalizePath(path).split('/').pop()
    const languageId = name === 'go.mod' || name === 'go.work' ? name : 'go'
    await this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
    this.applyDiagnostics(uri)
    this.emitDiagnostics()
  }

  async changeDocument(path: string, text: string): Promise<void> {
    await this.start()
    const uri = fileUri(path)
    const document = this.documents.get(uri)
    if (!document) {
      await this.openDocument(path, text)
      return
    }
    if (document.text === text) return

    const change = this.syncKind === 2
      ? { range: { start: { line: 0, character: 0 }, end: endPosition(document.text) }, text }
      : { text }
    document.text = text
    document.version += 1
    await this.notify('textDocument/didChange', {
      textDocument: { uri, version: document.version },
      contentChanges: [change],
    })
  }

  async saveDocument(path: string, savedText?: string): Promise<void> {
    await this.start()
    const uri = fileUri(path)
    if (savedText !== undefined) await this.changeDocument(path, savedText)
    else {
      const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
      if (model) await this.syncModel(model)
    }
    const document = this.documents.get(uri)
    if (!document) return
    await this.notify('textDocument/didSave', { textDocument: { uri }, text: savedText ?? document.text })
  }

  /** Format a captured document without mutating its editor model. Null means a newer edit superseded the request. */
  async formatDocument(path: string, text: string, options: { tabSize: number; insertSpaces: boolean }): Promise<string | null> {
    await this.changeDocument(path, text)
    const uri = fileUri(path)
    const version = this.documents.get(uri)?.version
    const edits = await this.request<LspTextEdit[] | null>('textDocument/formatting', {
      textDocument: { uri },
      options,
    })
    if (this.stopped || this.documents.get(uri)?.version !== version) return null
    return applyTextEdits(text, edits ?? [])
  }

  async closeDocument(path: string): Promise<void> {
    const uri = fileUri(path)
    if (!this.documents.delete(uri)) return
    this.diagnostics.delete(uri)
    this.emitDiagnostics()
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
    if (model) this.monaco.editor.setModelMarkers(model, 'gopls', [])
    if (this.ready) await this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  /** Resolve a definition to a local path and one based editor coordinates. */
  async goToDefinition(path: string, line: number, column: number): Promise<DefinitionTarget | null> {
    await this.start()
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(fileUri(path)))
    if (model) await this.syncModel(model)
    const result = await this.request<unknown>('textDocument/definition', {
      textDocument: { uri: fileUri(path) },
      position: { line: line - 1, character: column - 1 },
    })
    const first = locations(result)[0]
    return first
      ? { path: uriToPath(first.uri), line: first.range.start.line + 1, column: first.range.start.character + 1 }
      : null
  }

  private registerProviders(): void {
    if (!this.monaco.languages.getLanguages().some(({ id }) => id === 'go')) {
      this.monaco.languages.register({ id: 'go', extensions: ['.go'], aliases: ['Go'] })
    }

    if (this.onOpenDefinition) {
      this.disposables.push(this.monaco.editor.registerEditorOpener({
        openCodeEditor: async (source, resource, selectionOrPosition) => {
          if (resource.scheme !== 'file' || !resource.path.endsWith('.go')) return false
          const sourceUri = source.getModel()?.uri.toString()
          if (!sourceUri || !this.owns(sourceUri)) return false
          const line = selectionOrPosition && 'startLineNumber' in selectionOrPosition
            ? selectionOrPosition.startLineNumber
            : selectionOrPosition?.lineNumber ?? 1
          const column = selectionOrPosition && 'startColumn' in selectionOrPosition
            ? selectionOrPosition.startColumn
            : selectionOrPosition?.column ?? 1
          return this.onOpenDefinition?.({ path: uriToPath(resource.toString()), line, column }, source) ?? false
        },
      }))
    }

    this.disposables.push(
      this.monaco.editor.onDidCreateModel((model) => this.applyDiagnostics(model.uri.toString())),
      this.monaco.languages.registerCompletionItemProvider('go', {
        triggerCharacters: ['.', '"', '/', ':'],
        provideCompletionItems: async (model, position) => {
          if (!this.owns(model.uri.toString())) return { suggestions: [] }
          try {
            await this.syncModel(model)
            const response = await this.request<LspCompletionItem[] | LspCompletionList>(
              'textDocument/completion',
              {
                textDocument: { uri: model.uri.toString() },
                position: { line: position.lineNumber - 1, character: position.column - 1 },
              },
            )
            const items = Array.isArray(response) ? response : response?.items ?? []
            const defaults = Array.isArray(response) ? undefined : response?.itemDefaults
            const word = model.getWordUntilPosition(position)
            const defaultRange = new this.monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            )
            return {
              incomplete: !Array.isArray(response) && Boolean(response?.isIncomplete),
              suggestions: items.map((item) => this.toCompletion(item, defaultRange, defaults)),
            }
          } catch {
            return { suggestions: [] }
          }
        },
      }),
      this.monaco.languages.registerHoverProvider('go', {
        provideHover: async (model, position) => {
          if (!this.owns(model.uri.toString())) return null
          try {
            await this.syncModel(model)
            const hover = await this.request<LspHover | null>('textDocument/hover', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            })
            if (!hover) return null
            const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
            return {
              contents: contents.map((content) => {
                if (typeof content === 'string') return { value: content }
                if ('language' in content) return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` }
                return { value: content.value }
              }),
              range: hover.range ? this.toMonacoRange(hover.range) : undefined,
            }
          } catch {
            return null
          }
        },
      }),
      this.monaco.languages.registerDefinitionProvider('go', {
        provideDefinition: async (model, position) => {
          if (!this.owns(model.uri.toString())) return null
          try {
            await this.syncModel(model)
            const result = await this.request<unknown>('textDocument/definition', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            })
            return locations(result).map((location) => ({
              uri: this.monaco.Uri.parse(location.uri),
              range: this.toMonacoRange(location.range),
            }))
          } catch {
            return null
          }
        },
      }),
      this.monaco.languages.registerDocumentFormattingEditProvider('go', {
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!this.owns(model.uri.toString()) || token.isCancellationRequested) return []
          const version = model.getVersionId()
          try {
            await this.syncModel(model)
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return []
            const edits = await this.request<LspTextEdit[] | null>('textDocument/formatting', {
              textDocument: { uri: model.uri.toString() },
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            })
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return []
            return (edits ?? []).map((edit) => ({ range: this.toMonacoRange(edit.range), text: edit.newText }))
          } catch {
            return []
          }
        },
      }),
    )

    // --- References (Find Usages, ⇧F12) -----------------------------------
    this.disposables.push(this.monaco.languages.registerReferenceProvider('go', {
      provideReferences: async (model, position) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          await this.syncModel(model)
          const result = await this.request<unknown>('textDocument/references', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: false },
          })
          return locations(result).map((location) => ({
            uri: this.monaco.Uri.parse(location.uri),
            range: this.toMonacoRange(location.range),
          }))
        } catch {
          return null
        }
      },
    }))

    // --- Rename refactoring (F2) -------------------------------------------
    this.disposables.push(this.monaco.languages.registerRenameProvider('go', {
      provideRenameEdits: async (model, position, newName) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          await this.syncModel(model)
          const edit = await this.request<LspWorkspaceEdit | null>('textDocument/rename', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            newName,
          })
          if (!edit) return null
          const changes = this.workspaceEditChanges(edit)
          const current = model.uri.toString()
          const others = Object.fromEntries(Object.entries(changes).filter(([uri]) => uri !== current))
          if (Object.keys(others).length && this.onWorkspaceEdit) await this.onWorkspaceEdit(others)
          const modelEdits = (changes[current] ?? []).map((textEdit) => ({
            resource: model.uri,
            textEdit: {
              range: this.toMonacoRange(textEdit.range),
              text: textEdit.newText,
            },
            versionId: undefined,
          }))
          return modelEdits.length ? { edits: modelEdits } : null
        } catch {
          return null
        }
      },
      resolveRenameLocation: async (model, position) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          await this.syncModel(model)
          const prepare = await this.request<{ range?: unknown; placeholder?: string } | null>(
            'textDocument/prepareRename',
            {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            },
          )
          if (!prepare) return null
          const word = model.getWordAtPosition(position)
          return {
            range: prepare.range ? this.toMonacoRange(prepare.range as { start: LspPosition; end: LspPosition })
              : word
                ? new this.monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
                : new this.monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: prepare.placeholder ?? word?.word ?? '',
          }
        } catch {
          return null
        }
      },
    }))

    // --- Quick fixes and refactorings (the lightbulb, ⌘.) -------------------
    this.disposables.push(this.monaco.languages.registerCodeActionProvider('go', {
      provideCodeActions: async (model, range) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          await this.syncModel(model)
          const markers = this.monaco.editor.getModelMarkers({ resource: model.uri, owner: 'gopls' })
          const diagnostics: LspDiagnostic[] = markers.map((marker) => ({
            range: {
              start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
              end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
            },
            message: marker.message,
          }))
          const actions = await this.request<LspCodeAction[] | null>('textDocument/codeAction', {
            textDocument: { uri: model.uri.toString() },
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            context: { diagnostics, only: undefined },
          })
          const mapped: Monaco.languages.CodeAction[] = []
          for (const action of actions ?? []) {
            if (action.edit) {
              const changes = this.workspaceEditChanges(action.edit)
              const current = model.uri.toString()
              const others = Object.fromEntries(Object.entries(changes).filter(([uri]) => uri !== current))
              if (Object.keys(others).length && this.onWorkspaceEdit) {
                // The lightbulb applies other files immediately; the current
                // model keeps its edit for Monaco's undo stack.
                void this.onWorkspaceEdit(others).catch(() => undefined)
              }
              const modelEdits = (changes[current] ?? []).map((textEdit) => ({
                resource: model.uri,
                textEdit: {
                  range: this.toMonacoRange(textEdit.range),
                  text: textEdit.newText,
                },
                versionId: undefined,
              }))
              if (modelEdits.length) {
                mapped.push({
                  title: action.title,
                  kind: action.kind,
                  isPreferred: action.isPreferred,
                  edit: { edits: modelEdits },
                })
              }
              continue
            }
            if (action.command) {
              mapped.push({
                title: action.title,
                kind: action.kind,
                isPreferred: action.isPreferred,
                command: {
                  id: this.ensureServerCommand(),
                  title: action.title,
                  arguments: [action.command.command, action.command.arguments ?? []],
                },
              })
            }
          }
          return { actions: mapped, dispose: () => undefined }
        } catch {
          return null
        }
      },
    }))

    // --- Signature help (parameter hints) ----------------------------------
    this.disposables.push(this.monaco.languages.registerSignatureHelpProvider('go', {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      provideSignatureHelp: async (model, position) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          await this.syncModel(model)
          const help = await this.request<LspSignatureHelp | null>('textDocument/signatureHelp', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          })
          if (!help?.signatures?.length) return null
          return {
            value: {
              activeSignature: help.activeSignature ?? 0,
              activeParameter: help.activeParameter ?? 0,
              signatures: help.signatures.map((signature) => ({
                label: signature.label,
                documentation: typeof signature.documentation === 'string'
                  ? signature.documentation
                  : signature.documentation?.value,
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: Array.isArray(parameter.label)
                    ? signature.label.slice(parameter.label[0], parameter.label[1])
                    : parameter.label,
                  documentation: typeof parameter.documentation === 'string'
                    ? parameter.documentation
                    : parameter.documentation?.value,
                })),
              })),
            },
            dispose: () => undefined,
          }
        } catch {
          return null
        }
      },
    }))

    // --- Inlay hints (parameter names, inferred types, constants) ----------
    this.disposables.push(this.monaco.languages.registerInlayHintsProvider('go', {
      onDidChangeInlayHints: undefined,
      provideInlayHints: async (model, range) => {
        if (!this.owns(model.uri.toString())) return { hints: [], dispose: () => undefined }
        try {
          await this.syncModel(model)
          const hints = await this.request<LspInlayHint[] | null>('textDocument/inlayHint', {
            textDocument: { uri: model.uri.toString() },
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
          }, 20000)
          return {
            hints: (hints ?? []).map((hint) => ({
              position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
              label: typeof hint.label === 'string'
                ? hint.label
                : hint.label.map((part) => ({ label: part.value, location: undefined })),
              tooltip: typeof hint.tooltip === 'string'
                ? hint.tooltip
                : hint.tooltip && 'value' in hint.tooltip ? hint.tooltip.value : undefined,
              paddingLeft: true,
            })),
            dispose: () => undefined,
          }
        } catch {
          return { hints: [], dispose: () => undefined }
        }
      },
    }))

    // --- Document symbols (outline, ⌘F12) ----------------------------------
    this.disposables.push(this.monaco.languages.registerDocumentSymbolProvider('go', {
      provideDocumentSymbols: async (model) => {
        if (!this.owns(model.uri.toString())) return []
        try {
          await this.syncModel(model)
          const symbols = await this.request<LspDocumentSymbol[] | null>('textDocument/documentSymbol', {
            textDocument: { uri: model.uri.toString() },
          })
          return (symbols ?? []).map((symbol) => this.toMonacoSymbol(symbol))
        } catch {
          return []
        }
      },
    }))

    if (this.semanticLegend) {
      const legendTypes = [...this.semanticLegend.tokenTypes, 'qualifiedCall']
      const legendModifiers = this.semanticLegend.tokenModifiers ?? []
      this.disposables.push(this.monaco.languages.registerDocumentSemanticTokensProvider('go', {
        onDidChange: (listener) => {
          const callback = () => listener(undefined)
          this.semanticListeners.add(callback)
          return { dispose: () => this.semanticListeners.delete(callback) }
        },
        getLegend: () => ({ tokenTypes: legendTypes, tokenModifiers: legendModifiers }),
        provideDocumentSemanticTokens: async (model) => {
          if (!this.owns(model.uri.toString())) return null
          try {
            await this.syncModel(model)
            const tokens = await this.request<LspSemanticTokens | null>(
              'textDocument/semanticTokens/full',
              { textDocument: { uri: model.uri.toString() } },
              20000,
            )
            return tokens ? { resultId: tokens.resultId, data: this.annotateCallSites(Uint32Array.from(tokens.data)) } : null
          } catch {
            return null
          }
        },
        releaseDocumentSemanticTokens: () => undefined,
      }))
    }
  }

    /**
     * GoLand-style call-site coloring derived from the token stream:
     * - bare in-package function calls (`NormalHandler()`) stay plain white
     *   (GoLand's DEFAULT_FUNCTION_CALL);
     * - bare method calls (`t.Fatalf`, `c.Get`) keep the blue method color
     *   (GoLand's DEFAULT_INSTANCE_METHOD);
     * - package-qualified calls (`errors.New`, `fmt.Println`, `user.GetByID`)
     *   take the blue italic static-method color (GoLand's DEFAULT_STATIC_METHOD).
     */
    private annotateCallSites(data: Uint32Array): Uint32Array {
      const legendTypes = this.semanticLegend?.tokenTypes
      if (!legendTypes?.length) return data
      const namespaceIdx = legendTypes.indexOf('namespace')
      const functionIdx = legendTypes.indexOf('function')
      const defModIdx = this.semanticLegend?.tokenModifiers
        ? this.semanticLegend.tokenModifiers.indexOf('definition')
        : -1
      if (functionIdx < 0 || namespaceIdx < 0) return data
      const qualifiedIdx = legendTypes.length // 'qualifiedCall' appended by getLegend
      const out = new Uint32Array(data)
      let line = 0
      let char = 0
      let prevType = -1
      let prevLine = -1
      let prevEnd = -1
      for (let i = 0; i + 4 < out.length; i += 5) {
        const deltaLine = out[i]
        const deltaChar = out[i + 1]
        if (deltaLine > 0) {
          line += deltaLine
          char = deltaChar
        } else {
          char += deltaChar
        }
        const typeIdx = out[i + 3]
        const modBits = out[i + 4]
        const len = out[i + 2]
        const isDeclaration = defModIdx >= 0 && (modBits & (1 << defModIdx)) !== 0
        const qualified = prevType === namespaceIdx && prevLine === line && char === prevEnd + 1
        if (typeIdx === functionIdx && !isDeclaration && qualified) {
          out[i + 3] = qualifiedIdx
        }
        prevType = typeIdx
        prevLine = line
        prevEnd = char + len
      }
      return out
    }

  /** Normalize `changes` and `documentChanges` into one uri→edits map. */
  private workspaceEditChanges(edit: LspWorkspaceEdit): Record<string, LspTextEdit[]> {
    const changes: Record<string, LspTextEdit[]> = {}
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
      if (Array.isArray(edits)) changes[uri] = changes[uri] ? [...changes[uri], ...edits] : [...edits]
    }
    for (const change of edit.documentChanges ?? []) {
      const uri = change.textDocument?.uri
      const edits = change.edits
      if (!uri || !Array.isArray(edits)) continue
      const current = changes[uri] ?? []
      // Edits in one documentChanges entry share the same document version.
      changes[uri] = [...current, ...edits]
    }
    return changes
  }

  /**
   * Register a single standalone editor command that runs gopls server
   * commands (quickfix et al.) for code actions that carry `command`.
   */
  private ensureServerCommand(): string {
    if (this.serverCommandId) return this.serverCommandId
    const id = `mgland.gopls.command.${this.nextId}`
    this.serverCommandId = id
    this.disposables.push(this.monaco.editor.registerCommand(id, (_accessor, command: string, args: unknown[]) => {
      void (async () => {
        try {
          await this.request('workspace/executeCommand', { command, arguments: args })
        } catch {
          // gopls may refuse stale commands; markers refresh shows the result.
        }
      })()
    }))
    return id
  }

  private symbolKind(kind: number): Monaco.languages.SymbolKind {
    const K = this.monaco.languages.SymbolKind
    const kinds = [
      K.File, K.Module, K.Namespace, K.Package, K.Class, K.Method, K.Property, K.Field,
      K.Constructor, K.Enum, K.Interface, K.Function, K.Variable, K.Constant, K.String,
      K.Number, K.Boolean, K.Array, K.Object, K.Key, K.Null, K.EnumMember, K.Struct,
      K.Event, K.Operator, K.TypeParameter,
    ]
    return kinds[(kind ?? 1) - 1] ?? K.Object
  }

  private toMonacoSymbol(symbol: LspDocumentSymbol): Monaco.languages.DocumentSymbol {
    return {
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: this.symbolKind(symbol.kind),
      range: this.toMonacoRange(symbol.range),
      selectionRange: this.toMonacoRange(symbol.selectionRange),
      children: symbol.children?.map((child) => this.toMonacoSymbol(child)),
      tags: [],
    }
  }

  /** Update gopls settings and push them to a running server. */
  setConfig(settings: { localPrefix?: string }): void {
    this.goplsSettings = settings
    if (this.ready) {
      void this.notify('workspace/didChangeConfiguration', { settings: { gopls: { ...settings } } }).catch(() => undefined)
    }
  }

  /** Query workspace symbols for the palette's symbol search. */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbolEntry[]> {
    await this.start()
    const result = await this.request<LspSymbolInformation[] | null>('workspace/symbol', { query }, 15000)
    return (result ?? []).slice(0, 60).map((symbol) => ({
      name: symbol.name,
      kind: this.symbolKindName(symbol.kind),
      container: symbol.containerName ?? '',
      path: uriToPath(symbol.location.uri),
      line: symbol.location.range.start.line + 1,
      column: symbol.location.range.start.character + 1,
    }))
  }

  private symbolKindName(kind: number): string {
    const names = [
      'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field',
      'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string',
      'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct',
      'event', 'operator', 'type parameter',
    ]
    return names[(kind ?? 1) - 1] ?? 'symbol'
  }

  private toCompletion(
    item: LspCompletionItem,
    defaultRange: Monaco.Range,
    defaults?: LspCompletionDefaults,
  ): Monaco.languages.CompletionItem {
    const label = typeof item.label === 'string' ? item.label : item.label.label
    const edit = item.textEdit
    const lspRange = edit ?? defaults?.editRange
    const editRange = lspRange
      ? 'range' in lspRange
        ? this.toMonacoRange(lspRange.range)
        : 'insert' in lspRange
          ? { insert: this.toMonacoRange(lspRange.insert), replace: this.toMonacoRange(lspRange.replace) }
          : this.toMonacoRange(lspRange)
      : defaultRange
    const kind = this.completionKind(item.kind)
    return {
      label,
      kind,
      range: editRange,
      insertText: edit?.newText ?? item.textEditText ?? item.insertText ?? label,
      insertTextRules: (item.insertTextFormat ?? defaults?.insertTextFormat) === 2
        ? this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      detail: item.detail ?? (typeof item.label === 'string' ? undefined : item.label.detail),
      documentation: typeof item.documentation === 'string'
        ? item.documentation
        : item.documentation?.value,
      sortText: item.sortText,
      filterText: item.filterText,
      preselect: item.preselect,
      commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
      additionalTextEdits: item.additionalTextEdits?.map((textEdit) => ({
        range: this.toMonacoRange(textEdit.range),
        text: textEdit.newText,
      })),
    }
  }

  private completionKind(kind?: number): Monaco.languages.CompletionItemKind {
    const K = this.monaco.languages.CompletionItemKind
    const kinds = [
      K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class,
      K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword,
      K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant,
      K.Struct, K.Event, K.Operator, K.TypeParameter,
    ]
    return kinds[(kind ?? 1) - 1] ?? K.Text
  }

  private toMonacoRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): Monaco.Range {
    return new this.monaco.Range(
      range.start.line + 1,
      range.start.character + 1,
      range.end.line + 1,
      range.end.character + 1,
    )
  }

  private async syncModel(model: Monaco.editor.ITextModel): Promise<void> {
    const uri = model.uri.toString()
    if (!this.owns(uri)) return
    const path = uriToPath(uri)
    const document = this.documents.get(fileUri(path))
    const text = model.getValue()
    if (!document) await this.openDocument(path, text)
    else if (document.text !== text) await this.changeDocument(path, text)
  }

  private owns(uri: string): boolean {
    const normalizedUri = fileUri(uriToPath(uri))
    if (this.documents.has(normalizedUri)) return true
    const path = normalizePath(uriToPath(uri))
    const windows = /^[A-Za-z]:\//.test(this.root)
    const root = windows ? this.root.toLowerCase() : this.root
    const candidate = windows ? path.toLowerCase() : path
    return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`)
  }

  private applyDiagnostics(uri: string): void {
    if (!this.owns(uri)) return
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
    if (!model) return
    const markers: Monaco.editor.IMarkerData[] = (this.diagnostics.get(uri) ?? []).map((diagnostic) => {
      const range = this.toMonacoRange(diagnostic.range)
      const severity = diagnostic.severity === 2
        ? this.monaco.MarkerSeverity.Warning
        : diagnostic.severity === 3
          ? this.monaco.MarkerSeverity.Info
          : diagnostic.severity === 4
            ? this.monaco.MarkerSeverity.Hint
            : this.monaco.MarkerSeverity.Error
      return {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
        severity,
        message: diagnostic.message,
        source: diagnostic.source ?? 'gopls',
        code: diagnostic.code?.toString(),
        tags: diagnostic.tags?.map((tag) => tag === 1
          ? this.monaco.MarkerTag.Unnecessary
          : this.monaco.MarkerTag.Deprecated),
      }
    })
    this.monaco.editor.setModelMarkers(model, 'gopls', markers)
  }

  private receive(raw: LspEvent['message']): void {
    let decoded: RpcMessage | RpcMessage[]
    try {
      decoded = typeof raw === 'string' ? JSON.parse(raw) as RpcMessage | RpcMessage[] : raw
    } catch {
      return
    }
    for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = message.params as { uri: string; version?: number; diagnostics?: LspDiagnostic[] }
        if (!params?.uri) continue
        const uri = fileUri(uriToPath(params.uri))
        const document = this.documents.get(uri)
        if (!document || (typeof params.version === 'number' && params.version < document.version)) continue
        this.diagnostics.set(uri, params.diagnostics ?? [])
        this.applyDiagnostics(uri)
        this.emitDiagnostics()
      } else if (message.method && message.id !== undefined) {
        void this.answerServerRequest(message)
      } else if (message.id !== undefined) {
        const pending = this.pending.get(Number(message.id))
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(Number(message.id))
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    }
  }

  private emitDiagnostics(): void {
    if (!this.onDiagnostics) return
    const entries: DiagnosticEntry[] = []
    for (const uri of this.documents.keys()) {
      for (const diagnostic of this.diagnostics.get(uri) ?? []) {
        entries.push({
          path: uriToPath(uri),
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity: diagnostic.severity === 2
            ? 'warning'
            : diagnostic.severity === 3
              ? 'info'
              : diagnostic.severity === 4
                ? 'hint'
                : 'error',
          message: diagnostic.message,
        })
      }
    }
    this.onDiagnostics(entries)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async answerServerRequest(message: RpcMessage): Promise<void> {
    let result: unknown = null
    let error: RpcMessage['error']
    switch (message.method) {
      case 'workspace/configuration': {
        const params = message.params as { items?: Array<{ section?: string }> } | undefined
        result = params?.items?.map((item) => item.section === 'gopls'
          ? { semanticTokens: true, ...(this.goplsSettings.localPrefix ? { localPrefix: this.goplsSettings.localPrefix } : {}) }
          : null) ?? []
        break
      }
      case 'workspace/workspaceFolders':
        result = [{ uri: fileUri(this.root), name: this.root.split('/').pop() || this.root }]
        break
      case 'workspace/applyEdit': {
        const params = message.params as { edit?: LspWorkspaceEdit } | undefined
        const changes = params?.edit ? this.workspaceEditChanges(params.edit) : {}
        if (this.onWorkspaceEdit && Object.keys(changes).length) {
          try {
            await this.onWorkspaceEdit(changes)
            result = { applied: true }
          } catch (error) {
            result = {
              applied: false,
              failureReason: error instanceof Error ? error.message : String(error),
            }
          }
        } else {
          result = { applied: false, failureReason: 'No workspace edit handler' }
        }
        break
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        break
      case 'workspace/semanticTokens/refresh':
        for (const listener of this.semanticListeners) listener()
        break
      default:
        error = { code: -32601, message: `Method not found: ${message.method}` }
    }
    try {
      await this.send({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) })
    } catch {
      // A stopped server does not need a response.
    }
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params })
  }

  private request<T>(method: string, params: unknown, timeoutMs = 10000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private send(message: RpcMessage): Promise<void> {
    const task = this.sendQueue.then(() => withLifecycleLock(this.root, () => {
      if (this.stopped) throw new Error('gopls client has stopped')
      return invoke<void>('lsp_send', { root: this.root, message })
    }))
    this.sendQueue = task.catch(() => undefined)
    return task.catch((error: unknown) => {
      if (this.ready && !this.stopped) {
        this.handleServerFailure(error instanceof Error ? error.message : String(error))
      }
      throw error
    })
  }
}
