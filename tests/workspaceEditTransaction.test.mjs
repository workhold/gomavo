import assert from 'node:assert/strict'
import test from 'node:test'
import { commitWorkspaceFileWrites } from '../src/lib/lsp/workspaceEditTransaction.ts'

function memoryIO(initial, failWrite = () => false) {
  const files = new Map(Object.entries(initial))
  const io = {
    async read(path) {
      if (!files.has(path)) throw new Error('missing file')
      return files.get(path)
    },
    async write(path, content, expectedContent) {
      if (files.get(path) !== expectedContent) throw new Error('save conflict')
      if (failWrite(path, content)) throw new Error('write failed')
      files.set(path, content)
    },
    async create(path, content) {
      if (files.has(path)) throw new Error('already exists')
      files.set(path, content)
    },
    async remove(path) {
      files.delete(path)
    },
  }
  return { files, io }
}

test('a failed second rename write restores the first file and skips editor updates', async () => {
  const { files, io } = memoryIO({ 'a.go': 'old a', 'b.go': 'old b' }, (path, content) => path === 'b.go' && content === 'new b')
  let editorUpdated = false
  await assert.rejects(
    commitWorkspaceFileWrites([
      { path: 'a.go', before: 'old a', after: 'new a' },
      { path: 'b.go', before: 'old b', after: 'new b' },
    ], io, () => {}, () => { editorUpdated = true }),
    /b\.go: write failed/,
  )
  assert.deepEqual(Object.fromEntries(files), { 'a.go': 'old a', 'b.go': 'old b' })
  assert.equal(editorUpdated, false)
})

test('source model invalidation after a write restores external files', async () => {
  const { files, io } = memoryIO({ 'a.go': 'old a', 'b.go': 'old b' })
  let valid = true
  const originalWrite = io.write
  io.write = async (...args) => {
    await originalWrite(...args)
    if (args[0] === 'a.go' && args[1] === 'new a') valid = false
  }
  await assert.rejects(
    commitWorkspaceFileWrites([
      { path: 'a.go', before: 'old a', after: 'new a' },
      { path: 'b.go', before: 'old b', after: 'new b' },
    ], io, () => { if (!valid) throw new Error('source model changed') }, () => {}),
    /source model changed/,
  )
  assert.deepEqual(Object.fromEntries(files), { 'a.go': 'old a', 'b.go': 'old b' })
})

test('a newly created file is removed when a later commit fails', async () => {
  const { files, io } = memoryIO({ 'b.go': 'old b' }, (path, content) => path === 'b.go' && content === 'new b')
  await assert.rejects(
    commitWorkspaceFileWrites([
      { path: 'new_test.go', before: null, after: 'package main' },
      { path: 'b.go', before: 'old b', after: 'new b' },
    ], io, () => {}, () => {}),
    /b\.go: write failed/,
  )
  assert.deepEqual(Object.fromEntries(files), { 'b.go': 'old b' })
})

test('rollback preserves a concurrently changed file and reports the conflict', async () => {
  const { files, io } = memoryIO({ 'a.go': 'old a' })
  await assert.rejects(
    commitWorkspaceFileWrites([
      { path: 'a.go', before: 'old a', after: 'new a' },
    ], io, () => {}, () => {
      files.set('a.go', 'newer content')
      throw new Error('editor update failed')
    }),
    /rollback failed for a\.go: save conflict/,
  )
  assert.equal(files.get('a.go'), 'newer content')
})
