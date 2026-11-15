import type * as Monaco from 'monaco-editor'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange: LspRange
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: string | number
  source?: string
  message: string
  tags?: number[]
}

export interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string }
  kind?: number
  detail?: string
  documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
  sortText?: string
  filterText?: string
  insertText?: string
  textEditText?: string
  insertTextFormat?: number
  textEdit?:
    | { range: LspRange; newText: string }
    | { insert: LspRange; replace: LspRange; newText: string }
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>
  commitCharacters?: string[]
  preselect?: boolean
}

export interface LspCompletionDefaults {
  editRange?: LspRange | { insert: LspRange; replace: LspRange }
  insertTextFormat?: number
  commitCharacters?: string[]
}

export interface LspCompletionList {
  items: LspCompletionItem[]
  isIncomplete?: boolean
  itemDefaults?: LspCompletionDefaults
}

export interface LspSemanticTokens {
  resultId?: string
  data: number[]
}

export interface LspSemanticTokensCapability {
  legend: Monaco.languages.SemanticTokensLegend
  full?: boolean | { delta?: boolean }
}

export interface LspHover {
  contents:
    | string
    | { language: string; value: string }
    | { kind: 'markdown' | 'plaintext'; value: string }
    | Array<string | { language: string; value: string } | { kind: 'markdown' | 'plaintext'; value: string }>
  range?: LspRange
}

export interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface LspEvent {
  root: string
  message: RpcMessage | RpcMessage[] | string
}

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface OpenDocument {
  text: string
  version: number
}

export interface LspCommand {
  title: string
  command: string
  arguments?: unknown[]
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: Array<{
    textDocument?: { uri: string; version?: number }
    edits?: LspTextEdit[]
  }>
}

export interface LspCodeAction {
  title: string
  kind?: string
  diagnostics?: LspDiagnostic[]
  isPreferred?: boolean
  edit?: LspWorkspaceEdit
  command?: LspCommand
}

export interface LspSignatureInformation {
  label: string
  documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
  parameters?: Array<{
    label: string | [number, number]
    documentation?: string | { kind: 'markdown' | 'plaintext'; value: string }
  }>
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[]
  activeSignature?: number
  activeParameter?: number
}

export interface LspInlayHint {
  position: LspPosition
  label: string | Array<{ value: string; location?: LspLocation }>
  tooltip?: string | { kind: 'markdown' | 'plaintext'; value: string }
  textEdits?: LspTextEdit[]
}

export interface LspDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export interface LspSymbolInformation {
  name: string
  kind: number
  location: LspLocation
  containerName?: string
}
