import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import type { GitBlameResult } from '../../lib/api'
import { fileUri, uriToPath } from '../../lib/lsp'
import { generateConstructor, generateGetters, goStructs } from '../../lib/goGenerate'
import type { Locale, MessageKey } from '../../lib/i18n'
import { insertGenerated } from '../editorGeneration'
import { isWorkspaceFile } from '../helpers'
import type { OpenFile, PaletteMode } from '../types'
import type { BreakpointSpec } from './useDebugger'

type BreakpointEdit = { path: string; line: number; condition: string; logMessage: string }
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

interface UseEditorActionRegistrationParams {
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  tabsRef: RefObject<OpenFile[]>
  rootRef: RefObject<string | null>
  monacoApi: typeof Monaco | null
  locale: Locale
  t: Translate
  createTestFromEditorRef: RefObject<((line?: number) => void) | null>
  createTestContextLineRef: RefObject<number | null>
  openGitFileHistoryRef: RefObject<((path: string) => void) | null>
  breakpointSpecsRef: RefObject<Record<string, Record<number, BreakpointSpec>>>
  setBreakpointEdit: Dispatch<SetStateAction<BreakpointEdit | null>>
  gitBlame: { path: string; result: GitBlameResult } | null
  setGitBlame: Dispatch<SetStateAction<{ path: string; result: GitBlameResult } | null>>
  openGitBlame: (path: string) => Promise<void>
  toggleBreakpoint: (path: string, line: number) => void
  toggleBookmark: (path: string, line: number) => void
  runFindUsages: () => Promise<void>
  runRefactor: (kinds: string[], prefer?: RegExp) => Promise<void>
  goToImplementationNow: () => Promise<void>
  goToTestNow: () => Promise<void>
  openPalette: (mode?: PaletteMode) => void
}

