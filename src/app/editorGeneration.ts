import type * as Monaco from 'monaco-editor'

export function insertGenerated(editor: Monaco.editor.IStandaloneCodeEditor, generator: (source: string) => { content: string; insertLine: number } | null): void {
  const model = editor.getModel()
  if (!model) return
  const generated = generator(model.getValue())
  if (!generated) return
  const line = Math.min(Math.max(generated.insertLine, 1), model.getLineCount() + 1)
  editor.executeEdits('gomavo.generate', [{
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    text: generated.content,
    forceMoveMarkers: true,
  }])
  editor.revealLineInCenter(line)
  editor.focus()
}

/** Full-document scans (declaration parsing) only re-run once typing settles.
 *  A changed key (tab switch) bypasses the delay so stale content never pairs
 *  with a new file's path. */
