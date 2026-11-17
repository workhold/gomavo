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
  LspRange,
  LspSemanticTokens,
  LspSemanticTokensCapability,
  LspSignatureHelp,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
  MonacoContentChange,
  OpenDocument,
  PendingRequest,
  RpcMessage,
} from './protocol'
import { fileUri, normalizePath, uriToPath } from './uri'
import { workspaceEditChanges } from './workspaceEdit'
import { goSourceDeclarations } from '../goTests'
import { applyMonacoContentChanges } from './contentSync'

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

interface CodeActionSnapshot {
  sourceUri: string
  sourceVersion: number | null
  documentVersions: Map<string, number>
}

/** One row of the Structure tool window (flattened hierarchical symbols). */
export interface StructureSymbol {
  name: string
  kind: string
  detail: string
  container: string
  depth: number
  line: number
  column: number
}

export type DiagnosticsCallback = (items: DiagnosticEntry[]) => void
export type OpenDefinitionCallback = (target: DefinitionTarget, source: Monaco.editor.ICodeEditor) => boolean | Promise<boolean>
/** Apply gopls edits (rename, quick fixes) across files, including unopened ones. */
export interface WorkspaceEditOptions {
  /** Rename must never treat a failed read as permission to create a new file. */
  requireExisting?: boolean
  /** Recheck the source model while external files are being written. */
  validate?: () => void
}
export type WorkspaceEditCallback = (changes: Record<string, LspTextEdit[]>, options?: WorkspaceEditOptions) => Promise<void>

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
  // Same-position inserts (gopls add_test sends three at 0:0) must keep array
  // order, so sort ascending and apply back-to-front: each insert then lands
  // after the previously placed text instead of pushing before it.
  const ordered = edits.map((edit) => ({
    start: offset(edit.range.start),
    end: offset(edit.range.end),
    text: edit.newText,
  })).sort((left, right) => left.start - right.start)
  let previousStart: number | undefined
  let result = text
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index]
    if (edit.end < edit.start) throw new Error('gopls returned overlapping formatting edits')
    if (previousStart !== undefined && previousStart < edit.end) throw new Error('gopls returned overlapping formatting edits')
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
  private readonly onMissingModule?: (module: string) => void
  private readonly documents = new Map<string, OpenDocument>()
  private readonly diagnostics = new Map<string, LspDiagnostic[]>()
  private readonly codeActionSnapshots = new WeakMap<LspCodeAction, CodeActionSnapshot>()
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
  /** Last marker signature applied per URI: republished identical diagnostics skip setModelMarkers. */
  private lastMarkers = new Map<string, string>()
  private serverCommandId?: string
  private workspaceEditCommandId?: string
  private goGetCommandId?: string
  private goplsSettings: { staticcheck?: boolean; gofumpt?: boolean; local?: string } = {}
  private settingsRevision = 0

  constructor(
    root: string,
    monaco: MonacoApi,
    onDiagnostics?: DiagnosticsCallback,
    onFailure?: (message: string) => void,
    onOpenDefinition?: OpenDefinitionCallback,
    onWorkspaceEdit?: WorkspaceEditCallback,
    onMissingModule?: (module: string) => void,
  ) {
    this.root = normalizePath(root)
    this.monaco = monaco
    this.onDiagnostics = onDiagnostics
    this.onFailure = onFailure
    this.onOpenDefinition = onOpenDefinition
    this.onWorkspaceEdit = onWorkspaceEdit
    this.onMissingModule = onMissingModule
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
      const initializedSettingsRevision = this.settingsRevision
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
        initializationOptions: this.goplsSettingsPayload(),
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
      // A setting edited while initialize was in flight was absent from its
      // initializationOptions. Push the latest value once the server is ready.
      if (this.settingsRevision !== initializedSettingsRevision) {
        await this.notify('workspace/didChangeConfiguration', { settings: { gopls: this.goplsSettingsPayload() } })
      }
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

  /**
   * Push keystroke-sized content changes instead of resending the whole file:
   * on a 10k-line document a full-text didChange per keystroke serializes and
   * ships hundreds of kilobytes over the gopls pipe, which shows up as typing
   * lag. Ranges refer to the pre-change document, so applying (and sending)
   * them back-to-front keeps every range valid.
   */
  async changeDocumentIncremental(path: string, changes: readonly MonacoContentChange[], currentText: string): Promise<void> {
    await this.start()
    const uri = fileUri(path)
    // The editor may have advanced while gopls was starting. Its live model is
    // authoritative; currentText is the snapshot from the triggering event.
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
    const text = model?.getValue() ?? currentText
    const document = this.documents.get(uri)
    if (!document) {
      await this.openDocument(path, text)
      return
    }
    if (document.text === text) return
    if (!changes.length) {
      await this.changeDocument(path, text)
      return
    }
    const original = document.text
    // A missed edit (for example while didOpen was pending) makes Monaco's
    // ranges relative to a different document. Send the current full text in
    // that case so diagnostics are computed for what is actually on screen.
    if (applyMonacoContentChanges(original, changes) !== text) {
      await this.changeDocument(path, text)
      return
    }
    if (this.syncKind !== 2) {
      await this.changeDocument(path, text)
      return
    }
    const contentChanges = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset).map((change) => ({
      range: {
        start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
        end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 },
      },
      text: change.text,
    }))
    document.text = text
    document.version += 1
    await this.notify('textDocument/didChange', {
      textDocument: { uri, version: document.version },
      contentChanges,
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

  /**
   * GoLand "Optimize imports": sort and group imports, drop unused ones.
   * Returns the rewritten file, or null when the server had nothing to apply.
   */
  async organizeImports(path: string, text: string): Promise<string | null> {
    await this.start()
    await this.changeDocument(path, text)
    const uri = fileUri(path)
    if (this.stopped) return null
    const actions = await this.request<LspCodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: endPosition(text) },
      context: { diagnostics: [], only: ['source.organizeImports'] },
    }, 15000)
    if (this.stopped) return null
    let edits: LspTextEdit[] = []
    for (const action of actions ?? []) {
      if (action.kind !== 'source.organizeImports') continue
      const changes = action.edit?.changes?.[uri]
      if (changes) edits = edits.concat(changes)
      for (const change of action.edit?.documentChanges ?? []) {
        if (change.textDocument?.uri === uri && change.edits) edits = edits.concat(change.edits)
      }
    }
    if (!edits.length) return null
    return applyTextEdits(text, edits)
  }

  async closeDocument(path: string): Promise<void> {
    const uri = fileUri(path)
    if (!this.documents.delete(uri)) return
    this.diagnostics.delete(uri)
    this.lastMarkers.delete(uri)
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
      provideRenameEdits: async (model, position, newName, token) => {
        if (!this.owns(model.uri.toString())) return null
        try {
          const sourceVersion = model.getVersionId()
          const sourceText = model.getValue()
          const validateSource = () => {
            if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== sourceVersion) {
              throw new Error('Source file changed while rename was running; retry the rename')
            }
          }
          await this.syncModel(model)
          validateSource()
          const documentVersions = new Map([...this.documents].map(([uri, document]) => [uri, document.version]))
          const edit = await this.request<LspWorkspaceEdit | null>('textDocument/rename', {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            newName,
          })
          validateSource()
          if (!edit) return null
          const changes = workspaceEditChanges(edit)
          const validateRename = () => {
            validateSource()
            for (const uri of Object.keys(changes)) {
              if (documentVersions.get(uri) !== this.documents.get(uri)?.version) {
                throw new Error('A file changed while rename was running; retry the rename')
              }
            }
          }
          for (const change of edit.documentChanges ?? []) {
            const uri = change.textDocument?.uri
            const version = change.textDocument?.version
            if (uri && version != null && version !== this.documents.get(uri)?.version) {
              throw new Error('A file changed while rename was running; retry the rename')
            }
          }
          validateRename()
          const current = model.uri.toString()
          const others = Object.fromEntries(Object.entries(changes).filter(([uri]) => uri !== current))
          const sourceEdits = changes[current] ?? []
          if (Object.keys(others).length && !sourceEdits.length) {
            throw new Error('Rename returned no edit for the source file; no files were changed')
          }
          // Reject bad source ranges before touching any other file.
          applyTextEdits(sourceText, sourceEdits)
          if (Object.keys(others).length) {
            if (!this.onWorkspaceEdit) throw new Error('Workspace edits are not ready')
            await this.onWorkspaceEdit(others, { requireExisting: true, validate: validateRename })
            validateSource()
          }
          const modelEdits = sourceEdits.map((textEdit) => ({
            resource: model.uri,
            textEdit: {
              range: this.toMonacoRange(textEdit.range),
              text: textEdit.newText,
            },
            versionId: sourceVersion,
          }))
          return modelEdits.length ? { edits: modelEdits } : null
        } catch (error) {
          return { edits: [], rejectReason: error instanceof Error ? error.message : String(error) }
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
          const sourceVersion = model.getVersionId()
          await this.syncModel(model)
          if (model.isDisposed() || model.getVersionId() !== sourceVersion) return null
          const documentVersions = new Map([...this.documents].map(([uri, document]) => [uri, document.version]))
          // gopls matches quick fixes to the exact diagnostics it published
          // (their payloads ride in the diagnostic's data field), so forward
          // the raw diagnostics overlapping the selection rather than
          // rebuilding them from Monaco markers, which drop that metadata.
          const requested = {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          }
          const diagnostics = (this.diagnostics.get(model.uri.toString()) ?? [])
            .filter((diagnostic) => diagnostic.range.start.line <= requested.end.line
              && diagnostic.range.end.line >= requested.start.line)
          const actions = await this.request<LspCodeAction[] | null>('textDocument/codeAction', {
            textDocument: { uri: model.uri.toString() },
            range: requested,
            context: { diagnostics, only: undefined },
          })
          if (model.isDisposed() || model.getVersionId() !== sourceVersion) return null
          const mapped: Monaco.languages.CodeAction[] = []
          for (const action of actions ?? []) {
            if (action.edit) {
              let changes: Record<string, LspTextEdit[]>
              try { changes = workspaceEditChanges(action.edit) }
              catch { continue }
              const current = model.uri.toString()
              const others = Object.fromEntries(Object.entries(changes).filter(([uri]) => uri !== current))
              if (Object.keys(others).length) {
                if (!this.onWorkspaceEdit) continue
                // Only the selected action may mutate external files. Applying
                // them while listing lightbulb choices can change files even
                // when the user dismisses the menu.
                mapped.push({
                  title: action.title,
                  kind: action.kind,
                  isPreferred: action.isPreferred,
                  command: {
                    id: this.ensureWorkspaceEditCommand(),
                    title: action.title,
                    arguments: [changes, current, sourceVersion, documentVersions, action.command],
                  },
                })
                continue
              }
              const modelEdits = (changes[current] ?? []).map((textEdit) => ({
                resource: model.uri,
                textEdit: {
                  range: this.toMonacoRange(textEdit.range),
                  text: textEdit.newText,
                },
                versionId: sourceVersion,
              }))
              if (modelEdits.length || action.command) {
                mapped.push({
                  title: action.title,
                  kind: action.kind,
                  isPreferred: action.isPreferred,
                  ...(modelEdits.length ? { edit: { edits: modelEdits } } : {}),
                  ...(action.command ? {
                    command: {
                      id: this.ensureServerCommand(),
                      title: action.title,
                      arguments: [action.command.command, action.command.arguments ?? []],
                    },
                  } : {}),
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
          // gopls publishes no quick fix for BrokenImport while the module is
          // absent from go.mod; synthesize the GoLand-style "go get" action.
          const missingModules = new Set<string>()
          for (const diagnostic of diagnostics) {
            const message = diagnostic.message ?? ''
            const target = message.match(/to add it: go get (\S+)/)?.[1]
              ?? message.match(/: go get (\S+)$/)?.[1]
              ?? message.match(/no required module provides package "?([^\s":]+)"?/)?.[1]
            if (target) missingModules.add(target)
          }
          for (const target of missingModules) {
            mapped.push({
              title: `go get ${target}`,
              kind: 'quickfix',
              isPreferred: true,
              command: { id: this.ensureGoGetCommand(), title: `go get ${target}`, arguments: [target] },
            })
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
      const legendTypes = [...this.semanticLegend.tokenTypes, 'qualifiedCall', 'receiver']
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
            return tokens ? { resultId: tokens.resultId, data: this.annotateCallSites(Uint32Array.from(tokens.data), model) } : null
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
    private annotateCallSites(data: Uint32Array, model: Monaco.editor.ITextModel): Uint32Array {
      const legendTypes = this.semanticLegend?.tokenTypes
      if (!legendTypes?.length) return data
      const namespaceIdx = legendTypes.indexOf('namespace')
      const functionIdx = legendTypes.indexOf('function')
      const parameterIdx = legendTypes.indexOf('parameter')
      const variableIdx = legendTypes.indexOf('variable')
      const defModIdx = this.semanticLegend?.tokenModifiers
        ? this.semanticLegend.tokenModifiers.indexOf('definition')
        : -1
      const qualifiedIdx = legendTypes.length // 'qualifiedCall' appended by getLegend
      const receiverIdx = qualifiedIdx + 1
      const lines = model.getLinesContent()
      const receiverByLine: Array<string | undefined> = Array(lines.length)
      for (const declaration of goSourceDeclarations(model.getValue())) {
        if (!declaration.receiver) continue
        const start = declaration.startLine - 1
        const receiver = /^[ \t]*func[ \t]*\([ \t]*([A-Za-z_]\w*)[ \t]+/.exec(lines[start])?.[1]
        if (!receiver) continue
        for (let index = start; index < declaration.endLine && index < lines.length; index += 1) {
          receiverByLine[index] = receiver
        }
      }
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
        if (typeIdx === functionIdx && !isDeclaration && qualified && namespaceIdx >= 0) {
          out[i + 3] = qualifiedIdx
        } else if ((typeIdx === parameterIdx || typeIdx === variableIdx) &&
          receiverByLine[line] && lines[line]?.slice(char, char + len) === receiverByLine[line]) {
          // gopls labels method receivers as parameters or variables depending
          // on version. Color the receiver at its declaration and use sites.
          out[i + 3] = receiverIdx
        }
        prevType = typeIdx
        prevLine = line
        prevEnd = char + len
      }
      return out
    }

  /** Run a selected cross-file lightbulb edit through the checked transaction. */
  private ensureWorkspaceEditCommand(): string {
    if (this.workspaceEditCommandId) return this.workspaceEditCommandId
    const id = `mgland.gopls.workspaceEdit.${this.nextId}`
    this.workspaceEditCommandId = id
    this.disposables.push(this.monaco.editor.registerCommand(id, (
      _accessor,
      changes: Record<string, LspTextEdit[]>,
      sourceUri: string,
      sourceVersion: number,
      documentVersions: Map<string, number>,
      serverCommand?: LspCodeAction['command'],
    ) => {
      const validate = () => {
        const source = this.monaco.editor.getModel(this.monaco.Uri.parse(sourceUri))
        if (!source || source.isDisposed() || source.getVersionId() !== sourceVersion) {
          throw new Error('Source file changed while the code action was open; retry the action')
        }
        for (const uri of Object.keys(changes)) {
          if (documentVersions.get(uri) !== this.documents.get(uri)?.version) {
            throw new Error('A file changed while the code action was open; retry the action')
          }
        }
      }
      validate()
      if (!this.onWorkspaceEdit) throw new Error('Workspace edits are not ready')
      return this.onWorkspaceEdit(changes, { validate }).then(async () => {
        if (serverCommand) {
          await this.request('workspace/executeCommand', {
            command: serverCommand.command,
            arguments: serverCommand.arguments ?? [],
          })
        }
      })
    }))
    return id
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

  /** Editor command backing the synthesized "go get" quick fix for BrokenImport. */
  private ensureGoGetCommand(): string {
    if (this.goGetCommandId) return this.goGetCommandId
    const id = `mgland.go.get.${this.nextId}`
    this.goGetCommandId = id
    this.disposables.push(this.monaco.editor.registerCommand(id, (_accessor, module: unknown) => {
      if (typeof module === 'string' && module) this.onMissingModule?.(module)
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
  setConfig(settings: { staticcheck?: boolean; gofumpt?: boolean; localPrefix?: string }): void {
    // gopls uses the `local` setting (the goimports -local flag), whose value
    // is a comma-separated list of import path prefixes.
    const prefixes = (settings.localPrefix ?? '').split(/[,\s]+/).filter(Boolean)
    this.goplsSettings = {
      staticcheck: settings.staticcheck,
      gofumpt: settings.gofumpt,
      local: prefixes.join(','),
    }
    this.settingsRevision += 1
    if (this.ready) {
      void this.notify('workspace/didChangeConfiguration', { settings: { gopls: this.goplsSettingsPayload() } }).catch(() => undefined)
    }
  }

  /** Tell gopls that go.mod / go.sum / .go files changed outside the editor, so a terminal `go get` clears stale BrokenImport markers. */
  async changedWatchedFiles(paths: string[]): Promise<void> {
    if (!this.ready || !paths.length) return
    await this.notify('workspace/didChangeWatchedFiles', {
      changes: paths.map((path) => ({ uri: fileUri(normalizePath(path)), type: 2 })),
    })
  }

  /** gopls settings with GoLand-aligned defaults: lint checks on, strict style off. */
  private goplsSettingsPayload(): Record<string, unknown> {
    return {
      semanticTokens: true,
      staticcheck: this.goplsSettings.staticcheck ?? true,
      gofumpt: this.goplsSettings.gofumpt ?? false,
      local: this.goplsSettings.local ?? '',
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

  /**
   * Code actions at a position, optionally restricted to kinds such as
   * `refactor.extract.variable`. Powers the Refactor menu and the
   * run-intention popup; empty when gopls offers nothing there.
   */
  async codeActionsAtCursor(path: string, line: number, column: number, only?: string[], endLine?: number, endColumn?: number): Promise<LspCodeAction[]> {
    await this.start()
    const uri = fileUri(path)
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
    const sourceVersion = model?.getVersionId() ?? null
    if (model) await this.syncModel(model)
    else if (this.documents.has(uri)) await this.changeDocument(path, this.documents.get(uri)!.text)
    if (this.stopped || (model && (model.isDisposed() || model.getVersionId() !== sourceVersion))) return []
    const documentVersions = new Map([...this.documents].map(([key, document]) => [key, document.version]))
    const diagnostics = (this.diagnostics.get(uri) ?? []).filter((diagnostic) =>
      diagnostic.range.start.line <= line - 1 && diagnostic.range.end.line >= line - 1)
    const actions = await this.request<LspCodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri },
      range: {
        start: { line: line - 1, character: column - 1 },
        end: { line: (endLine ?? line) - 1, character: (endColumn ?? column) - 1 },
      },
      context: { diagnostics, ...(only?.length ? { only } : {}) },
    })
    if (this.stopped || (model && (model.isDisposed() || model.getVersionId() !== sourceVersion))) return []
    // gopls marks unusable actions with `disabled: { reason }`; skip those.
    const usable = (actions ?? []).filter((action) => !(action as { disabled?: unknown }).disabled)
    for (const action of usable) this.codeActionSnapshots.set(action, { sourceUri: uri, sourceVersion, documentVersions })
    return usable
  }

  /**
   * AST node ranges enclosing each position, innermost first (gopls caps the
   * chain). gopls v0.24+ only offers extract refactorings for real ranges
   * that start on the expression, so the Refactor menu walks this chain when
   * the user has no selection.
   */
  async selectionRanges(path: string, line: number, column: number, maxDepth = 6): Promise<Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>> {
    await this.start()
    const uri = fileUri(path)
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri))
    if (model) await this.syncModel(model)
    else if (this.documents.has(uri)) await this.changeDocument(path, this.documents.get(uri)!.text)
    if (this.stopped) return []
    const response = await this.request<Array<{ range: LspRange; parent?: unknown }> | null>('textDocument/selectionRange', {
      textDocument: { uri },
      positions: [{ line: line - 1, character: column - 1 }],
    })
    const ranges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }> = []
    let node = response?.[0]
    while (node && ranges.length < maxDepth) {
      ranges.push(node.range)
      node = (node as { parent?: { range: LspRange } }).parent
    }
    return ranges
  }

  /**
   * Apply a code action returned by codeActionsAtCursor: workspace edits go
   * through the workspace-edit callback (open tabs in place, closed files on
   * disk); command actions run as gopls server commands.
   */
  async applyCodeAction(input: LspCodeAction): Promise<void> {
    // gopls serves extract refactors lazily: the codeAction carries only `data`
    // (resolveSupport is declared in initialize) and the edit arrives from
    // codeAction/resolve.
    const snapshot = this.codeActionSnapshots.get(input)
    const validateSource = () => {
      if (!snapshot || snapshot.sourceVersion === null) return
      const source = this.monaco.editor.getModel(this.monaco.Uri.parse(snapshot.sourceUri))
      if (!source || source.isDisposed() || source.getVersionId() !== snapshot.sourceVersion) {
        throw new Error('Source file changed while the code action was open; retry the action')
      }
    }
    validateSource()
    let action = input
    if (!action.edit && !action.command && action.data) {
      action = await this.request<LspCodeAction>('codeAction/resolve', action, 10000)
    }
    validateSource()
    if (action.edit) {
      const changes = workspaceEditChanges(action.edit)
      const validate = () => {
        validateSource()
        for (const uri of Object.keys(changes)) {
          if (snapshot && snapshot.documentVersions.get(uri) !== this.documents.get(uri)?.version) {
            throw new Error('A file changed while the code action was open; retry the action')
          }
        }
        for (const change of action.edit?.documentChanges ?? []) {
          const uri = change.textDocument?.uri
          const version = change.textDocument?.version
          if (uri && version != null && version !== this.documents.get(uri)?.version) {
            throw new Error('A file changed while the code action was open; retry the action')
          }
        }
      }
      validate()
      if (Object.keys(changes).length) {
        if (!this.onWorkspaceEdit) throw new Error('Workspace edits are not ready')
        await this.onWorkspaceEdit(changes, { validate })
      }
    }
    if (action.command) {
      await this.request('workspace/executeCommand', {
        command: action.command.command,
        arguments: action.command.arguments ?? [],
      }, 15000)
    }
  }

  /** Find Usages tool window data: references plus the declaration itself. */
  async findUsages(path: string, line: number, column: number): Promise<Array<{ path: string; line: number; column: number }>> {
    await this.start()
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(fileUri(path)))
    if (model) await this.syncModel(model)
    if (this.stopped) return []
    const result = await this.request<unknown>('textDocument/references', {
      textDocument: { uri: fileUri(path) },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    })
    return locations(result).map((location) => ({
      path: uriToPath(location.uri),
      line: location.range.start.line + 1,
      column: location.range.start.character + 1,
    }))
  }

  /** Go to Implementation (⌥⌘B): gopls resolves interface methods to implementations. */
  async goToImplementation(path: string, line: number, column: number): Promise<DefinitionTarget | null> {
    await this.start()
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(fileUri(path)))
    if (model) await this.syncModel(model)
    if (this.stopped) return null
    const result = await this.request<unknown>('textDocument/implementation', {
      textDocument: { uri: fileUri(path) },
      position: { line: line - 1, character: column - 1 },
    })
    const first = locations(result)[0]
    return first
      ? { path: uriToPath(first.uri), line: first.range.start.line + 1, column: first.range.start.character + 1 }
      : null
  }

  /**
   * Hierarchical document symbols for the Structure tool window. Accepts the
   * current buffer text so an unsaved edit still outlines correctly.
   */
  async documentSymbols(path: string, text: string): Promise<StructureSymbol[] | null> {
    await this.start()
    if (this.stopped) return null
    await this.changeDocument(path, text)
    const uri = fileUri(path)
    const symbols = await this.request<LspDocumentSymbol[] | null>('textDocument/documentSymbol', {
      textDocument: { uri },
    })
    if (this.stopped) return null
    const flatten = (items: LspDocumentSymbol[] | undefined, container: string, depth: number): StructureSymbol[] =>
      (items ?? []).flatMap((symbol) => [
        {
          name: symbol.name,
          kind: this.symbolKindName(symbol.kind),
          detail: symbol.detail ?? '',
          container,
          depth,
          line: symbol.selectionRange.start.line + 1,
          column: symbol.selectionRange.start.character + 1,
        },
        ...flatten(symbol.children, symbol.name, depth + 1),
      ])
    // SymbolInformation (flat) still arrives for some servers; handle both shapes.
    const first = (symbols as unknown[] | null)?.[0]
    if (first && 'location' in (first as Record<string, unknown>)) {
      return (symbols as unknown as LspSymbolInformation[]).map((symbol) => ({
        name: symbol.name,
        kind: this.symbolKindName(symbol.kind),
        detail: '',
        container: symbol.containerName ?? '',
        depth: 0,
        line: symbol.location.range.start.line + 1,
        column: symbol.location.range.start.character + 1,
      }))
    }
    return flatten((symbols as LspDocumentSymbol[] | null) ?? [], '', 0)
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
    // gopls republishes the full diagnostics list after every didChange; on a
    // large file that would rebuild all squiggle decorations per keystroke even
    // when nothing changed for this document.
    const signature = JSON.stringify(markers)
    if (this.lastMarkers.get(uri) === signature) return
    this.lastMarkers.set(uri, signature)
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
        result = params?.items?.map((item) => item.section === 'gopls' ? this.goplsSettingsPayload() : null) ?? []
        break
      }
      case 'workspace/workspaceFolders':
        result = [{ uri: fileUri(this.root), name: this.root.split('/').pop() || this.root }]
        break
      case 'workspace/applyEdit': {
        const params = message.params as { edit?: LspWorkspaceEdit } | undefined
        try {
          const changes = params?.edit ? workspaceEditChanges(params.edit) : {}
          if (this.onWorkspaceEdit && Object.keys(changes).length) {
            const documentVersions = new Map([...this.documents].map(([uri, document]) => [uri, document.version]))
            const validate = () => {
              for (const uri of Object.keys(changes)) {
                if (documentVersions.get(uri) !== this.documents.get(uri)?.version) {
                  throw new Error('A file changed while the workspace edit was running')
                }
              }
              for (const change of params?.edit?.documentChanges ?? []) {
                const uri = change.textDocument?.uri
                const version = change.textDocument?.version
                if (uri && version != null && version !== this.documents.get(uri)?.version) {
                  throw new Error('A file changed while the workspace edit was running')
                }
              }
            }
            validate()
            await this.onWorkspaceEdit(changes, { validate })
            result = { applied: true }
          } else {
            result = { applied: false, failureReason: 'No workspace edit handler' }
          }
        } catch (error) {
          result = {
            applied: false,
            failureReason: error instanceof Error ? error.message : String(error),
          }
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
