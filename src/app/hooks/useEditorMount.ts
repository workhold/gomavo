import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { fileUri, uriToPath, type GoplsClient } from '../../lib/lsp'
import { goSourceDeclarations } from '../../lib/goTests'
import { registerGoTemplates } from '../../lib/goTemplates'
import { defineGomavoTheme } from '../../lib/monacoTheme'
import { registerGoSuffixCompletions } from '../../lib/goSuffix'
import { installGoTodoDecorations } from '../../lib/goHighlight'
import { installModifierNavigation } from '../../lib/modifierNavigation'
import type { Locale } from '../../lib/i18n'
import { isWorkspaceFile } from '../helpers'
import type { OpenFile, PanelView } from '../types'
import type { UsageItem } from '../ui/UsagesPane'
import type { useNavigation } from './useNavigation'

interface UseEditorMountParams {
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  splitEditorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  tabsRef: RefObject<OpenFile[]>
  rootRef: RefObject<string | null>
  lspRef: RefObject<GoplsClient | null>
  localeRef: RefObject<Locale>
  runEditorContextRef: RefObject<((line?: number, fileFallback?: boolean) => boolean) | null>
  toggleBreakpointRef: RefObject<((path: string, line: number) => void) | null>
  pruneBreakpointsRef: RefObject<((path: string, lineCount: number) => void) | null>
  createTestContextLineRef: RefObject<number | null>
  setMonacoApi: Dispatch<SetStateAction<typeof Monaco | null>>
  setCursor: Dispatch<SetStateAction<{ line: number; column: number }>>
  setUsages: Dispatch<SetStateAction<{ identifier: string; items: UsageItem[] } | null>>
  setUsagesBusy: Dispatch<SetStateAction<boolean>>
  setPanelView: Dispatch<SetStateAction<PanelView>>
  setPanelOpen: Dispatch<SetStateAction<boolean>>
  captureEditorLocation: ReturnType<typeof useNavigation>['captureEditorLocation']
  navigateTo: ReturnType<typeof useNavigation>['navigateTo']
  applyNavigation: ReturnType<typeof useNavigation>['applyNavigation']
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

/** Installs Monaco navigation, Go context actions and gutter interactions. */
export function useEditorMount({
  editorRef, splitEditorRef, tabsRef, rootRef, lspRef, localeRef,
  runEditorContextRef, toggleBreakpointRef, pruneBreakpointsRef, createTestContextLineRef,
  setMonacoApi, setCursor, setUsages, setUsagesBusy, setPanelView, setPanelOpen,
  captureEditorLocation, navigateTo, applyNavigation, notify, formatError,
}: UseEditorMountParams): { beforeEditorMount: (monaco: typeof Monaco) => void; onEditorMount: OnMount; onSplitEditorMount: OnMount } {
  const beforeEditorMount = useCallback((monaco: typeof Monaco) => {
    defineGomavoTheme(monaco)
    registerGoSuffixCompletions(monaco)
    registerGoTemplates(monaco)
  }, [])

  const installGoNavigation = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    const navigation = installModifierNavigation({
      editor, monaco,
      getClient: () => lspRef.current,
      navigate: async (target, clicked) => {
        const source = captureEditorLocation(editor)
        await navigateTo(target, source ? { ...source, line: clicked.line, column: clicked.column } : clicked)
      },
      showReferences: (name, references) => {
        setUsages({ identifier: name, items: references })
        setUsagesBusy(false)
        setPanelView('usages')
        setPanelOpen(true)
      },
      reportError: (error) => notify(formatError(error), 'error'),
      linkHint: (atDeclaration) => localeRef.current === 'zh-CN'
        ? atDeclaration ? '⌘ 点击查看引用' : '⌘ 点击跳转定义'
        : atDeclaration ? '⌘ click to find references' : '⌘ click to go to definition',
    })
    editor.onDidDispose(() => navigation.dispose())
  }, [captureEditorLocation, formatError, navigateTo, notify])

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    setMonacoApi(monaco)
    installGoNavigation(editor, monaco)
    installGoTodoDecorations(editor, monaco)
    const testFileContext = editor.createContextKey<boolean>('gomavoGoTestFile', false)
    const sourceFileContext = editor.createContextKey<boolean>('gomavoGoSourceFile', false)
    const sourceMethodContext = editor.createContextKey<boolean>('gomavoGoSourceMethod', false)
    const gitFileContext = editor.createContextKey<boolean>('gomavoGitWorkspaceFile', false)
    const updateGoContexts = (line = editor.getPosition()?.lineNumber) => {
      const model = editor.getModel()
      const file = model ? tabsRef.current.find((item) => fileUri(item.path) === model.uri.toString()) : null
      const path = file?.path ?? (model ? uriToPath(model.uri.toString()) : null)
      const eligible = !!path && !!file && !file.readOnly && !file.binary && path.endsWith('.go') && !path.endsWith('_test.go') && isWorkspaceFile(rootRef.current, path)
      testFileContext.set(path?.endsWith('_test.go') ?? false)
      sourceFileContext.set(eligible)
      sourceMethodContext.set(eligible && !!line && goSourceDeclarations(model!.getValue()).some((item) => item.startLine <= line && line <= item.endLine))
      gitFileContext.set(!!file && !!path && isWorkspaceFile(rootRef.current, path))
      createTestContextLineRef.current = line ?? null
    }
    updateGoContexts()
    editor.onDidChangeModel(() => updateGoContexts())
    // updateGoContexts scans the whole file for declarations; coalesce the
    // per-keystroke and per-cursor-move calls into one parse per frame.
    let goContextsFrame = 0
    let goContextsLine: number | undefined
    const scheduleGoContexts = (line?: number) => {
      goContextsLine = line
      if (goContextsFrame) return
      goContextsFrame = requestAnimationFrame(() => {
        goContextsFrame = 0
        updateGoContexts(goContextsLine)
      })
    }
    const pruneModelBreakpoints = () => {
      const model = editor.getModel()
      if (model) pruneBreakpointsRef.current?.(uriToPath(model.uri.toString()), model.getLineCount())
    }
    editor.onDidChangeModel(pruneModelBreakpoints)
    editor.onDidChangeModelContent(() => {
      scheduleGoContexts()
      pruneModelBreakpoints()
    })
    pruneModelBreakpoints()
    editor.addAction({
      id: 'gomavo.run-go-test-context',
      label: '运行光标处测试方法或当前测试文件',
      precondition: 'gomavoGoTestFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => { runEditorContextRef.current?.() },
    })
    // GoLand-style ⌥⏎ opens the quick-fix menu: macOS input methods swallow
    // Monaco's built-in ⌘. while a CJK layout is active. editor.action.quickFix
    // is an Action2 invisible to editor.getAction, so trigger the underlying
    // EditorCommand directly.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
      void editor.trigger('gomavo', 'editor.action.codeAction', { kind: 'quickfix' })
    }, '!suggestWidgetVisible')
    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column })
      scheduleGoContexts(event.position.lineNumber)
    })
    editor.onDidChangeModel(() => requestAnimationFrame(applyNavigation))
    const editorHost = editor.getContainerDomNode()
    const prepareContextMenu = (event: MouseEvent) => {
      // Monaco's own context-menu listener is registered before onMount runs.
      // Capture the DOM event so its action preconditions reflect this line
      // on the first right click, including keyboard-triggered menus.
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
      updateGoContexts(target?.position?.lineNumber ?? editor.getPosition()?.lineNumber)
    }
    editorHost.addEventListener('contextmenu', prepareContextMenu, true)
    editor.onDidDispose(() => editorHost.removeEventListener('contextmenu', prepareContextMenu, true))
    // Breakpoint dots overlay the line-number position (GoLand style): slide
    // the glyph-lane dot right by the gutter offset and hide numbers on marked
    // lines so the dot replaces them.
    const applyGutterShift = () => {
      const layout = editor.getLayoutInfo()
      // Center the dot on the start of the (left-aligned) number area.
      const shift = Math.max(0, Math.round(layout.glyphMarginWidth - 8))
      editor.getContainerDomNode().style.setProperty('--mg-bp-shift', `${shift}px`)
    }
    applyGutterShift()
    const layoutObserver = new ResizeObserver(applyGutterShift)
    layoutObserver.observe(editor.getContainerDomNode())
    editor.onDidDispose(() => layoutObserver.disconnect())
    editor.onMouseDown((event) => {
      if (event.event.rightButton) {
        updateGoContexts(event.target.position?.lineNumber ?? editor.getPosition()?.lineNumber)
        return
      }
      const hitElement = event.event.target instanceof Element ? event.event.target : null
      const inGutter = event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
        || event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        || event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
        || (hitElement?.closest('.glyph-margin-widgets, .line-decorations, .margin-view-overlays') != null)
      if (!inGutter) return
      // Folding arrows and our own test-run icons keep their own actions.
      const onFunctionIcon = !!hitElement?.closest('[class*="folding-"], .go-test-gutter, .go-package-gutter')
      const { clientY } = event.event.browserEvent
      // A breakpoint glyph is translated over the line-number lane. Monaco
      // can report no position for that transformed DOM target, so hit-test
      // the same row in the content area instead.
      const contentX = editorHost.getBoundingClientRect().left + editor.getLayoutInfo().contentLeft + 4
      const line = editor.getTargetAtClientPoint(contentX, clientY)?.position?.lineNumber
        ?? event.target.position?.lineNumber
      if (!line) return
      // Test files: the run icons (and the rest of the row, matching the old
      // gutter behavior) run the test under the line. Source files: any click
      // in the gutter row toggles a breakpoint, GoLand-style.
      const model = editor.getModel()
      const path = model ? tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString()) : null
      if (path?.endsWith('_test.go')) {
        if (onFunctionIcon || !path.slice(0, path.lastIndexOf('/')).includes('/')) runEditorContextRef.current?.(line, false)
        else runEditorContextRef.current?.(line, false)
        return
      }
      if (path?.endsWith('.go') && !onFunctionIcon) toggleBreakpointRef.current?.(path, line)
    })
  }, [applyNavigation, installGoNavigation])

  const onSplitEditorMount: OnMount = useCallback((editor, monaco) => {
    splitEditorRef.current = editor
    installGoNavigation(editor, monaco)
    installGoTodoDecorations(editor, monaco)
  }, [installGoNavigation])

  return { beforeEditorMount, onEditorMount, onSplitEditorMount }
}
