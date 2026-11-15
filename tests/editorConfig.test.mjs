import assert from 'node:assert/strict'
import test from 'node:test'
import { applyEditorConfigToContent, editorConfigIndentOptions, resolveEditorConfig } from '../src/lib/editorConfig.ts'

function configReader(configs) {
  const reads = []
  return {
    reads,
    read: async (path) => {
      reads.push(path)
      return configs[path] ?? null
    },
  }
}

test('merges matching sections and nested configs, stopping at root=true', async () => {
  const source = configReader({
    '/repo/.editorconfig': [
      'root = true',
      '[*]',
      'indent_style = space',
      'indent_size = 4',
      'end_of_line = lf',
      '[*.go]',
      'indent_style = tab',
      'trim_trailing_whitespace = true',
      '[docs/*.go]',
      'indent_size = 7',
    ].join('\n'),
    '/repo/docs/.editorconfig': [
      '[*.go]',
      'indent_style = space',
      'indent_size = 2',
      'end_of_line = unset',
      'insert_final_newline = true',
    ].join('\n'),
  })
  const settings = await resolveEditorConfig('/repo', '/repo/docs/demo.go', source.read)
  assert.deepEqual(settings, {
    indentStyle: 'space', indentSize: 2, trimTrailingWhitespace: true, insertFinalNewline: true,
  })
  assert.deepEqual(source.reads, ['/repo/docs/.editorconfig', '/repo/.editorconfig'])
})

test('matches basename at any depth, relative paths and brace/globstar patterns', async () => {
  const source = configReader({
    '/repo/.editorconfig': [
      'root = true',
      '[*.go]',
      'indent_size = 3',
      '[internal/*.go]',
      'indent_size = 4',
      '[**/{foo,bar}.go]',
      'tab_width = 8',
      '[file{1..3}.go]',
      'end_of_line = crlf',
      '[file?.go]',
      'insert_final_newline = false',
    ].join('\n'),
  })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repo/internal/foo.go', source.read), { indentSize: 4, tabWidth: 8 })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repo/elsewhere/bar.go', source.read), { indentSize: 3, tabWidth: 8 })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repo/file2.go', source.read), { indentSize: 3, endOfLine: 'crlf', insertFinalNewline: false })
})

test('ignores invalid values and outside-workspace paths', async () => {
  const source = configReader({
    '/repo/.editorconfig': '[*.go]\nindent_size = 4\nindent_style = tab',
    '/repo/child/.editorconfig': '[*.go]\nindent_size = -2\nindent_style = false\ntab_width = 0',
  })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repo/child/a.go', source.read), { indentSize: 4, indentStyle: 'tab' })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repository/a.go', source.read), {})
})

test('honors a nested root and leaves unspecified settings to editor defaults', async () => {
  const source = configReader({
    '/repo/.editorconfig': '[*.go]\nindent_style = space\nindent_size = 2',
    '/repo/child/.editorconfig': 'root = TRUE\n[*.go]\ntab_width = 6',
  })
  assert.deepEqual(await resolveEditorConfig('/repo', '/repo/child/a.go', source.read), { tabWidth: 6 })
  assert.deepEqual(source.reads, ['/repo/child/.editorconfig'])
  assert.deepEqual(editorConfigIndentOptions({ tabWidth: 6 }, { tabSize: 4, insertSpaces: false }), {
    tabSize: 6, indentSize: 'tabSize', insertSpaces: false,
  })
})

test('maps tab width and indent size independently for Monaco', () => {
  const defaults = { tabSize: 4, insertSpaces: false }
  assert.deepEqual(editorConfigIndentOptions({ indentStyle: 'tab', indentSize: 4, tabWidth: 3 }, defaults), {
    tabSize: 3, indentSize: 4, insertSpaces: false,
  })
  assert.deepEqual(editorConfigIndentOptions({ indentStyle: 'space', indentSize: 'tab', tabWidth: 2 }, defaults), {
    tabSize: 2, indentSize: 'tabSize', insertSpaces: true,
  })
})

test('applies save-time whitespace, line ending and final newline rules', () => {
  assert.equal(applyEditorConfigToContent('one  \r\ntwo\t\nthree', {
    trimTrailingWhitespace: true, endOfLine: 'lf', insertFinalNewline: true,
  }), 'one\ntwo\nthree\n')
  assert.equal(applyEditorConfigToContent('one\n\n', { endOfLine: 'crlf', insertFinalNewline: false }), 'one')
  assert.equal(applyEditorConfigToContent('', { insertFinalNewline: true }), '')
  assert.equal(applyEditorConfigToContent('keep  ', { trimTrailingWhitespace: false }), 'keep  ')
})
