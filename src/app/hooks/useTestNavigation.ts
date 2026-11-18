import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import { command, displayName, joinPath, type FileEntry } from '../../lib/api'
import { goTestDeclarations } from '../../lib/goTests'
import type { Locale, MessageKey } from '../../lib/i18n'
import type { OpenFile, TaskOptions } from '../types'
import type { useNavigation } from './useNavigation'
import type { useTasks } from './useTasks'
import type { useDebugger } from './useDebugger'

interface UseTestNavigationParams {
  root: string | null
  goModulePath: string | null
  projectFiles: FileEntry[]
  activePathRef: RefObject<string | null>
  tabsRef: RefObject<OpenFile[]>
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  localeRef: RefObject<Locale>
  runOptions: TaskOptions
  startDebug: ReturnType<typeof useDebugger>['startDebug']
  runSelection: ReturnType<typeof useTasks>['runSelection']
  setPendingTestRun: Dispatch<SetStateAction<{ path: string; testName?: string } | null>>
  captureEditorLocation: ReturnType<typeof useNavigation>['captureEditorLocation']
  navigateTo: ReturnType<typeof useNavigation>['navigateTo']
  notify: (text: string, kind?: 'success' | 'error') => void
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

/** Locates test declarations and runs, debugs or opens their source. */
export function useTestNavigation({
  root, goModulePath, projectFiles, activePathRef, tabsRef, editorRef,
  localeRef, runOptions, startDebug, runSelection, setPendingTestRun,
  captureEditorLocation, navigateTo, notify, t,
}: UseTestNavigationParams) {
  /** Debug like GoLand ⌃D: the test under the cursor, the test file, or the package. */
  const debugCurrentContext = useCallback(() => {
    const path = activePathRef.current
    if (!path?.endsWith('.go')) {
      notify(localeRef.current === 'zh-CN' ? '请先打开要调试的 Go 文件。' : 'Open a Go file to debug first.', 'error')
      return
    }
    if (path.endsWith('_test.go')) {
      const editor = editorRef.current
      const line = editor?.getPosition()?.lineNumber
      const declaration = line ? goTestDeclarations(editor!.getModel()!.getValue()).find((item) => item.startLine <= line && line <= item.endLine) : undefined
      void startDebug('test', {
        scope: 'package',
        targetPath: path.slice(0, path.lastIndexOf('/')),
        ...(declaration ? { testName: declaration.name } : {}),
        label: declaration ? `调试 ${declaration.name}` : `调试 ${displayName(path)} 测试`,
        envVars: runOptions.envVars,
        buildTags: runOptions.buildTags || undefined,
      })
      return
    }
    void startDebug('debug', {
      scope: 'file',
      targetPath: path,
      label: `dlv debug ${displayName(path)}`,
      programArgs: runOptions.programArgs,
      envVars: runOptions.envVars,
      buildTags: runOptions.buildTags || undefined,
    })
  }, [displayName, notify, runOptions.buildTags, runOptions.envVars, runOptions.programArgs, startDebug])

  const packageDirectory = useCallback((packageName: string): string | null => {
    if (!root || !goModulePath) return null
    if (packageName === goModulePath) return root
    if (packageName.startsWith(`${goModulePath}/`)) return joinPath(root, packageName.slice(goModulePath.length + 1))
    return null
  }, [goModulePath, root])

  const locateTest = useCallback(async (packageName: string, testName: string) => {
    const baseName = testName.split('/')[0]
    const directory = packageDirectory(packageName)
    const candidates = projectFiles.filter((entry) => entry.name.endsWith('_test.go') && (!directory || entry.path.slice(0, -entry.name.length - 1) === directory))
    for (const entry of candidates) {
      try {
        const content = tabsRef.current.find((file) => file.path === entry.path)?.content ?? await command<string>('read_file', { path: entry.path })
        const declaration = goTestDeclarations(content).find((item) => item.name === baseName)
        if (declaration) return { path: entry.path, line: declaration.startLine }
      } catch { /* Continue with the remaining test files. */ }
    }
    return null
  }, [packageDirectory, projectFiles])

  const jumpToTest = useCallback(async (packageName: string, testName: string) => {
    const from = captureEditorLocation()
    const source = await locateTest(packageName, testName)
    if (!source) { notify(`未找到 ${testName} 的测试源码。`, 'error'); return }
    await navigateTo({ ...source, column: 6 }, from)
  }, [captureEditorLocation, locateTest, navigateTo, notify])

  const rerunTest = useCallback(async (packageName: string, testName: string) => {
    const source = await locateTest(packageName, testName)
    if (!source) { notify(`未找到 ${testName} 的测试源码。`, 'error'); return }
    const started = await runSelection('test', { scope: 'file', targetPath: source.path, testName, label: t('测试 {name}', { name: testName }) })
    if (started) setPendingTestRun({ path: source.path, testName })
  }, [locateTest, notify, runSelection])

  return { debugCurrentContext, packageDirectory, jumpToTest, rerunTest }
}
