import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAnsiLine, findOutputReferences, resolveOutputReference } from '../src/lib/outputParsing.ts'

test('parseAnsiLine splits SGR colors into spans and resets on 0', () => {
  const spans = parseAnsiLine('\u001b[31mfail\u001b[0m plain \u001b[1;32mbold green\u001b[0m')
  assert.deepEqual(spans, [
    { text: 'fail', className: 'ansi-red' },
    { text: ' plain ', className: undefined },
    { text: 'bold green', className: 'ansi-green ansi-bold' },
  ])
  const plain = parseAnsiLine('no escapes')
  assert.deepEqual(plain, [{ text: 'no escapes', className: undefined }])
  const truncated = parseAnsiLine('stray \u001b[3')
  assert.equal(truncated[0].text, 'stray \u001b[3')
})

test('findOutputReferences matches go-style file:line:col references', () => {
  const references = findOutputReferences('handler_test.go:42:9: expected failure')
  assert.equal(references.length, 1)
  assert.equal(references[0].paths[0].path, 'handler_test.go')
  assert.equal(references[0].paths[0].line, 42)
  assert.equal(references[0].paths[0].column, 9)
  const nested = findOutputReferences('internal/pkg/util.go:7 boom')
  assert.equal(nested[0].paths[0].path, 'internal/pkg/util.go')
  const none = findOutputReferences('no references here: 12')
  assert.equal(none.length, 0)
})

test('resolveOutputReference prefers unique suffix matches', () => {
  const root = '/work/app'
  const files = ['/work/app/main.go', '/work/app/pkg/main.go', '/work/app/util/util.go']
  assert.equal(resolveOutputReference({ text: 'main.go', paths: [{ path: 'main.go', line: 1 }] }, root, files), '/work/app/main.go')
  assert.equal(resolveOutputReference({ text: 'util.go', paths: [{ path: 'util.go', line: 3 }] }, root, files), '/work/app/util/util.go')
  assert.equal(resolveOutputReference({ text: 'missing.go', paths: [{ path: 'missing.go', line: 1 }] }, root, files), null)
  assert.equal(
    resolveOutputReference({ text: '/work/app/main.go', paths: [{ path: '/work/app/main.go', line: 2 }] }, root, files),
    '/work/app/main.go',
  )
})
