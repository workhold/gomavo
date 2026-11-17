import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMonacoContentChanges } from '../src/lib/lsp/contentSync.ts'

function change(rangeOffset, rangeLength, text) {
  return {
    rangeOffset, rangeLength, text,
    range: { startLineNumber: 1, startColumn: rangeOffset + 1, endLineNumber: 1, endColumn: rangeOffset + rangeLength + 1 },
  }
}

test('applies Monaco multi-cursor edits against their shared original text', () => {
  const before = 'alpha beta gamma'
  const changes = [change(6, 4, 'B'), change(0, 5, 'A')]
  assert.equal(applyMonacoContentChanges(before, changes), 'A B gamma')
})

test('detects an incremental edit based on a stale document', () => {
  const before = 'rg, ok := m[k]\nuse(rg)\n'
  const latest = `${before}println(rg)\n`
  const edit = change(before.length, 0, 'println(rg)\n')
  const stale = 'rg, ok := m[k]\n'
  assert.equal(applyMonacoContentChanges(stale, [edit]), null)
  assert.equal(applyMonacoContentChanges(before, [edit]), latest)
})

test('rejects overlapping and out-of-bounds ranges for full-text fallback', () => {
  assert.equal(applyMonacoContentChanges('abcdef', [change(1, 3, 'X'), change(2, 2, 'Y')]), null)
  assert.equal(applyMonacoContentChanges('abc', [change(4, 0, 'X')]), null)
})
