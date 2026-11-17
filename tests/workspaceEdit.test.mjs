import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceEditChanges } from '../src/lib/lsp/workspaceEdit.ts'

const edit = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  newText: 'new',
}

test('combines text edits from both workspace edit forms', () => {
  assert.deepEqual(workspaceEditChanges({
    changes: { 'file:///a.go': [edit] },
    documentChanges: [{ textDocument: { uri: 'file:///b.go' }, edits: [edit] }],
  }), { 'file:///a.go': [edit], 'file:///b.go': [edit] })
})

test('rejects file operations instead of applying only the text portion', () => {
  assert.throws(() => workspaceEditChanges({
    changes: { 'file:///a.go': [edit] },
    documentChanges: [{ kind: 'rename', oldUri: 'file:///b.go', newUri: 'file:///c.go' }],
  }), /Unsupported workspace file operation/)
})

test('rejects malformed text edit groups instead of omitting them', () => {
  assert.throws(() => workspaceEditChanges({ changes: { 'file:///a.go': null } }), /Unsupported workspace edit/)
})
