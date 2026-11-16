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

/** Extra breakpoint behavior beyond "stop here". */
export interface BreakpointSpec {
  /** DAP `condition`: stop only when the expression is truthy. */
  condition?: string
  /** DAP `logMessage`: log instead of stopping (`{expr}` interpolates). */
  logMessage?: string
}

export interface WatchEntry {
  id: number
  expression: string
  /** Evaluated result at the selected frame; refreshed on every stop. */
  value: string
  failed?: boolean
}

export interface UseDebuggerParams {
  root: string | null
  rootRef: RefObject<string | null>
  /** Live breakpoint map: absolute path → line numbers. */
  breakpointsRef: RefObject<Record<string, number[]>>
  /** Per-breakpoint condition/logMessage specs, keyed path → line → spec. */
  breakpointSpecsRef: RefObject<Record<string, Record<number, BreakpointSpec>>>
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
  const { root, rootRef, breakpointsRef, breakpointSpecsRef, setPanelOpen, setPanelView, notify, formatError, t } = params
  const [state, setState] = useState<DebuggerState>('idle')
  const [frames, setFrames] = useState<DebuggerFrame[]>([])
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0)
  const [variables, setVariables] = useState<DebuggerVariable[]>([])
  const [threads, setThreads] = useState<DapThread[]>([])
  const [currentThreadId, setCurrentThreadId] = useState<number | null>(null)
  const [consoleLines, setConsoleLines] = useState<DebugConsoleLine[]>([])
  const [currentLocation, setCurrentLocation] = useState<{ path: string; line: number; column: number } | null>(null)
  const [watches, setWatches] = useState<WatchEntry[]>([])
  const clientRef = useRef<DapClient | null>(null)
  const consoleIdRef = useRef(0)
  const configurationDoneRef = useRef(false)
  const stoppedRef = useRef(false)
  const watchIdRef = useRef(0)
  const selectedFrameIndexRef = useRef(0)
  selectedFrameIndexRef.current = selectedFrameIndex
  const watchesRef = useRef<WatchEntry[]>([])
  watchesRef.current = watches
  /** Most recent top-frame id, kept for late watch additions while stopped. */
  const topFrameIdRef = useRef<number | null>(null)

  const addConsole = useCallback((category: string, text: string) => {
    setConsoleLines((current) => [...current, { id: ++consoleIdRef.current, category, text }].slice(-500))
  }, [])

  /** DAP breakpoint payload for one line, enriched with its condition/logMessage spec. */
  const specFor = useCallback((path: string, line: number): BreakpointSpec => {
    return breakpointSpecsRef.current?.[path]?.[line] ?? {}
  }, [breakpointSpecsRef])

  const loadFrames = useCallback(async (threadId: number, client: DapClient): Promise<number | null> => {
    const stack = await client.request<{ stackFrames: DapStackFrame[] }>('stackTrace', { threadId, levels: 0, startFrame: 0 })
    setFrames((stack.stackFrames ?? []).map((frame) => ({ ...frame, scopesLoaded: false })))
    setSelectedFrameIndex(0)
    const top = stack.stackFrames?.[0]
    topFrameIdRef.current = top?.id ?? null
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
    return top?.id ?? null
  }, [])

  const fetchVariables = useCallback(async (reference: number, client: DapClient): Promise<DebuggerVariable[]> => {
    const response = await client.request<{ variables: DapVariable[] }>('variables', { variablesReference: reference })
    return (response.variables ?? []).map((variable) => ({ ...variable, children: variable.variablesReference > 0 ? [] : undefined }))
  }, [])

  /** Re-evaluate every watch expression at the given stack frame. */
  const refreshWatches = useCallback(async (client: DapClient, frameId: number | null) => {
    const entries = watchesRef.current
    if (!entries.length) return
    const results = await Promise.all(entries.map(async (entry) => {
      try {
        const response = await client.request<{ result: string; succeeded?: boolean }>('evaluate', {
          expression: entry.expression,
          ...(frameId !== null ? { frameId } : {}),
          context: 'watch',
          format: { hex: false },
        })
        return { id: entry.id, expression: entry.expression, value: response.result ?? '' }
      } catch (cause) {
        return { id: entry.id, expression: entry.expression, value: cause instanceof Error ? cause.message : String(cause), failed: true }
      }
    }))
    setWatches(results)
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
                breakpoints: lines.map((line) => {
                  const spec = specFor(path, line)
                  return {
                    line,
                    ...(spec.condition ? { condition: spec.condition } : {}),
                    ...(spec.logMessage ? { logMessage: spec.logMessage } : {}),
                  }
                }),
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
            const topFrameId = await loadFrames(resolved, client)
            await refreshWatches(client, topFrameId)
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
  }, [addConsole, breakpointsRef, currentThreadId, formatError, loadFrames, notify, refreshWatches, specFor, t])

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
    topFrameIdRef.current = null
    setWatches((current) => current.map((entry) => ({ ...entry, value: '', failed: true })))
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
        supportsEvaluateForHovers: true,
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
        try {
          await client.request('disconnect', { terminateDebuggee: true })
        } catch (cause) {
          notify(formatError(cause), 'error')
        } finally {
          // Reach idle even when the request fails: a dead or wedged session
          // must not leave the pane stuck on "Stopping…" forever.
          await cleanup('idle')
        }
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
        breakpoints: lines.map((line) => {
          const spec = specFor(path, line)
          return {
            line,
            ...(spec.condition ? { condition: spec.condition } : {}),
            ...(spec.logMessage ? { logMessage: spec.logMessage } : {}),
          }
        }),
      })
    } catch { /* a stale session logs to the console instead */ }
  }, [specFor])

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

  /** Add a watch expression; evaluated live once the session stops. */
  const addWatch = useCallback((expression: string) => {
    const trimmed = expression.trim()
    if (!trimmed) return
    // Update the ref before refreshing: refreshWatches reads it in the same
    // tick, before the setWatches re-render re-syncs it.
    const entry: WatchEntry = { id: ++watchIdRef.current, expression: trimmed, value: '' }
    watchesRef.current = [...watchesRef.current, entry]
    setWatches(watchesRef.current)
    const client = clientRef.current
    if (client && state === 'stopped') void refreshWatches(client, topFrameIdRef.current)
  }, [refreshWatches, state])

  const removeWatch = useCallback((id: number) => {
    setWatches((current) => current.filter((entry) => entry.id !== id))
  }, [])

  /** Evaluate an expression in the debug console (REPL context). */
  const evaluateRepl = useCallback(async (expression: string) => {
    const client = clientRef.current
    addConsole('input', expression)
    if (!client) { addConsole('error', t('未在调试')); return }
    const frame = frames[selectedFrameIndexRef.current]
    try {
      const response = await client.request<{ result: string }>('evaluate', {
        expression,
        ...(frame ? { frameId: frame.id } : {}),
        context: 'repl',
        format: { hex: false },
      })
      addConsole('result', response.result ?? '')
    } catch (cause) {
      addConsole('error', cause instanceof Error ? cause.message : String(cause))
    }
  }, [addConsole, frames, t])

  /** Switch the inspected goroutine/thread: reload stack and variables for it. */
  const selectThread = useCallback(async (threadId: number) => {
    const client = clientRef.current
    if (!client) return
    setCurrentThreadId(threadId)
    try {
      const topFrameId = await loadFrames(threadId, client)
      await refreshWatches(client, topFrameId)
    } catch (cause) {
      notify(formatError(cause), 'error')
    }
  }, [formatError, loadFrames, notify, refreshWatches])

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
    debugWatches: watches,
    debugClientActive: () => !!clientRef.current,
    startDebug,
    debugControl: control,
    syncBreakpoints,
    expandVariable,
    addWatch,
    removeWatch,
    evaluateRepl,
    selectThread,
    selectFrame: (index: number) => {
      setSelectedFrameIndex(index)
      const frame = frames[index]
      if (frame?.source?.path) setCurrentLocation({ path: frame.source.path, line: frame.line, column: frame.column })
    },
    debugSelectedFrameIndex: selectedFrameIndex,
    resetDebugger: () => { void cleanup('idle') },
  }
}