/** Registers the editor's context menu actions and disposes them on change. */
export function useEditorActionRegistration({
  editorRef, tabsRef, rootRef, monacoApi, locale, t, createTestFromEditorRef,
  createTestContextLineRef, openGitFileHistoryRef, breakpointSpecsRef,
  setBreakpointEdit, gitBlame, setGitBlame, openGitBlame, toggleBreakpoint,
  toggleBookmark, runFindUsages, runRefactor, goToImplementationNow,
  goToTestNow, openPalette,
}: UseEditorActionRegistrationParams): void {
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monacoApi) return
    const methodAction = editor.addAction({
      id: 'gomavo.create-go-method-test',
      label: t('创建测试方法'),
      precondition: 'gomavoGoSourceFile && gomavoGoSourceMethod',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => { createTestFromEditorRef.current?.(createTestContextLineRef.current ?? editor.getPosition()?.lineNumber) },
    })
    const fileAction = editor.addAction({
      id: 'gomavo.create-go-file-tests',
      label: t('创建文件测试方法'),
      precondition: 'gomavoGoSourceFile && !gomavoGoSourceMethod',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => { createTestFromEditorRef.current?.() },
    })
    const historyAction = editor.addAction({
      id: 'gomavo.show-file-git-history',
      label: t('查看文件历史'),
      precondition: 'gomavoGitWorkspaceFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: () => {
        const model = editor.getModel()
        if (!model) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path
        if (path && isWorkspaceFile(rootRef.current, path)) openGitFileHistoryRef.current?.(path)
      },
    })
    const goFileContext = editor.createContextKey<boolean>('gomavoGoAnyFile', false)
    const syncAnyGoFile = () => {
      const model = editor.getModel()
      goFileContext.set(!!model && model.uri.scheme === 'file' && model.uri.path.endsWith('.go'))
    }
    syncAnyGoFile()
    const modelListener = editor.onDidChangeModel(syncAnyGoFile)
    const breakpointAction = editor.addAction({
      id: 'gomavo.toggle-breakpoint',
      label: t('切换断点'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'debug',
      contextMenuOrder: 1,
      // F9 stays unbound here: the global shortcut already handles it, and a
      // Monaco binding would double-fire the toggle (net zero).
      run: (_editor) => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        toggleBreakpoint(path, position.lineNumber)
      },
    })
    const bookmarkAction = editor.addAction({
      id: 'gomavo.toggle-bookmark',
      label: t('切换书签'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 4,
      run: () => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        toggleBookmark(path, position.lineNumber)
      },
    })
    const blameAction = editor.addAction({
      id: 'gomavo.git-blame',
      label: t('Git Blame（按行）'),
      precondition: 'gomavoGitWorkspaceFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 5,
      run: () => {
        const model = editor.getModel()
        if (!model) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path
        if (path && isWorkspaceFile(rootRef.current, path)) {
          if (gitBlame?.path === path) setGitBlame(null)
          else void openGitBlame(path)
        }
      },
    })
    const findUsagesAction = editor.addAction({
      id: 'gomavo.find-usages',
      label: t('查找用法'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 6,
      // No editor keybinding here: the global ⌥F7 shortcut already dispatches
      // through the preferences matcher, and a second binding fires it twice.
      run: () => { void runFindUsages() },
    })
    const extractVariableAction = editor.addAction({
      id: 'gomavo.refactor-extract-variable',
      label: locale === 'zh-CN' ? '重构：提取变量…' : 'Refactor: Extract Variable…',
      precondition: 'gomavoGoAnyFile && !editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
      run: () => { void runRefactor(['refactor.extract.variable', 'refactor.extract.constant'], /variable/i) },
    })
    const extractFunctionAction = editor.addAction({
      id: 'gomavo.refactor-extract-function',
      label: locale === 'zh-CN' ? '重构：提取函数…' : 'Refactor: Extract Function…',
      precondition: 'gomavoGoAnyFile && !editorReadonly',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 3,
      run: () => { void runRefactor(['refactor.extract.function', 'refactor.extract.method']) },
    })
    const goToImplementationAction = editor.addAction({
      id: 'gomavo.go-to-implementation',
      label: t('跳转到实现'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 7,
      run: () => { void goToImplementationNow() },
    })
    const goToTestAction = editor.addAction({
      id: 'gomavo.go-to-test',
      label: t('转到测试（或被测代码）'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 8,
      run: () => { void goToTestNow() },
    })
    const generateAction = editor.addAction({
      id: 'gomavo.generate-menu',
      label: t('Generate 生成…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 0,
      run: () => { openPalette('generate') },
    })
    const editBreakpointAction = editor.addAction({
      id: 'gomavo.edit-breakpoint',
      label: t('编辑断点条件'),
      precondition: 'gomavoGoAnyFile',
      contextMenuGroupId: 'debug',
      contextMenuOrder: 2,
      run: () => {
        const model = editor.getModel()
        const position = editor.getPosition()
        if (!model || !position) return
        const path = tabsRef.current.find((file) => fileUri(file.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString())
        const spec = breakpointSpecsRef.current[path]?.[position.lineNumber]
        setBreakpointEdit({
          path, line: position.lineNumber,
          condition: spec?.condition ?? '',
          logMessage: spec?.logMessage ?? '',
        })
      },
    })
    const constructorAction = editor.addAction({
      id: 'gomavo.generate-constructor',
      label: t('生成构造函数…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 1,
      run: () => insertGenerated(editor, (source) => {
        const structs = goStructs(source)
        if (structs.length !== 1) return null
        return generateConstructor(source, structs[0].name)
      }),
    })
    const gettersAction = editor.addAction({
      id: 'gomavo.generate-getters',
      label: t('生成 Getter 方法…'),
      precondition: 'gomavoGoSourceFile || gomavoGoTestFile',
      contextMenuGroupId: 'generate',
      contextMenuOrder: 2,
      run: () => insertGenerated(editor, (source) => {
        const structs = goStructs(source)
        if (structs.length !== 1) return null
        return generateGetters(source, structs[0].name)
      }),
    })
    return () => {
      methodAction.dispose(); fileAction.dispose(); historyAction.dispose()
      breakpointAction.dispose(); bookmarkAction.dispose(); blameAction.dispose()
      constructorAction.dispose(); gettersAction.dispose(); modelListener.dispose()
      findUsagesAction.dispose(); extractVariableAction.dispose(); extractFunctionAction.dispose()
      goToImplementationAction.dispose(); goToTestAction.dispose()
      generateAction.dispose(); editBreakpointAction.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoApi, t, locale, gitBlame?.path, toggleBreakpoint, toggleBookmark, runFindUsages, runRefactor, goToImplementationNow, goToTestNow])

}
