import type { LspTextEdit, LspWorkspaceEdit } from './protocol'

/** Normalize text edits, rejecting file operations this editor cannot apply. */
export function workspaceEditChanges(edit: LspWorkspaceEdit): Record<string, LspTextEdit[]> {
  const changes: Record<string, LspTextEdit[]> = {}
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (!Array.isArray(edits)) throw new Error(`Unsupported workspace edit for ${uri}`)
    changes[uri] = changes[uri] ? [...changes[uri], ...edits] : [...edits]
  }
  for (const change of edit.documentChanges ?? []) {
    if ('kind' in change) throw new Error('Unsupported workspace file operation')
    const uri = change.textDocument?.uri
    const edits = change.edits
    // LSP also permits create/rename/delete file operations here. Ignoring
    // one would apply only part of a refactor and leave the project broken.
    if (!uri || !Array.isArray(edits)) throw new Error('Unsupported workspace file operation')
    const current = changes[uri] ?? []
    changes[uri] = [...current, ...edits]
  }
  return changes
}
