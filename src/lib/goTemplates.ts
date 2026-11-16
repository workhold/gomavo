// GoLand-style live templates for Go: type an abbreviation (`test`, `main`,
// `errn`, …) and pick it from the completion list; the snippet inserts with
// tab-stop placeholders Monaco already renders. Purely local — no gopls needed.

import type * as Monaco from 'monaco-editor'

interface TemplateRule {
  abbreviation: string
  label: string
  detail: string
  body: string
}

const RULES: TemplateRule[] = [
  { abbreviation: 'main', label: 'func main()', detail: 'main → program entry', body: 'func main() {\n\t$0\n}' },
  { abbreviation: 'test', label: 'func TestXxx(t *testing.T)', detail: 'test → test function', body: 'func ${1:Test}Name(t *testing.T) {\n\t$0\n}' },
  { abbreviation: 'bench', label: 'func BenchmarkXxx(b *testing.B)', detail: 'bench → benchmark function', body: 'func ${1:Benchmark}Name(b *testing.B) {\n\tfor ${2:i} := 0; ${2:i} < b.N; ${2:i}++ {\n\t\t$0\n\t}\n}' },
  { abbreviation: 'err', label: 'if err != nil { return err }', detail: 'err → error check', body: 'if err != nil {\n\t$0\n}' },
  { abbreviation: 'errn', label: 'if err != nil { return nil, err }', detail: 'errn → error return', body: 'if err != nil {\n\treturn nil, err\n}$0' },
  { abbreviation: 'ife', label: 'if err == nil { ... }', detail: 'ife → happy-path check', body: 'if err == nil {\n\t$0\n}' },
  { abbreviation: 'if', label: 'if cond { ... }', detail: 'if → conditional', body: 'if ${1:cond} {\n\t$0\n}' },
  { abbreviation: 'for', label: 'for i := 0; i < n; i++', detail: 'for → counted loop', body: 'for ${1:i} := 0; ${1:i} < ${2:count}; ${1:i}++ {\n\t$0\n}' },
  { abbreviation: 'forr', label: 'for i, v := range x', detail: 'forr → range with value', body: 'for ${1:i}, ${2:v} := range ${3:collection} {\n\t$0\n}' },
  { abbreviation: 'fore', label: 'for _, v := range x', detail: 'fore → range value only', body: 'for _, ${1:v} := range ${2:collection} {\n\t$0\n}' },
  { abbreviation: 'fun', label: 'func name(params) ret', detail: 'fun → function', body: 'func ${1:name}(${2:params}) ${3:error} {\n\t$0\n}' },
  { abbreviation: 'meth', label: 'func (r Type) Name()', detail: 'meth → method with receiver', body: 'func (${1:r} *${2:Type}) ${3:Name}() ${4:error} {\n\t$0\n}' },
  { abbreviation: 'ty', label: 'type Name struct { ... }', detail: 'ty → struct type', body: 'type ${1:Name} struct {\n\t$0\n}' },
  { abbreviation: 'iface', label: 'type Name interface { ... }', detail: 'iface → interface type', body: 'type ${1:Name} interface {\n\t$0\n}' },
  { abbreviation: 'con', label: 'const name = value', detail: 'con → constant', body: 'const ${1:name} ${2:=} ${3:value}' },
  { abbreviation: 'var', label: 'var name = value', detail: 'var → variable', body: 'var ${1:name} ${2:=} ${3:value}' },
  { abbreviation: 'sw', label: 'switch expr { case … }', detail: 'sw → switch statement', body: 'switch ${1:expr} {\ncase ${2:value}:\n\t$0\ndefault:\n\t$0\n}' },
  { abbreviation: 'sel', label: 'select { case <-ch }', detail: 'sel → select statement', body: 'select {\ncase ${1:v} := <-${2:ch}:\n\t$0\ndefault:\n}' },
  { abbreviation: 'sl', label: '[]T{ … }', detail: 'sl → slice literal', body: '[]${1:string}{$0}' },
  { abbreviation: 'map', label: 'map[K]V{ … }', detail: 'map → map literal', body: 'map[${1:string}]${2:any}{$0}' },
  { abbreviation: 'def', label: 'defer func() { … }()', detail: 'def → deferred closure', body: 'defer func() {\n\t${1:recover()}\n}()\n$0' },
  { abbreviation: 'gof', label: 'go func() { … }()', detail: 'gof → goroutine', body: 'go func() {\n\t$0\n}()' },
  { abbreviation: 'pri', label: 'fmt.Println()', detail: 'pri → print line', body: 'fmt.Println($0)' },
  { abbreviation: 'prf', label: 'fmt.Printf()', detail: 'prf → formatted print', body: 'fmt.Printf("${1:%v}\\n", ${2:value})' },
]

/** Register the live-template completion provider on the Go language. */
export function registerGoTemplates(monaco: typeof Monaco): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('go', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      if (!word.word) return { suggestions: [] }
      const typed = word.word.toLowerCase()
      const suggestions: Monaco.languages.CompletionItem[] = []
      for (const rule of RULES) {
        // Prefix match keeps the list tight; require two typed characters so
        // one-letter prefixes do not spam the suggestion list.
        if (!rule.abbreviation.startsWith(typed) || typed.length < 2) continue
        suggestions.push({
          label: rule.abbreviation,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: rule.label,
          documentation: rule.detail,
          insertText: rule.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          sortText: `zz${rule.abbreviation}`,
        })
      }
      return { suggestions }
    },
  })
}
