import type * as Monaco from 'monaco-editor/editor/editor.api'
import { language as baseGo } from 'monaco-editor/languages/definitions/go/go'

// Monaco's stock Go grammar treats every non-keyword identifier alike. Keep
// its string/comment states, while making common declarations and calls
// readable before gopls has returned semantic tokens.
const contextualRules: Monaco.languages.IMonarchLanguageRule[] = [
  // Keep the marker distinct from the rest of a line comment. The base Go
  // tokenizer otherwise paints the complete comment with one gray token.
  // Monarch recompiles rules without their RegExp flags, so spell out case
  // variants instead of relying on /i for lowercase TODO comments.
  [/(\/\/[^\r\n]*?\b)([Tt][Oo][Dd][Oo]|[Ff][Ii][Xx][Mm][Ee]|[Xx][Xx][Xx]|[Hh][Aa][Cc][Kk])(\b[^\r\n]*)$/, ['comment', 'comment.todo', 'comment']],
  [/(const)([ \t]*)(\()([ \t]*)([A-Za-z_]\w*)/, ['keyword.const', '', 'delimiter', '', { token: 'variable.readonly', next: '@constGroup' }]],
  [/(const)([ \t]*)(\()/, ['keyword.const', '', { token: 'delimiter', next: '@constGroup' }]],
  [/(const)([ \t]+)([A-Za-z_]\w*)/, ['keyword.const', '', 'variable.readonly']],
  [/(func)([ \t]+)(\()([A-Za-z_]\w*)([ \t]+\*?)([A-Za-z_]\w*)(\))([ \t]+)([A-Za-z_]\w*)(?=[ \t]*\()/,
    ['keyword', '', 'delimiter', 'receiver', '', 'type', 'delimiter', '', 'function.definition']],
  [/(func)([ \t]+)(\([^\r\n)]*\))([ \t]+)([A-Za-z_]\w*)(?=[ \t]*\()/,
    ['keyword', '', 'identifier', '', 'function.definition']],
  [/(func)([ \t]+)([A-Za-z_]\w*)(?=[ \t]*(?:\[[^\r\n\]]*\][ \t]*)?\()/,
    ['keyword', '', 'function.definition']],
  [/(type)([ \t]+)([A-Za-z_]\w*)/, ['keyword', '', 'type.definition']],
  [/[A-Za-z_]\w*(?=[ \t]*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
  [/[A-Z][A-Za-z_0-9]*/, 'type'],
]

const todoMarker = String.raw`(?:[Tt][Oo][Dd][Oo]|[Ff][Ii][Xx][Mm][Ee]|[Xx][Xx][Xx]|[Hh][Aa][Cc][Kk])`
function blockCommentTodoRules(commentToken: string): Monaco.languages.IMonarchLanguageRule[] {
  return [
    [new RegExp(String.raw`\b${todoMarker}\b`), 'comment.todo'],
    [new RegExp(String.raw`[^/*]+?(?=\b${todoMarker}\b)`), commentToken],
  ]
}

export function installGoSyntaxFallback(monaco: typeof Monaco): void {
  monaco.languages.setMonarchTokensProvider('go', {
    ...baseGo,
    tokenizer: {
      ...baseGo.tokenizer,
      root: [...contextualRules, ...baseGo.tokenizer.root],
      comment: [...blockCommentTodoRules('comment'), ...baseGo.tokenizer.comment],
      doccomment: [...blockCommentTodoRules('comment.doc'), ...baseGo.tokenizer.doccomment],
      // In a grouped declaration, the first identifier on each spec line is
      // a constant even when gopls is unavailable. Parse expressions with the
      // normal Go tokenizer so RHS identifiers retain their usual colors.
      constGroup: [
        [/^([ \t]*)(\))/, ['', { token: 'delimiter', next: '@pop' }]],
        [/^([ \t]*)([A-Za-z_]\w*)/, ['', 'variable.readonly']],
        { include: '@root' },
      ],
    },
  })
}

export interface GoTodoMarkerRange {
  lineNumber: number
  startColumn: number
  endColumn: number
}

/** Find TODO words in lexical comments, excluding strings and Go code. */
export function goTodoMarkerRanges(source: string, tokenLines: readonly (readonly { offset: number; type: string }[])[]): GoTodoMarkerRange[] {
  const ranges: GoTodoMarkerRange[] = []
  const lines = source.split(/\r\n|\r|\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const tokens = tokenLines[lineIndex] ?? []
    for (const match of lines[lineIndex].matchAll(/\b(?:TODO|FIXME|XXX|HACK)\b/gi)) {
      const offset = match.index ?? 0
      let tokenType = ''
      for (const token of tokens) {
        if (token.offset > offset) break
        tokenType = token.type
      }
      if (!tokenType.startsWith('comment')) continue
      ranges.push({ lineNumber: lineIndex + 1, startColumn: offset + 1, endColumn: offset + match[0].length + 1 })
    }
  }
  return ranges
}

/** Keep comment markers yellow when gopls semantic tokens replace lexical colors. */
export function installGoTodoDecorations(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void {
  const decorations = editor.createDecorationsCollection()
  let frame = 0
  const update = () => {
    frame = 0
    const model = editor.getModel()
    if (!model || model.getLanguageId() !== 'go') {
      decorations.clear()
      return
    }
    const source = model.getValue()
    decorations.set(goTodoMarkerRanges(source, monaco.editor.tokenize(source, 'go')).map((range) => ({
      range: new monaco.Range(range.lineNumber, range.startColumn, range.lineNumber, range.endColumn),
      options: { inlineClassName: 'gomavo-todo-marker' },
    })))
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  editor.onDidChangeModel(schedule)
  editor.onDidChangeModelContent(schedule)
  editor.onDidDispose(() => {
    if (frame) cancelAnimationFrame(frame)
    decorations.clear()
  })
  schedule()
}
