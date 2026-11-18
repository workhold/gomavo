import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import { command } from '../../lib/api'
import { fileUri, type GoplsClient } from '../../lib/lsp'
import { goSourceDeclarations, goTestDeclarations } from '../../lib/goTests'
import { generateConstructor, generateGetters, generateSetters, generateStructTags, goStructs, type StructTagScheme } from '../../lib/goGenerate'
import { editorConfigIndentOptions } from '../../lib/editorConfig'
import type { LocalEditHistory } from '../../lib/localHistory'
import type { Locale, MessageKey } from '../../lib/i18n'
import type { LspState, OpenFile, PanelView } from '../types'
import type { UsageItem } from '../ui/UsagesPane'
import type { useNavigation } from './useNavigation'
import { insertGenerated } from '../editorGeneration'

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string


interface UseCodeActionsParams {
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  activePathRef: RefObject<string | null>
  tabsRef: RefObject<OpenFile[]>
  localeRef: RefObject<Locale>
  lspRef: RefObject<GoplsClient | null>
  lspState: LspState
  navigationRequestRef: RefObject<number>
  createTestFromEditorRef: RefObject<((line?: number) => void) | null>
  localEditHistoryRef: RefObject<LocalEditHistory>
  activeIndentOptions: ReturnType<typeof editorConfigIndentOptions>
  setTabs: Dispatch<SetStateAction<OpenFile[]>>
  setLocalHistoryRevision: Dispatch<SetStateAction<number>>
  setPanelView: Dispatch<SetStateAction<PanelView>>
  setPanelOpen: Dispatch<SetStateAction<boolean>>
  setUsages: Dispatch<SetStateAction<{ identifier: string; items: UsageItem[] } | null>>
  setUsagesBusy: Dispatch<SetStateAction<boolean>>
  captureEditorLocation: ReturnType<typeof useNavigation>['captureEditorLocation']
  navigateTo: ReturnType<typeof useNavigation>['navigateTo']
  applyExternalContent: (path: string, content: string) => void
  saveFile: (path: string) => Promise<boolean>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: Translate
}

