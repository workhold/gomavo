import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import { relativePath, type CoverageProfile, type GitBlameResult } from '../../lib/api'
import { fileUri, uriToPath } from '../../lib/lsp'
import { goTestDeclarations } from '../../lib/goTests'
import { coverageRanges } from '../../lib/coverage'
import { editorConfigIndentOptions } from '../../lib/editorConfig'
import { validBreakpointLines } from '../../lib/debug/breakpoints'
import type { Preferences } from '../../lib/preferences'
import type { OpenFile, TaskOptions, TestResult } from '../types'
import type { useDebugger } from './useDebugger'

interface UseEditorDecorationsParams {
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  tabsRef: RefObject<OpenFile[]>
  monacoApi: typeof Monaco | null
  activeFile: OpenFile | null
  editorPreferences: Preferences['editor']
  runningTask: string | null
  setPendingTestRun: Dispatch<SetStateAction<{ path: string; testName?: string } | null>>
  activePackageLine: number | null
  activeTestDeclarations: ReturnType<typeof goTestDeclarations>
  packageDirectory: (packageName: string) => string | null
  lastTestOptionsRef: RefObject<TaskOptions>
  testResults: TestResult[]
  pendingTestRun: { path: string; testName?: string } | null
  breakpoints: Record<string, number[]>
  bookmarks: Record<string, number[]>
  coverageProfile: CoverageProfile | null
  gitBlame: { path: string; result: GitBlameResult } | null
  debugLocation: ReturnType<typeof useDebugger>['debugLocation']
  root: string | null
}

