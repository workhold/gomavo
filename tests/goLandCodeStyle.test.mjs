import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGoLandCodeStyle } from '../src/lib/editorConfig.ts'

const PROJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<code_scheme name="Project" version="173">
  <codeStyleSettings language="Go">
    <option name="USE_TAB_CHARACTER" value="false" />
    <option name="INDENT_SIZE" value="4" />
    <option name="TAB_SIZE" value="4" />
    <option name="LINE_SEPARATOR" value="&#10;" />
  </codeStyleSettings>
</code_scheme>`

test('parses Go-specific code style block', () => {
  const settings = parseGoLandCodeStyle(PROJECT_XML)
  assert.deepEqual(settings, { indentStyle: 'space', indentSize: 4, tabWidth: 4, endOfLine: 'lf' })
})

test('falls back to global options and tab usage', () => {
  const xml = `<code_scheme name="Project" version="173">
    <option name="INDENT_SIZE" value="2" />
    <option name="USE_TAB_CHARACTER" value="true" />
  </code_scheme>`
  assert.deepEqual(parseGoLandCodeStyle(xml), { indentStyle: 'tab', indentSize: 2 })
})

test('ignores non-scheme files and invalid numbers', () => {
  assert.deepEqual(parseGoLandCodeStyle('<project version="4"><component name="ProjectRunConfigurationManager" /></project>'), {})
  const xml = `<code_scheme name="Project"><codeStyleSettings language="Go"><option name="INDENT_SIZE" value="abc" /></codeStyleSettings></code_scheme>`
  assert.deepEqual(parseGoLandCodeStyle(xml), {})
})
