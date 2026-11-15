import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUnifiedDiff } from '../src/lib/unifiedDiff.ts'

test('parses Git headers and line numbers across hunks', () => {
  const lines = parseUnifiedDiff([
    'diff --git a/main.go b/main.go',
    'index 1111111..2222222 100644',
    '--- a/main.go',
    '+++ b/main.go',
    '@@ -2,3 +2,4 @@ func main() {',
    ' context',
    '-old',
    '+new',
    '+extra',
    ' unchanged',
    '@@ -20 +21 @@',
    '-last',
    '+latest',
    '\\ No newline at end of file',
  ].join('\n'))

  assert.deepEqual(lines.map((line) => line.kind), [
    'file', 'meta', 'meta', 'meta', 'hunk',
    'context', 'deletion', 'addition', 'addition', 'context',
    'hunk', 'deletion', 'addition', 'marker',
  ])
  assert.deepEqual(lines.slice(5, 10).map((line) => [line.oldLine, line.newLine]), [
    [2, 2], [3, null], [null, 3], [null, 4], [4, 5],
  ])
  assert.deepEqual(lines.slice(11, 13).map((line) => [line.oldLine, line.newLine]), [[20, null], [null, 21]])
})

test('resets line numbering for each file and leaves arbitrary content as plain text', () => {
  const lines = parseUnifiedDiff([
    'diff --git a/a.txt b/a.txt',
    '@@ -0,0 +1 @@',
    '+<script>alert(1)</script>',
    'diff --git a/b.txt b/b.txt',
    '@@ -7 +0,0 @@',
    '-removed',
  ].join('\n'))

  assert.deepEqual(lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['file', null, null], ['hunk', null, null], ['addition', null, 1],
    ['file', null, null], ['hunk', null, null], ['deletion', 7, null],
  ])
  assert.equal(lines[2].text, '+<script>alert(1)</script>')
})

test('distinguishes file markers from changed lines beginning with marker text', () => {
  const lines = parseUnifiedDiff([
    '--- a/file',
    '+++ b/file',
    '@@ -1 +1 @@',
    '--- deleted text',
    '+++ inserted text',
  ].join('\n'))
  assert.deepEqual(lines.map((line) => line.kind), ['meta', 'meta', 'hunk', 'deletion', 'addition'])
  assert.deepEqual(lines.slice(3).map((line) => [line.oldLine, line.newLine]), [[1, null], [null, 1]])
})
