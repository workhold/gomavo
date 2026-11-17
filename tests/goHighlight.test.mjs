import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { compile } from 'monaco-editor/editor/standalone/common/monarch/monarchCompile'
import { MonarchTokenizer } from 'monaco-editor/editor/standalone/common/monarch/monarchLexer'
import { goTodoMarkerRanges, installGoSyntaxFallback } from '../src/lib/goHighlight.ts'
import { defineMglandTheme } from '../src/lib/monacoTheme.ts'

function fallbackTokens(lines) {
  let definition
  installGoSyntaxFallback({ languages: { setMonarchTokensProvider(_id, value) { definition = value } } })
  const tokenizer = new MonarchTokenizer({}, {}, 'go', compile('go', definition), {
    getValue() { return 10_000 },
    onDidChangeConfiguration() { return { dispose() {} } },
  })
  const rows = []
  try {
    let state = tokenizer.getInitialState()
    for (const line of lines) {
      const result = tokenizer.tokenize(line, true, state)
      rows.push(result.tokens)
      state = result.endState
    }
  } finally { tokenizer.dispose() }
  return rows
}

function tokenAt(tokens, column) {
  return tokens.findLast((token) => token.offset <= column)?.type
}

test('Go fallback colors const declarations and TODO markers without gopls', () => {
  const lines = ['const Count = 1', 'const (', '  max = Count', '  Min int = max', ')', '// todo: revisit', 'func (g *Graph) push() {}']
  const rows = fallbackTokens(lines)
  assert.equal(tokenAt(rows[0], 0), 'keyword.const.go')
  assert.equal(tokenAt(rows[0], 6), 'variable.readonly.go')
  assert.equal(tokenAt(rows[2], 2), 'variable.readonly.go')
  assert.equal(tokenAt(rows[3], 2), 'variable.readonly.go')
  assert.equal(tokenAt(rows[5], 3), 'comment.todo.go')
  assert.equal(tokenAt(rows[6], 6), 'receiver.go')

  const themes = new Map()
  defineMglandTheme({ editor: { defineTheme(name, theme) { themes.set(name, theme) } } })
  const dark = themes.get('mgland-dark')
  assert.equal(dark.rules.find((rule) => rule.token === 'keyword.const').foreground, 'C792EA')
  assert.equal(dark.rules.find((rule) => rule.token === 'variable.readonly').foreground, 'C792EA')
  assert.equal(dark.rules.find((rule) => rule.token === 'comment.todo').foreground, 'F2C45D')
  assert.equal(dark.rules.find((rule) => rule.token === 'receiver').foreground, '7AB8FF')
})

test('Go fallback highlights TODO markers inside single and multiline block comments', () => {
  const lines = [
    '/* TODO: first */',
    '/* a block',
    ' * todo and FIXME',
    ' * closing */',
    '/**',
    ' * HACK: docs',
    ' */',
    'const outside = "TODO in a string"',
  ]
  const rows = fallbackTokens(lines)
  assert.equal(tokenAt(rows[0], lines[0].indexOf('TODO')), 'comment.todo.go')
  assert.equal(tokenAt(rows[2], lines[2].indexOf('todo')), 'comment.todo.go')
  assert.equal(tokenAt(rows[2], lines[2].indexOf('FIXME')), 'comment.todo.go')
  assert.equal(tokenAt(rows[5], lines[5].indexOf('HACK')), 'comment.todo.go')
  assert.equal(tokenAt(rows[7], lines[7].indexOf('TODO')), 'string.go')
  const ranges = goTodoMarkerRanges(lines.join('\n'), rows)
  assert.deepEqual(ranges.map(({ lineNumber, startColumn, endColumn }) => [
    lineNumber, lines[lineNumber - 1].slice(startColumn - 1, endColumn - 1),
  ]), [[1, 'TODO'], [3, 'todo'], [3, 'FIXME'], [6, 'HACK']])
})

function encodeTokens(entries) {
  const data = []
  let previousLine = 0
  let previousColumn = 0
  for (const { line, column, length, type, modifiers = 0 } of entries) {
    const lineDelta = line - previousLine
    data.push(lineDelta, lineDelta ? column : column - previousColumn, length, type, modifiers)
    previousLine = line
    previousColumn = column
  }
  return Uint32Array.from(data)
}

test('receiver color ends with its method body', async () => {
  const testsDir = dirname(fileURLToPath(import.meta.url))
  const temporary = await mkdtemp(join(testsDir, '.semantic-color-'))
  try {
    const outfile = join(temporary, 'client.mjs')
    await build({ entryPoints: [join(testsDir, '../src/lib/lsp/client.ts')], bundle: true, platform: 'node', format: 'esm', outfile, packages: 'external' })
    const { GoplsClient } = await import(pathToFileURL(outfile).href)
    const client = new GoplsClient('/project', {})
    client.semanticLegend = { tokenTypes: ['namespace', 'function', 'parameter', 'variable'], tokenModifiers: ['definition'] }

    for (const declaration of ['var', 'const']) {
      const lines = [
        'package sample',
        'type Graph struct{}',
        'func (g *Graph) push() {',
        '  _ = g',
        '}',
        `${declaration} g = 1`,
      ]
      const entries = [
        { line: 2, column: lines[2].indexOf('(g') + 1, length: 1, type: 2, modifiers: 1 },
        { line: 3, column: lines[3].lastIndexOf('g'), length: 1, type: 3 },
        { line: 5, column: lines[5].indexOf('g'), length: 1, type: 3, modifiers: 1 },
      ]
      const result = client.annotateCallSites(encodeTokens(entries), {
        getLinesContent() { return lines },
        getValue() { return lines.join('\n') },
      })
      const receiverType = client.semanticLegend.tokenTypes.length + 1
      assert.equal(result[3], receiverType)
      assert.equal(result[8], receiverType)
      assert.equal(result[13], 3, `${declaration} g after the method keeps its original token type`)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
