import type * as Monaco from 'monaco-editor'
import type { DefinitionTarget, GoplsClient } from './lsp/client'
import { uriToPath } from './lsp/uri'

interface WordTarget {
  path: string
  line: number
  column: number
  name: string
  startColumn: number
  endColumn: number
  version: number
}

interface ModifierNavigationOptions {
  editor: Monaco.editor.IStandaloneCodeEditor
  monaco: typeof Monaco
  getClient: () => GoplsClient | null
  navigate: (target: DefinitionTarget, from: DefinitionTarget) => Promise<void>
  showReferences: (name: string, references: DefinitionTarget[]) => void
  reportError: (error: unknown) => void
  linkHint: (atDeclaration: boolean) => string
}

/**
 * Monaco waits for a target text model before drawing its built-in Cmd link.
 * Unopened Go files do not have a model yet, although gopls can resolve them.
 * This link gesture uses the LSP location directly, including declarations.
 */
export function installModifierNavigation(options: ModifierNavigationOptions): Monaco.IDisposable {
  const { editor, monaco, getClient, navigate, showReferences, reportError, linkHint } = options
  const host = editor.getContainerDomNode()
  const decoration = editor.createDecorationsCollection()
  const cache = new Map<string, DefinitionTarget | null>()
  let lastPointer: { x: number; y: number } | null = null
  let activeKey: string | null = null
  let linkShown = false
  let request = 0

  const wordAt = (x: number, y: number): WordTarget | null => {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file' || !model.uri.path.endsWith('.go')) return null
    const target = editor.getTargetAtClientPoint(x, y)
    if (target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !target.position) return null
    const position = target.position
    const word = model.getWordAtPosition(position)
    // Monaco may place the caret just after the last glyph while the pointer
    // is still over that glyph. Query gopls from inside the identifier.
    if (!word || position.column < word.startColumn || position.column > word.endColumn) return null
    return {
      path: uriToPath(model.uri.toString()), line: position.lineNumber,
      column: Math.min(position.column, word.endColumn - 1),
      name: word.word, startColumn: word.startColumn, endColumn: word.endColumn,
      version: model.getVersionId(),
    }
  }

  const keyOf = (word: WordTarget) => `${word.path}:${word.version}:${word.line}:${word.startColumn}:${word.endColumn}`
  const clear = () => {
    request += 1
    activeKey = null
    if (linkShown) {
      decoration.clear()
      linkShown = false
    }
  }

  const showAt = (x: number, y: number) => {
    const word = wordAt(x, y)
    const client = getClient()
    if (!word || !client) { clear(); return }
    const key = keyOf(word)
    if (key === activeKey) return
    clear()
    activeKey = key
    const currentRequest = request
    const showLink = (target: DefinitionTarget | null) => {
      if (request !== currentRequest || activeKey !== key || !target) return
      const model = editor.getModel()
      if (!model || model.getVersionId() !== word.version || uriToPath(model.uri.toString()) !== word.path) return
      const atDeclaration = target.path === word.path && target.line === word.line
        && target.column >= word.startColumn && target.column < word.endColumn
      decoration.set([{
        range: new monaco.Range(word.line, word.startColumn, word.line, word.endColumn),
        options: {
          inlineClassName: 'gomavo-navigation-link',
          hoverMessage: { value: linkHint(atDeclaration) },
        },
      }])
      linkShown = true
    }
    if (cache.has(key)) { showLink(cache.get(key) ?? null); return }
    void client.goToDefinition(word.path, word.line, word.column).then((target) => {
      if (cache.size > 200) cache.clear()
      if (target) cache.set(key, target)
      showLink(target)
    }).catch(() => { /* A failed hover lookup must not interrupt editing. */ })
  }

  const jump = async (word: WordTarget) => {
    const client = getClient()
    if (!client) return
    const model = editor.getModel()
    if (!model) return
    const from = { path: word.path, line: word.line, column: word.column }
    try {
      const key = keyOf(word)
      const target = cache.get(key) ?? await client.goToDefinition(word.path, word.line, word.column)
      if (editor.getModel() !== model || model.getVersionId() !== word.version || !target) return
      const atDeclaration = target.path === word.path && target.line === word.line
        && target.column >= word.startColumn && target.column < word.endColumn
      if (!atDeclaration) { await navigate(target, from); return }
      const references = await client.findUsages(word.path, word.line, word.column)
      if (editor.getModel() !== model || model.getVersionId() !== word.version) return
      const callers = references.filter((item) => !(item.path === word.path && item.line === word.line
        && item.column >= word.startColumn && item.column < word.endColumn))
      const unique = [...new Map(callers.map((item) => [`${item.path}:${item.line}:${item.column}`, item])).values()]
      if (unique.length === 1) await navigate(unique[0], from)
      else showReferences(word.name, unique)
    } catch (error) { reportError(error) }
  }

  const mouseMove = editor.onMouseMove((event) => {
    // getTargetAtClientPoint takes viewport coordinates; Monaco's posx/posy
    // are page coordinates and drift when the host page is scrolled.
    const { clientX: x, clientY: y } = event.event.browserEvent
    lastPointer = { x, y }
    if (event.event.metaKey) showAt(x, y)
    else clear()
  })
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Meta' && lastPointer) showAt(lastPointer.x, lastPointer.y)
  }
  const keyUp = (event: KeyboardEvent) => { if (event.key === 'Meta') clear() }
  const mouseLeave = () => { lastPointer = null; clear() }
  const windowBlur = () => { lastPointer = null; clear() }
  const mouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || !getClient()) return
    const word = wordAt(event.clientX, event.clientY)
    if (!word) return
    // Capture before Monaco's own gesture. It cannot draw links to unopened
    // files and sends declaration clicks back to the declaration itself.
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    clear()
    void jump(word)
  }
  const modelChange = editor.onDidChangeModel(() => { cache.clear(); clear() })
  const contentChange = editor.onDidChangeModelContent(() => { cache.clear(); clear() })
  const scrollChange = editor.onDidScrollChange((event) => {
    if (event.scrollTopChanged || event.scrollLeftChanged) clear()
  })
  host.addEventListener('mousedown', mouseDown, true)
  host.addEventListener('mouseleave', mouseLeave)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('blur', windowBlur)
  return {
    dispose() {
      clear()
      mouseMove.dispose()
      modelChange.dispose()
      contentChange.dispose()
      scrollChange.dispose()
      host.removeEventListener('mousedown', mouseDown, true)
      host.removeEventListener('mouseleave', mouseLeave)
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', windowBlur)
    },
  }
}
