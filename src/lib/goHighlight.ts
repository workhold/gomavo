import type * as Monaco from 'monaco-editor/editor/editor.api'
import { language as baseGo } from 'monaco-editor/languages/definitions/go/go'

// Monaco's stock Go grammar treats every non-keyword identifier alike. Keep
// its string/comment states, while making common declarations and calls
// readable before gopls has returned semantic tokens.
const contextualRules: Monaco.languages.IMonarchLanguageRule[] = [
  [/(func)([ \t]+)(\()([A-Za-z_]\w*)([ \t]+\*?)([A-Za-z_]\w*)(\))([ \t]+)([A-Za-z_]\w*)(?=[ \t]*\()/,
    ['keyword', '', 'delimiter', 'parameter', '', 'type', 'delimiter', '', 'function.definition']],
  [/(func)([ \t]+)(\([^\r\n)]*\))([ \t]+)([A-Za-z_]\w*)(?=[ \t]*\()/,
    ['keyword', '', 'identifier', '', 'function.definition']],
  [/(func)([ \t]+)([A-Za-z_]\w*)(?=[ \t]*(?:\[[^\r\n\]]*\][ \t]*)?\()/,
    ['keyword', '', 'function.definition']],
  [/(type)([ \t]+)([A-Za-z_]\w*)/, ['keyword', '', 'type.definition']],
  [/[A-Za-z_]\w*(?=[ \t]*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
  [/[A-Z][A-Za-z_0-9]*/, 'type'],
]

export function installGoSyntaxFallback(monaco: typeof Monaco): void {
  monaco.languages.setMonarchTokensProvider('go', {
    ...baseGo,
    tokenizer: {
      ...baseGo.tokenizer,
      root: [...contextualRules, ...baseGo.tokenizer.root],
    },
  })
}
