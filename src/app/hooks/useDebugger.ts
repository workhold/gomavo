import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { desktopAvailable } from '../../lib/api'
import { DapClient, type DapStackFrame, type DapThread, type DapVariable } from '../../lib/debug/dapClient'
import type { PanelView, TaskOptions } from '../types'
import type { MessageKey } from '../../lib/i18n'

export type DebuggerState = 'idle' | 'starting' | 'running' | 'stopped' | 'stopping'

export interface DebuggerFrame extends DapStackFrame {
  /** Variables grouped by scope, fetched lazily for the selected frame. */
  scopesLoaded: boolean
}

export interface DebuggerVariable extends DapVariable {
  children?: DebuggerVariable[]
  expanded?: boolean
}

export interface DebugConsoleLine {
  id: number
  category: string
  text: string
}

export interface UseDebuggerParams {
  root: string | null
  rootRef: RefObject<string | null>
  /** Live breakpoint map: absolute path → line numbers. */
  breakpointsRef: RefObject<Record<string, number[]>>
  setPanelOpen: (value: boolean | ((current: boolean) => boolean)) => void
  setPanelView: (value: PanelView) => void
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

interface StoppedEvent {
  reason: string
  description?: string
  threadId?: number
  allThreadsStopped?: boolean
}

/** Delve debugging: session lifecycle, breakpoints, stepping, and inspection. */
export function useDebugger(params: UseDebuggerParams) {
  const { root, rootRef, breakpointsRef, setPanelOpen, setPanelView, notify, formatError, t } = params
  const [state, setState] = useState<DebuggerState>('idle')
  const [frames, setFrames] = useState<DebuggerFrame[]>([])
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0)
  const [variables, setVariables] = useState<DebuggerVariable[]>([])
  const [threads, setThreads] = useState<DapThread[]>([])
  const [currentThreadId, setCurrentThreadId] = useState<number | null>(null)
  const [consoleLines, setConsoleLines] = useState<DebugConsoleLine[]>([])
  const [currentLocation, setCurrentLocation] = useState<{ path: string; line: number; column: number } | null>(null)
  const clientRef = useRef<DapClient | null>(null)
  const consoleIdRef = useRef(0)
  const configurationDoneRef = useRef(false)
  const stoppedRef = useRef(false)

  const addConsole = useCallback((category: string, text: string) => {
    setConsoleLines((current) => [...current, { id: ++consoleIdRef.current, category, text }].slice(-500))
  }, [])

  const loadFrames = useCallback(async (threadId: number, client: DapClient) => {
    const stack = await client.request<{ stackFrames: DapStackFrame[] }>('stackTrace', { threadId, levels: 0, startFrame: 0 })
    setFrames((stack.stackFrames ?? []).map((frame) => ({ ...frame, scopesLoaded: false })))
    setSelectedFrameIndex(0)
    const top = stack.stackFrames?.[0]
    if (top?.source?.path) {
      setCurrentLocation({ path: top.source.path, line: top.line, column: top.column })
    }
    const scopes = await client.request<{ scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> }>('scopes', { frameId: top?.id ?? 0 })
    const locals = scopes.scopes?.filter((scope) => !scope.expensive).slice(0, 2) ?? []
    const groups: DebuggerVariable[] = []
    for (const scope of locals) {
      const response = await client.request<{ variables: DapVariable[] }>('variables', { variablesReference: scope.variablesReference })
      groups.push({
        name: scope.name,
        value: '',
        variablesReference: scope.variablesReference,
        children: (response.variables ?? []).map((variable) => ({ ...variable, children: variable.variablesReference > 0 ? [] : undefined })),
      })
    }
    setVariables(groups)
  }, [])

  const fetchVariables = useCallback(async (reference: number, client: DapClient): Promise<DebuggerVariable[]> => {
    const response = await client.request<{ variables: DapVariable[] }>('variables', { variablesReference: reference })
    return (response.variables ?? []).map((variable) => ({ ...variable, children: variable.variablesReference > 0 ? [] : undefined }))
  }, [])

  const handleEvent = useCallback((event: string, body: unknown) => {
    const client = clientRef.current
    if (!client) return
    switch (event) {
      case 'initialized': {
        // Push the full breakpoint map now that the adapter is ready.
        const breakpoints = breakpointsRef.current ?? {}
        void (async () => {
          try {
            for (const [path, lines] of Object.entries(breakpoints)) {
              if (!lines.length) continue
              await client.request('setBreakpoints', {
                source: { path },
                lines,
                breakpoints: lines.map((line) => ({ line })),
              })
            }
            await client.request('setExceptionBreakpoints', { filters: [] })
            await client.request('configurationDone', {})
            configurationDoneRef.current = true
          } catch (cause) {
            notify(formatError(cause), 'error')
          }
        })()
        break
      }
      case 'stopped': {
        const stopped = body as StoppedEvent
        const threadId = stopped.threadId ?? currentThreadId ?? 1
        void (async () => {
          try {
            const response = await client.request<{ threads: DapThread[] }>('threads', {})
            setThreads(response.threads ?? [])
            const active = response.threads?.find((thread) => thread.id === threadId) ?? response.threads?.[0]
            const resolved = active?.id ?? threadId
            setCurrentThreadId(resolved)
            setState('stopped')
            await loadFrames(resolved, client)
            const message = stopped.description ?? (stopped.reason === 'break' ? t('命中断点') : stopped.reason)
            addConsole('status', message)
          } catch (cause) {
            notify(formatError(cause), 'error')
          }
        })()
        break
      }
      case 'continued':
        setState('running')
        setCurrentLocation(null)
        setVariables([])
        setFrames([])
        break
      case 'thread': {
        const thread = body as { reason: string; threadId?: number }
        if (thread.reason === 'started' && thread.threadId !== undefined) {
          void client.request<{ threads: DapThread[] }>('threads', {})
            .then((response) => setThreads(response.threads ?? []))
            .catch(() => undefined)
        }
        break
      }
      case 'output': {
        const output = body as { category?: string; output?: string }
        if (output.output) addConsole(output.category ?? 'console', output.output.replace(/\n$/, ''))
        break
      }
      case 'terminated':
      case 'exited':
        void cleanup('idle')
        break
      default:
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addConsole, breakpointsRef, currentThreadId, formatError, loadFrames, notify, t])

  const cleanup = useCallback(async (nextState: DebuggerState) => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    const client = clientRef.current
    clientRef.current = null
    configurationDoneRef.current = false
    if (client) await client.stop()
    setState(nextState)
    setFrames([])
    setVariables([])
    setThreads([])
    setCurrentThreadId(null)
    setCurrentLocation(null)
  }, [])

