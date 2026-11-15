// GoLand-style postfix completions for Go: typing an expression followed by
// a dot-suffix (e.g. `err.check`) offers a snippet that wraps the expression.
// Purely local — works without gopls.

import type * as Monaco from 'monaco-editor'

interface SuffixRule {
  suffix: string
  label: string
  detail: string
  body: string
}

const RULES: SuffixRule[] = [
  { suffix: 'print', label: 'fmt.Println(expr)', detail: 'print → fmt.Println(expr)', body: 'fmt.Println($expr)' },
  { suffix: 'printf', label: 'fmt.Printf("...", expr)', detail: 'printf → fmt.Printf', body: 'fmt.Printf("%v\\n", $expr)' },
  { suffix: 'err', label: 'if err != nil { ... }', detail: 'err → error check', body: 'if ${1:err} != nil {\n\treturn ${1:err}\n}' },
  { suffix: 'if', label: 'if expr { ... }', detail: 'if → if statement', body: 'if $expr {\n\t$0\n}' },
  { suffix: 'for', label: 'for i := range expr', detail: 'for → range loop', body: 'for ${1:i} := range $expr {\n\t$0\n}' },
  { suffix: 'forr', label: 'for i, v := range expr', detail: 'forr → range with value', body: 'for ${1:i}, ${2:v} := range $expr {\n\t$0\n}' },
  { suffix: 'test', label: 'if expr == expected (test)', detail: 'test → assertion', body: 'if !reflect.DeepEqual($expr, ${1:expected}) {\n\tt.Fatalf("got %v, want %v", $expr, ${1:expected})\n}' },
]

/** Register the postfix completion provider on the Go language. */
export function registerGoSuffixCompletions(monaco: typeof Monaco): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('go', {
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => {
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      // The suffix candidate is the trailing word right before the dot.
      const match = /([A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?|[)\]])\.([A-Za-z]+)$/.exec(line)
      if (!match) return { suggestions: [] }
      const [, expression, typed] = match
      const rule = RULES.find((candidate) => candidate.suffix === typed)
      if (!rule) return { suggestions: [] }
      const startColumn = position.column - (typed.length + 1 + expression.length)
      const range = new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column)
      return {
        suggestions: RULES.filter((candidate) => candidate.suffix.startsWith(typed)).map((candidate) => ({
          kind: monaco.languages.CompletionItemKind.Snippet,
          label: candidate.label,
          detail: candidate.detail,
          insertText: candidate.body.replace('$expr', expression),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: `0${candidate.suffix}`,
        })),
      }
    },
  })
}
