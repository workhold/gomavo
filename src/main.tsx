import ReactDOM from 'react-dom/client'
import * as monaco from 'monaco-editor/editor/editor.api'
// Monaco's package root registers every language and language service. Load the
// editor actions used by the IDE and register only the file formats we display.
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
// The code-action contribution provides the lightbulb and the ⌘. quick-fix menu.
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/format/browser/formatActions'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/rename/browser/rename'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/dockerfile/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/rust/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/cpp/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/kotlin/register'
import 'monaco-editor/languages/definitions/protobuf/register'
import 'monaco-editor/languages/definitions/graphql/register'
import 'monaco-editor/languages/definitions/hcl/register'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import App from './App'
import { migrateLegacyLocalStorage } from './lib/legacyStorage'
import { installGoSyntaxFallback } from './lib/goHighlight'
import { installProjectFileHighlight } from './lib/projectFileHighlight'
import './styles.css'

try { migrateLegacyLocalStorage(localStorage) } catch { /* storage may be unavailable */ }

installGoSyntaxFallback(monaco)
installProjectFileHighlight(monaco)

monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON'] })
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'string.key.json'],
      [/"(?:\\.|[^"\\])*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number.json'],
      [/\b(?:true|false|null)\b/, 'keyword.json'],
      [/[{}\[\]]/, 'delimiter.bracket.json'],
      [/[:,]/, 'delimiter.json'],
    ],
  },
})

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker()
  },
}
loader.config({ monaco })

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
