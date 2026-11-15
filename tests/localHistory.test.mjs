import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalUnifiedDiff, LocalEditHistory } from '../src/lib/localHistory.ts'

test('groups nearby typing but preserves undo and redo as separate revisions', () => {
  const history = new LocalEditHistory()
  history.ensureFile('/repo/main.go', 'package main\n', 100)
  history.record('/repo/main.go', 'package main\n', 'package main\na', {
    changes: [{ range: { startLineNumber: 2 }, rangeLength: 0, text: 'a' }],
  }, 200)
  history.record('/repo/main.go', 'package main\na', 'package main\nab', {
    changes: [{ range: { startLineNumber: 2 }, rangeLength: 0, text: 'b' }],
  }, 300)
  history.record('/repo/main.go', 'package main\nab', 'package main\n', { isUndoing: true }, 400)
  history.record('/repo/main.go', 'package main\n', 'package main\nab', { isRedoing: true }, 500)

  const entries = history.getEntries('/repo/main.go')
  assert.deepEqual(entries.map((entry) => entry.kind), ['redo', 'undo', 'edit'])
  assert.equal(entries[2].before, 'package main\n')
  assert.equal(entries[2].after, 'package main\nab')
  assert.equal(entries[2].changeCount, 2)
})

test('retains saved edits after reopening, then recognizes disk changes', () => {
  const history = new LocalEditHistory()
  history.ensureFile('/repo/go.mod', 'module a\n', 100)
  history.record('/repo/go.mod', 'module a\n', 'module b\n', undefined, 200)
  history.ensureFile('/repo/go.mod', 'module b\n', 300)
  assert.equal(history.getEntries('/repo/go.mod').length, 1)
  history.ensureFile('/repo/go.mod', 'module c\n', 400)
  assert.deepEqual(history.getEntries('/repo/go.mod').map((entry) => entry.kind), ['external', 'edit'])
})

test('local diffs show changed lines with correct hunk coordinates', () => {
  const diff = createLocalUnifiedDiff('first\nsecond\nthird\n', 'first\nchanged\nthird\n', 'go.mod')
  assert.match(diff, /@@ -1,3 \+1,3 @@/)
  assert.match(diff, /-second\n\+changed/)
})
