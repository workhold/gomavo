export { GoplsClient, applyTextEdits } from './client'
export type {
  DefinitionTarget, DiagnosticEntry, DiagnosticsCallback, OpenDefinitionCallback,
  StructureSymbol, WorkspaceEditCallback, WorkspaceEditOptions, WorkspaceSymbolEntry,
} from './client'
export type { LspTextEdit } from './protocol'
export { fileUri, uriToPath } from './uri'