  const startDebug = useCallback(async (mode: 'debug' | 'test', options: TaskOptions = {}) => {
    const workspace = rootRef.current
    if (!workspace || clientRef.current) return
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    stoppedRef.current = false
    setState('starting')
    setPanelOpen(true)
    setPanelView('debug')
    setConsoleLines([])
    const client = new DapClient(handleEvent, (line) => addConsole('dlv', line), () => {
      void cleanup('idle')
      notify(t('调试会话已结束。'))
    })
    try {
      await client.start(workspace)
      clientRef.current = client
      await client.request('initialize', {
        adapterID: 'delve',
        clientID: 'mgland',
        clientName: 'MGLand',
        locale: 'en',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
      })
      // Resolve the program directory the same way run configurations do.
      const target = options.targetPath
      const program = options.scope === 'file' && target?.endsWith('.go')
        ? target.slice(0, target.lastIndexOf('/'))
        : options.scope === 'package' || options.scope === 'directory'
          ? target ?? workspace
          : workspace
      await client.request('launch', {
        request: 'launch',
        mode,
        program,
        ...(options.testName ? { testName: options.testName } : {}),
        ...(options.programArgs?.length ? { args: options.programArgs } : {}),
        ...(options.buildTags ? { buildFlags: `-tags ${options.buildTags}` } : {}),
        ...(options.envVars && Object.keys(options.envVars).length ? { env: options.envVars } : {}),
        stopOnEntry: false,
        dlvFlags: [],
      })
      setState('running')
    } catch (cause) {
      await cleanup('idle')
      notify(formatError(cause), 'error')
    }
  }, [addConsole, cleanup, formatError, handleEvent, notify, rootRef, setPanelOpen, setPanelView, t])

  const control = useCallback(async (commandName: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'disconnect', threadIdOverride?: number) => {
    const client = clientRef.current
    if (!client) return
    const threadId = threadIdOverride ?? currentThreadId ?? 1
    try {
      if (commandName === 'disconnect') {
        setState('stopping')
        await client.request('disconnect', { terminateDebuggee: true })
        await cleanup('idle')
        return
      }
      await client.request(commandName, { threadId })
      if (commandName === 'continue') setState('running')
    } catch (cause) {
      notify(formatError(cause), 'error')
    }
  }, [cleanup, currentThreadId, formatError, notify])

  /** Sync one file's breakpoints with a live session. */
  const syncBreakpoints = useCallback(async (path: string, lines: number[]) => {
    const client = clientRef.current
    if (!client || !configurationDoneRef.current) return
    try {
      await client.request('setBreakpoints', {
        source: { path },
        lines,
        breakpoints: lines.map((line) => ({ line })),
      })
    } catch { /* a stale session logs to the console instead */ }
  }, [])

  /** Expand one variable node by fetching its children. */
  const expandVariable = useCallback(async (groupIndex: number, path: number[]) => {
    const client = clientRef.current
    if (!client) return
    setVariables((current) => {
      const next = [...current]
      let level = next[groupIndex].children ?? []
      let parent = next[groupIndex]
      for (const index of path) {
        parent = level[index]
        level = parent.children ?? []
      }
      // Mutating nested state directly is fine here because the array shells
      // are copied; the callback below refreshes children asynchronously.
      void (async () => {
        const children = await fetchVariables(parent.variablesReference, client)
        parent.children = children
        parent.expanded = true
        setVariables([...next])
      })()
      return next
    })
  }, [fetchVariables])

  useEffect(() => {
    if (!root) void cleanup('idle')
  }, [root, cleanup])

  useEffect(() => () => { void clientRef.current?.stop() }, [])

  return {
    debugState: state,
    debugFrames: frames,
    debugVariables: variables,
    debugThreads: threads,
    debugCurrentThreadId: currentThreadId,
    debugConsole: consoleLines,
    debugLocation: currentLocation,
    debugClientActive: () => !!clientRef.current,
    startDebug,
    debugControl: control,
    syncBreakpoints,
    expandVariable,
    selectFrame: (index: number) => {
      setSelectedFrameIndex(index)
      const frame = frames[index]
      if (frame?.source?.path) setCurrentLocation({ path: frame.source.path, line: frame.line, column: frame.column })
    },
    debugSelectedFrameIndex: selectedFrameIndex,
    resetDebugger: () => { void cleanup('idle') },
  }
}