/** Keeps Monaco indentation, test gutter and editor line decorations current. */
export function useEditorDecorations({
  editorRef, tabsRef, monacoApi, activeFile, editorPreferences,
  runningTask, setPendingTestRun, activePackageLine, activeTestDeclarations,
  packageDirectory, lastTestOptionsRef, testResults, pendingTestRun,
  breakpoints, bookmarks, coverageProfile, gitBlame, debugLocation, root,
}: UseEditorDecorationsParams): void {
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !monacoApi) return
    const applyIndentOptions = () => {
      const model = editor.getModel()
      if (!model) return
      const file = tabsRef.current.find((item) => fileUri(item.path) === model.uri.toString())
      model.updateOptions(editorConfigIndentOptions(file?.editorConfig ?? {}, editorPreferences))
    }
    applyIndentOptions()
    const modelChange = editor.onDidChangeModel(applyIndentOptions)
    return () => modelChange.dispose()
  }, [activeFile?.editorConfig, activeFile?.path, monacoApi, editorPreferences])

  // A pending gutter run clears when the task exits; per-test `run` events take
  // over the spinner as soon as `go test` starts reporting.
  useEffect(() => { if (!runningTask) setPendingTestRun(null) }, [runningTask])

  useEffect(() => {
    if (!activeFile?.path.endsWith('_test.go') || !editorRef.current || !monacoApi) return
    const editor = editorRef.current
    const directory = activeFile.path.slice(0, activeFile.path.lastIndexOf('/'))
    let packageName = testResults.find((result) => packageDirectory(result.package) === directory)?.package
    if (!packageName) {
      const lastRun = lastTestOptionsRef.current
      const onePackage = [...new Set(testResults.map((result) => result.package))]
      if (onePackage.length === 1 && ((lastRun.scope === 'file' && lastRun.targetPath === activeFile.path) || (lastRun.scope === 'package' && lastRun.targetPath === directory))) packageName = onePackage[0]
    }
    const resultByName = new Map(testResults.filter((result) => result.package === packageName && result.name !== '(package)').map((result) => [result.name, result.status]))
    const pending = pendingTestRun?.path === activeFile.path ? pendingTestRun : null
    const decorations = editor.createDecorationsCollection([])
    const update = () => {
      const model = editor.getModel()
      if (!model || model.uri.toString() !== fileUri(activeFile.path)) { decorations.clear(); return }
      const matches: Monaco.editor.IModelDeltaDecoration[] = []
      // Monaco's code-action lightbulb uses the left lane; sharing it keeps the margin one lane wide.
      if (activePackageLine) {
        const loading = !!pending && !pending.testName
        matches.push({ range: new monacoApi.Range(activePackageLine, 1, activePackageLine, 1), options: { glyphMarginClassName: `go-package-gutter${loading ? ' go-test-loading' : ''}`, glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left }, zIndex: 10 } })
      }
      for (const declaration of activeTestDeclarations) {
        const status = resultByName.get(declaration.name)
        const loading = status === 'run' || (!!pending && (!pending.testName || pending.testName === declaration.name))
        const state = status && status !== 'run' ? ` go-test-${status}` : loading ? ' go-test-loading' : ''
        matches.push({ range: new monacoApi.Range(declaration.startLine, 1, declaration.startLine, 1), options: { glyphMarginClassName: `go-test-gutter${state}`, glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left }, zIndex: 10 } })
      }
      decorations.set(matches)
    }
    const modelChange = editor.onDidChangeModel(update)
    const frame = requestAnimationFrame(update)
    return () => { cancelAnimationFrame(frame); modelChange.dispose(); decorations.clear() }
  }, [activeFile?.path, activePackageLine, activeTestDeclarations, monacoApi, packageDirectory, pendingTestRun, testResults])

  // Editor chrome decorations: breakpoints share the left glyph lane with the
  // test gutter (keeping the margin one lane wide); bookmarks, coverage, blame,
  // and the current debug position use line decorations and line styles.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !monacoApi) return
    const path = uriToPath(model.uri.toString())
    const matches: Monaco.editor.IModelDeltaDecoration[] = []
    for (const line of validBreakpointLines(breakpoints[path] ?? [], model.getLineCount())) {
      matches.push({
        range: new monacoApi.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'debug-breakpoint-gutter',
          glyphMargin: { position: monacoApi.editor.GlyphMarginLane.Left },
          zIndex: 20,
          glyphMarginHoverMessage: { value: '点击切换断点（F9）' },
        },
      })
    }
    for (const line of bookmarks[path] ?? []) {
      matches.push({
        range: new monacoApi.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'bookmark-line',
          linesDecorationsClassName: 'bookmark-mark',
          overviewRuler: { color: '#D9B783', position: monacoApi.editor.OverviewRulerLane.Right },
        },
      })
    }
    if (coverageProfile && activeFile && activeFile.path === path) {
      const profileFile = coverageProfile.files.find((file) => file.path === path || file.path.endsWith(`/${relativePath(root ?? '', path)}`) || path.endsWith(`/${file.path}`))
      if (profileFile) {
        for (const range of coverageRanges(profileFile.blocks)) {
          matches.push({
            range: new monacoApi.Range(range.startLine, 1, range.endLine, 1),
            options: { isWholeLine: true, className: range.covered ? 'coverage-covered' : 'coverage-uncovered' },
          })
        }
      }
    }
    if (gitBlame && gitBlame.path === path) {
      for (const line of gitBlame.result.lines) {
        const commit = gitBlame.result.commits[line.hash]
        if (!commit) continue
        matches.push({
          range: new monacoApi.Range(line.line, 1, line.line, 1),
          options: {
            linesDecorationsClassName: 'blame-mark',
            overviewRuler: { color: '#69BDF1', position: monacoApi.editor.OverviewRulerLane.Right },
            hoverMessage: { value: `${commit.author} · ${commit.date.slice(0, 10)} · ${commit.summary} (${commit.shortHash})` },
          },
        })
      }
    }
    if (debugLocation && debugLocation.path === path) {
      matches.push({
        range: new monacoApi.Range(debugLocation.line, 1, debugLocation.line, 1),
        options: {
          isWholeLine: true,
          className: 'debug-current-line',
          linesDecorationsClassName: 'debug-current-arrow',
          zIndex: 30,
        },
      })
    }
    const decorations = editor.createDecorationsCollection(matches)
    return () => decorations.clear()
  }, [activeFile?.path, breakpoints, bookmarks, coverageProfile, debugLocation, gitBlame, monacoApi, root])

}
