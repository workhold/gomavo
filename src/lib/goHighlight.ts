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

/** Find TODO words in comments without tokenizing the entire document. */
export function goTodoMarkerRanges(source: string): GoTodoMarkerRange[] {
  const ranges: GoTodoMarkerRange[] = []
  const marker = /\b(?:TODO|FIXME|XXX|HACK)\b/gi
  let state: 'code' | 'block' | 'raw' | 'quoted' | 'rune' = 'code'
  const lines = source.split(/\r\n|\r|\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    let offset = 0
    let commentStart = state === 'block' ? 0 : -1
    const collect = (end: number) => {
      if (commentStart < 0) return
      for (const match of line.slice(commentStart, end).matchAll(marker)) {
        const startColumn = commentStart + (match.index ?? 0) + 1
        ranges.push({ lineNumber: lineIndex + 1, startColumn, endColumn: startColumn + match[0].length })
      }
      commentStart = -1
    }
    while (offset < line.length) {
      const char = line[offset]
      const next = line[offset + 1]
      if (state === 'block') {
        if (char === '*' && next === '/') { offset += 2; collect(offset); state = 'code' }
        else offset += 1
      } else if (state === 'raw') {
        if (char === '`') state = 'code'
        offset += 1
      } else if (state === 'quoted' || state === 'rune') {
        if (char === '\\') offset += 2
        else {
          if (char === (state === 'quoted' ? '"' : "'")) state = 'code'
          offset += 1
        }
      } else if (char === '/' && next === '/') {
        commentStart = offset
        collect(line.length)
        break
      } else if (char === '/' && next === '*') {
        commentStart = offset
        state = 'block'
        offset += 2
      } else {
        if (char === '`') state = 'raw'
        else if (char === '"') state = 'quoted'
        else if (char === "'") state = 'rune'
        offset += 1
      }
    }
    if (state === 'block') collect(line.length)
    if (state === 'quoted' || state === 'rune') state = 'code'
  }
  return ranges
}

/** Keep comment markers yellow when gopls semantic tokens replace lexical colors. */
export function installGoTodoDecorations(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void {
  const decorations = editor.createDecorationsCollection()
  let timer = 0
  const update = () => {
    timer = 0
    const model = editor.getModel()
    if (!model || model.getLanguageId() !== 'go') {
      decorations.clear()
      return
    }
    decorations.set(goTodoMarkerRanges(model.getValue()).map((range) => ({
      range: new monaco.Range(range.lineNumber, range.startColumn, range.lineNumber, range.endColumn),
      options: { inlineClassName: 'gomavo-todo-marker' },
    })))
  }
  const schedule = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(update, 350)
  }
  editor.onDidChangeModel(() => { decorations.clear(); schedule() })
  editor.onDidChangeModelContent(schedule)
  editor.onDidDispose(() => {
    window.clearTimeout(timer)
    decorations.clear()
  })
  schedule()
}