/** Go formatting, refactoring, navigation, generation and cleanup commands. */
export function useCodeActions({
  editorRef, activePathRef, tabsRef, localeRef, lspRef, lspState,
  navigationRequestRef, createTestFromEditorRef, localEditHistoryRef,
  activeIndentOptions, setTabs, setLocalHistoryRevision, setPanelView,
  setPanelOpen, setUsages, setUsagesBusy, captureEditorLocation,
  navigateTo, applyExternalContent, saveFile, notify, formatError, t,
}: UseCodeActionsParams) {
  const formatCurrentFile = useCallback(async () => {
    const path = activePathRef.current
    const file = tabsRef.current.find((item) => item.path === path)
    if (!file || !file.path.endsWith('.go') || file.readOnly) {
      notify(localeRef.current === 'zh-CN' ? '请先打开可编辑的 Go 文件。' : 'Open an editable Go file first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(localeRef.current === 'zh-CN' ? 'gopls 尚未就绪，无法格式化当前文件。' : 'gopls is not ready to format this file.', 'error')
      return
    }
    const action = editorRef.current?.getAction('editor.action.formatDocument')
    if (!action?.isSupported()) {
      notify(localeRef.current === 'zh-CN' ? '当前文件没有可用的格式化器。' : 'No formatter is available for this file.', 'error')
      return
    }
    try { await action.run() }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, lspState, notify])

  /** GoLand "Optimize imports" on demand for the active Go file. */
  const organizeCurrentFile = useCallback(async () => {
    const path = activePathRef.current
    const file = tabsRef.current.find((item) => item.path === path)
    if (!file || !file.path.endsWith('.go') || file.readOnly) {
      notify(localeRef.current === 'zh-CN' ? '请先打开可编辑的 Go 文件。' : 'Open an editable Go file first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(localeRef.current === 'zh-CN' ? 'gopls 尚未就绪，无法整理 imports。' : 'gopls is not ready to organize imports.', 'error')
      return
    }
    try {
      const model = editorRef.current?.getModel()
      const source = model && fileUri(file.path) === model.uri.toString() ? model.getValue() : file.content
      const organized = await lspRef.current.organizeImports(file.path, source)
      if (organized !== null && organized !== source) applyExternalContent(file.path, organized)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [applyExternalContent, formatError, lspState, notify])

  /** Run a gopls refactoring (extract/inline) at the cursor. */
  const runRefactor = useCallback(async (kinds: string[], prefer?: RegExp) => {
    const path = activePathRef.current
    const editor = editorRef.current
    const position = editor?.getPosition()
    if (!path?.endsWith('.go') || !editor || !position || editor.getModel()?.uri.toString() !== fileUri(path)) {
      notify(localeRef.current === 'zh-CN' ? '请先把光标放在 Go 代码上。' : 'Place the cursor in Go code first.', 'error')
      return
    }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法运行重构。'), 'error')
      return
    }
    try {
      const selection = editor.getSelection()
      const tryQuery = async (startLine: number, startCol: number, endLine: number, endCol: number) => {
        const actions = await lspRef.current!.codeActionsAtCursor(path, startLine, startCol, kinds, endLine, endCol)
        return actions.filter((action) => {
          const actionKind = action.kind
          return !!actionKind && kinds.some((kind) => actionKind === kind || actionKind.startsWith(`${kind}.`))
        })
      }
      // gopls only offers extract refactorings for a real range that starts on
      // the expression, so with a bare cursor walk the enclosing AST ranges
      // (gopls selectionRange chain) until one yields an action.
      let matching = selection && !selection.isEmpty()
        ? await tryQuery(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn)
        : []
      if (!matching.length) {
        const chain = await lspRef.current!.selectionRanges(path, position.lineNumber, position.column)
        for (const range of chain) {
          matching = await tryQuery(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)
          if (matching.length) break
        }
      }
      if (!matching.length) {
        notify(t('光标处没有可用的重构。'), 'error')
        return
      }
      // gopls serves "Extract variable" and "Extract constant" under the same
      // refactor.extract.constant kind; prefer the requested title when given.
      const chosen = (prefer && matching.find((action) => prefer.test(action.title))) ?? matching[0]
      await lspRef.current.applyCodeAction(chosen)
      notify(t('已应用重构：{name}', { name: chosen.title }))
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, lspState, notify, t])

  /** GoLand ⌥⌘B: open the implementation of the symbol under the cursor. */
  const goToImplementationNow = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const position = editor?.getPosition()
    if (!path || !editor || !position || lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法跳转实现。'), 'error')
      return
    }
    const source = captureEditorLocation()
    if (!source || source.path !== path) return
    const request = navigationRequestRef.current
    try {
      const target = await lspRef.current.goToImplementation(path, position.lineNumber, position.column)
      if (request !== navigationRequestRef.current || activePathRef.current !== path) return
      if (!target) { notify(t('未找到实现。'), 'error'); return }
      await navigateTo(target, source)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [captureEditorLocation, formatError, lspState, navigateTo, navigationRequestRef, notify, t])

  /** ⇧⌘T: jump between a function and its test (GoLand Go to Test). */
  const goToTestNow = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!path?.endsWith('.go') || !editor || !model) return
    const line = position?.lineNumber
    if (path.endsWith('_test.go')) {
      const sourcePath = `${path.slice(0, -8)}.go`
      let source = tabsRef.current.find((file) => file.path === sourcePath)?.content ?? null
      if (source === null) {
        source = await command<string>('read_file', { path: sourcePath }).catch(() => null)
      }
      if (source === null) { notify(t('未找到对应的源码文件。'), 'error'); return }
      const testName = line ? goTestDeclarations(model.getValue()).find((item) => item.startLine <= line && line <= item.endLine)?.name : undefined
      const baseName = testName?.replace(/^Test/, '') ?? ''
      const declaration = baseName ? goSourceDeclarations(source).find((item) => item.name === baseName) : undefined
      await navigateTo({ path: sourcePath, line: declaration?.startLine ?? 1, column: 1 }, captureEditorLocation())
      return
    }
    const testName = line ? goSourceDeclarations(model.getValue()).find((item) => item.startLine <= line && line <= item.endLine)?.testName : undefined
    if (!testName) { notify(t('光标处没有函数。'), 'error'); return }
    const testPath = `${path.slice(0, -3)}_test.go`
    let testSource = tabsRef.current.find((file) => file.path === testPath)?.content ?? null
    if (testSource === null) {
      testSource = await command<string>('read_file', { path: testPath }).catch(() => null)
    }
    if (testSource === null) {
      notify(t('还没有测试文件，正在生成…'))
      createTestFromEditorRef.current?.(line)
      return
    }
    const declaration = goTestDeclarations(testSource).find((item) => item.name === testName)
      ?? goTestDeclarations(testSource).find((item) => item.name.startsWith(`${testName}/`))
    await navigateTo({ path: testPath, line: declaration?.startLine ?? 1, column: 1 }, captureEditorLocation())
  }, [captureEditorLocation, navigateTo, notify, t])

  /** ⌥F7: Find Usages into the bottom tool window. */
  const runFindUsages = useCallback(async () => {
    const path = activePathRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position || !path) return
    const word = model.getWordAtPosition(position)
    if (!word) { notify(t('光标处没有可查找的符号。'), 'error'); return }
    if (lspState !== 'ready' || !lspRef.current) {
      notify(t('gopls 尚未就绪，无法查找用法。'), 'error')
      return
    }
    setPanelView('usages')
    setPanelOpen(true)
    setUsages({ identifier: word.word, items: [] })
    setUsagesBusy(true)
    try {
      const items = await lspRef.current.findUsages(path, position.lineNumber, position.column)
      setUsages({ identifier: word.word, items })
    } catch (cause) {
      setUsages({ identifier: word.word, items: [] })
      notify(formatError(cause), 'error')
    } finally { setUsagesBusy(false) }
  }, [formatError, lspState, notify, t])

  /** One Generate-menu entry: constructor/getter/setter insert, struct tags rewrite, tests. */
  const runGenerate = useCallback((kind: 'constructor' | 'getter' | 'setter' | 'tag-json' | 'tag-yaml' | 'tag-db' | 'test', structName?: string) => {
    const editor = editorRef.current
    const path = activePathRef.current
    const model = editor?.getModel()
    if (!editor || !model || !path?.endsWith('.go')) { notify(t('光标处没有可生成的代码。'), 'error'); return }
    if (kind === 'test') { createTestFromEditorRef.current?.(); return }
    const source = model.getValue()
    const structs = goStructs(source)
    if (!structName) {
      if (structs.length === 1) { runGenerate(kind, structs[0].name); return }
      notify(t('当前文件没有可操作的 struct。'), 'error')
      return
    }
    if (kind === 'tag-json' || kind === 'tag-yaml' || kind === 'tag-db') {
      const scheme: StructTagScheme = kind === 'tag-json' ? 'json' : kind === 'tag-yaml' ? 'yaml' : 'db'
      const result = generateStructTags(source, structName, scheme)
      if (!result || result.nextContent === source) { notify(t('没有可标注的字段。'), 'error'); return }
      applyExternalContent(path, result.nextContent)
      const next = tabsRef.current.map((item) => item.path === path ? { ...item, content: result.nextContent } : item)
      tabsRef.current = next
      setTabs(next)
      if (localEditHistoryRef.current.record(path, source, result.nextContent)) setLocalHistoryRevision((value) => value + 1)
      void lspRef.current?.changeDocument(path, result.nextContent).catch(() => undefined)
      return
    }
    const generator = kind === 'constructor'
      ? (text: string) => generateConstructor(text, structName)
      : kind === 'getter'
        ? (text: string) => generateGetters(text, structName)
        : (text: string) => generateSetters(text, structName)
    insertGenerated(editor, generator)
    notify(t('已生成 {label}', { label: structName }))
  }, [applyExternalContent, notify, t])

  /** Code Cleanup: organize imports + reformat every open Go file, then save. */
  const codeCleanup = useCallback(async () => {
    const client = lspRef.current
    if (lspState !== 'ready' || !client) { notify(t('gopls 尚未就绪，无法代码清理。'), 'error'); return }
    const targets = tabsRef.current.filter((file) => file.path.endsWith('.go') && !file.readOnly && !file.binary)
    if (!targets.length) { notify(t('没有可清理的 Go 文件。')); return }
    let changed = 0
    const updates = new Map<string, string>()
    for (const file of targets) {
      let content = file.content
      const organized = await client.organizeImports(file.path, content).catch(() => null)
      if (organized !== null) content = organized
      const formatted = await client.formatDocument(file.path, content, {
        tabSize: activeIndentOptions.tabSize, insertSpaces: activeIndentOptions.insertSpaces,
      }).catch(() => null)
      if (formatted !== null) content = formatted
      if (content !== file.content) { updates.set(file.path, content); changed += 1 }
    }
    if (updates.size) {
      for (const [path, content] of updates) applyExternalContent(path, content)
      const next = tabsRef.current.map((item) => updates.has(item.path) ? { ...item, content: updates.get(item.path)! } : item)
      tabsRef.current = next
      setTabs(next)
      let historyChanged = false
      for (const [path, content] of updates) {
        if (localEditHistoryRef.current.ensureFile(path, content)) historyChanged = true
      }
      if (historyChanged) setLocalHistoryRevision((value) => value + 1)
      for (const [path, content] of updates) {
        if (path.endsWith('.go')) void lspRef.current?.changeDocument(path, content).catch(() => undefined)
      }
    }
    for (const file of targets) await saveFile(file.path)
    notify(changed ? t('代码清理完成，更新了 {count} 个文件。', { count: changed }) : t('代码清理完成'))
  }, [activeIndentOptions, applyExternalContent, lspState, notify, saveFile, t])

  return {
    formatCurrentFile, organizeCurrentFile, runRefactor, goToImplementationNow,
    goToTestNow, runFindUsages, runGenerate, codeCleanup,
  }
}
