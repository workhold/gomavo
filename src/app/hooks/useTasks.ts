import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { command, desktopAvailable, displayName, type CoverageProfile, type TaskExit, type TaskOutput } from '../../lib/api'
import { translate, type MessageKey } from '../../lib/i18n'
import type { Locale } from '../../lib/i18n'
import { TASK_LABELS } from '../constants'
import type { GoTestEvent, OpenFile, OutputLine, PanelView, TaskOptions, TestResult } from '../types'

export type TestOutputByCase = Map<string, OutputLine[]>

export interface UseTasksParams {
  root: string | null
  rootRef: RefObject<string | null>
  tabsRef: RefObject<OpenFile[]>
  workspaceGenerationRef: RefObject<number>
  localeRef: RefObject<Locale>
  saveBeforeRun: boolean
  /** Assigned during render after `saveFile` is defined; breaks the hook/App dependency cycle. */
  saveFileRef: RefObject<((path: string) => Promise<boolean>) | null>
  refreshTools: () => Promise<void>
  refreshGit: (workspace: string, options?: { refreshIgnored?: boolean }) => Promise<void>
  refreshDirectory: (path: string) => Promise<void>
  refreshProjectFiles: (workspace: string) => Promise<void>
  reloadCleanTabs: () => Promise<void>
  setPanelOpen: (value: boolean | ((current: boolean) => boolean)) => void
  setPanelView: (value: PanelView) => void
  setModuleMenu: (value: boolean) => void
  setConfigMenu: (value: boolean) => void
  setRunConfig: (value: 'run' | 'test' | 'build') => void
  setRunOptions: (value: TaskOptions) => void
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

/** Go task execution: run/test/build/fmt output streams, test result trees and cancellation. */
export function useTasks(params: UseTasksParams) {
  const {
    root, rootRef, tabsRef, workspaceGenerationRef, localeRef, saveBeforeRun, saveFileRef,
    refreshTools, refreshGit, refreshDirectory, refreshProjectFiles, reloadCleanTabs,
    setPanelOpen, setPanelView, setModuleMenu, setConfigMenu, setRunConfig, setRunOptions,
    notify, formatError, t,
  } = params
  const [output, setOutput] = useState<OutputLine[]>([])
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [testOutput, setTestOutput] = useState<OutputLine[]>([])
  const [testOutputByCase, setTestOutputByCase] = useState<TestOutputByCase>(new Map())
  const [coverageProfile, setCoverageProfile] = useState<CoverageProfile | null>(null)
  const outputIdRef = useRef(0)
  const [runningTask, setRunningTask] = useState<string | null>(null)
  const completedTasksRef = useRef<Set<string>>(new Set())
  const ignoredTaskIdsRef = useRef<Set<string>>(new Set())
  const activeTaskRef = useRef<string | null>(null)
  const launchingTaskRef = useRef(false)
  const currentTaskKindRef = useRef<string | null>(null)
  const lastTestOptionsRef = useRef<TaskOptions>({})
  /** Resolvers waiting for a task id to exit, plus the codes already seen. */
  const taskExitWaitersRef = useRef(new Map<string, Array<(code: number) => void>>())
  const taskExitCodesRef = useRef(new Map<string, number>())

  const addOutput = useCallback((text: string, stream: OutputLine['stream']) => {
    setOutput((current) => [...current, { id: ++outputIdRef.current, text, stream }].slice(-2500))
  }, [])

  const recordTestEvent = useCallback((event: GoTestEvent) => {
    if (event.Package && (event.Action === 'run' || event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip')) {
      const name = event.Test || '(package)'
      const status = event.Action as TestResult['status']
      setTestResults((current) => {
        // go test -json emits a "run" event for benchmarks but no per-benchmark
        // "pass" event. Resolve them when the package finishes.
        const settled = name === '(package)' && (status === 'pass' || status === 'fail')
          ? current.map((item) => item.package === event.Package && item.status === 'run' ? { ...item, status } : item)
          : current
        const index = settled.findIndex((item) => item.package === event.Package && item.name === name)
        const result: TestResult = { package: event.Package!, name, status, elapsed: event.Elapsed }
        if (index < 0) return [...settled, result]
        return settled.map((item, itemIndex) => itemIndex === index ? result : item)
      })
    }
    if (event.Output) {
      const text = event.Output.trimEnd()
      const stream: OutputLine['stream'] = event.Action === 'fail' ? 'stderr' : 'stdout'
      if (text) {
        const id = ++outputIdRef.current
        setTestOutput((current) => [...current, { id, text, stream }].slice(-2000))
        // Group output under the running test so the tree can show per-case
        // logs; package-level output lands under the package key.
        if (event.Package) {
          const key = `${event.Package}::${event.Test ?? ''}`
          setTestOutputByCase((current) => {
            const next = new Map(current)
            next.set(key, [...(next.get(key) ?? []), { id, text, stream }].slice(-400))
            return next
          })
        }
      }
    }
  }, [])

  /** Launches a task; resolves true only when the task actually started, so callers can show pending UI. */
  const runTask = useCallback(async (task: string, options: TaskOptions = {}): Promise<boolean> => {
    if (!root || launchingTaskRef.current || activeTaskRef.current || runningTask) return false
    if (task === 'test') lastTestOptionsRef.current = options
    const workspaceGeneration = workspaceGenerationRef.current
    launchingTaskRef.current = true
    currentTaskKindRef.current = task
    setModuleMenu(false)
    setConfigMenu(false)
    setPanelOpen(true)
    setPanelView(task === 'test' ? 'tests' : 'output')
    if (task === 'test') { setTestResults([]); setTestOutput([]); setTestOutputByCase(new Map()) }
    if (options.coverage) setCoverageProfile(null)
    addOutput(`❯ ${options.label ?? (TASK_LABELS[task] ? t(TASK_LABELS[task]) : task)} · ${options.targetPath ?? root}`, 'meta')
    try {
      if (task !== 'install_gopls' && saveBeforeRun) {
        for (const file of tabsRef.current?.filter((item) => item.content !== item.savedContent) ?? []) {
          if (!await saveFileRef.current?.(file.path)) throw new Error(t('保存 {name} 失败，任务已取消。', { name: displayName(file.path) }))
        }
      }
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      const hasExtras = options.programArgs !== undefined
        || options.envVars !== undefined
        || options.buildTags !== undefined
        || options.race !== undefined
        || options.coverage !== undefined
        || options.module !== undefined
        || options.bench !== undefined
      const id = await command<string>('run_go_task', {
        root, task,
        ...(task === 'run' || task === 'test' ? { scope: options.scope, targetPath: options.targetPath, testName: options.testName } : {}),
        ...(hasExtras ? {
          extras: {
            ...(options.programArgs !== undefined ? { programArgs: options.programArgs } : {}),
            ...(options.envVars !== undefined ? { envVars: options.envVars } : {}),
            ...(options.buildTags !== undefined ? { buildTags: options.buildTags } : {}),
            ...(options.race !== undefined ? { race: options.race } : {}),
            ...(options.coverage !== undefined ? { coverage: options.coverage } : {}),
            ...(options.module !== undefined ? { module: options.module } : {}),
            ...(options.bench !== undefined ? { bench: options.bench } : {}),
          },
        } : {}),
      })
      if (workspaceGeneration !== workspaceGenerationRef.current) {
        ignoredTaskIdsRef.current.add(id)
        void command('task_cancel', { id }).catch(() => undefined)
        return false
      }
      if (completedTasksRef.current.has(id)) { completedTasksRef.current.delete(id); currentTaskKindRef.current = null; return false }
      activeTaskRef.current = id
      setRunningTask(id)
      return true
    } catch (cause) { currentTaskKindRef.current = null; const message = formatError(cause); addOutput(message, 'stderr'); notify(message, 'error'); return false }
    finally { launchingTaskRef.current = false }
  }, [addOutput, formatError, notify, root, runningTask, saveBeforeRun, saveFileRef, setConfigMenu, setModuleMenu, setPanelOpen, setPanelView, t, tabsRef, workspaceGenerationRef])

  const runSelection = useCallback((task: 'run' | 'test' | 'build', options: TaskOptions = {}): Promise<boolean> => {
    setRunConfig(task)
    setRunOptions(options)
    return runTask(task, options)
  }, [runTask, setRunConfig, setRunOptions])

  useEffect(() => {
    if (!desktopAvailable) return
    let outputUnlisten: UnlistenFn | undefined
    let exitUnlisten: UnlistenFn | undefined
    let cancelled = false
    const target = getCurrentWebviewWindow().label
    void Promise.all([
      listen<TaskOutput>('task-output', ({ payload }) => {
        if (ignoredTaskIdsRef.current.has(payload.id)) return
        try {
          const event = JSON.parse(payload.line) as GoTestEvent
          if (event && event.Action && event.Package) { recordTestEvent(event); return }
        } catch { /* Ordinary Go output is plain text. */ }
        addOutput(payload.line, payload.stream === 'stderr' ? 'stderr' : 'stdout')
        if (currentTaskKindRef.current === 'test') {
          const stream: OutputLine['stream'] = payload.stream === 'stderr' ? 'stderr' : 'stdout'
          setTestOutput((current) => [...current, { id: ++outputIdRef.current, text: payload.line, stream }].slice(-2000))
        }
      }, { target }),
      listen<TaskExit>('task-exit', ({ payload }) => {
        taskExitCodesRef.current.set(payload.id, payload.code ?? -1)
        const waiters = taskExitWaitersRef.current.get(payload.id)
        if (waiters) {
          taskExitWaitersRef.current.delete(payload.id)
          for (const waiter of waiters) waiter(payload.code ?? -1)
        }
        if (ignoredTaskIdsRef.current.delete(payload.id)) { completedTasksRef.current.delete(payload.id); return }
        completedTasksRef.current.add(payload.id)
        if (activeTaskRef.current === payload.id) { activeTaskRef.current = null; currentTaskKindRef.current = null }
        if (payload.coverage) setCoverageProfile(payload.coverage)
        const tr = (key: MessageKey, values?: Record<string, string | number>) => translate(localeRef.current, key, values)
        addOutput(tr('任务结束 · {result}', { result: payload.code === 0 ? tr('成功') : tr('退出码 {code}', { code: payload.code ?? tr('未知') }) }), payload.code === 0 ? 'meta' : 'stderr')
        setRunningTask((current) => {
          if (current === payload.id) { completedTasksRef.current.delete(payload.id); return null }
          return current
        })
        void refreshTools()
        const currentRoot = rootRef.current
        if (currentRoot) { void refreshGit(currentRoot); void refreshDirectory(currentRoot); void refreshProjectFiles(currentRoot); void reloadCleanTabs() }
      }, { target }),
    ]).then(([offOutput, offExit]) => {
      if (cancelled) { offOutput(); offExit() }
      else { outputUnlisten = offOutput; exitUnlisten = offExit }
    }).catch((cause) => notify(formatError(cause), 'error'))
    return () => { cancelled = true; outputUnlisten?.(); exitUnlisten?.() }
  }, [addOutput, formatError, notify, recordTestEvent, refreshDirectory, refreshGit, refreshProjectFiles, refreshTools, reloadCleanTabs])

  /** Workspace switch: orphan the active task and clear output state. */
  const reset = useCallback(() => {
    if (activeTaskRef.current) ignoredTaskIdsRef.current.add(activeTaskRef.current)
    activeTaskRef.current = null
    currentTaskKindRef.current = null
    setRunningTask(null)
    setOutput([])
    setTestResults([])
    setTestOutput([])
    setTestOutputByCase(new Map())
    setCoverageProfile(null)
  }, [])

  /**
   * Run a task and wait for its exit: `before launch` chains (go mod tidy →
   * go test) need the first task finished before the second starts.
   */
  const runTaskAwaiting = useCallback(async (task: string, options: TaskOptions = {}): Promise<boolean> => {
    const started = await runTask(task, options)
    if (!started) return false
    const id = activeTaskRef.current
    if (!id) return true
    const done = taskExitCodesRef.current.get(id)
    if (done !== undefined) return done === 0
    return await new Promise<boolean>((resolve) => {
      const list = taskExitWaitersRef.current.get(id) ?? []
      list.push((code) => resolve(code === 0))
      taskExitWaitersRef.current.set(id, list)
    })
  }, [runTask])

  return {
    output, setOutput, testResults, testOutput, testOutputByCase, coverageProfile, setCoverageProfile,
    runningTask, lastTestOptionsRef, addOutput, recordTestEvent, runTask, runTaskAwaiting, runSelection, reset,
  }
}
