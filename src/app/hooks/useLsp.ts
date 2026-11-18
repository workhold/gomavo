import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type * as Monaco from 'monaco-editor'
import { command, desktopAvailable, errorMessage } from '../../lib/api'
import { GoplsClient, type DiagnosticEntry, type WorkspaceEditCallback } from '../../lib/lsp'
import type { LspState, OpenFile } from '../types'
import type { EditorNavigationLocation } from '../types'
import type { MessageKey } from '../../lib/i18n'

export interface UseLspParams {
  root: string | null
  monacoApi: typeof Monaco | null
  /** Truthy when `tool_versions` reports a gopls binary; undefined while unknown. */
  goplsAvailable: string | null | undefined
  lspEpoch: number
  tabsRef: RefObject<OpenFile[]>
  navigateTo: (target: EditorNavigationLocation, from?: EditorNavigationLocation | null, awaitApplied?: boolean) => Promise<boolean>
  captureEditorLocation: (editor?: Monaco.editor.ICodeEditor | null) => EditorNavigationLocation | null
  navigationRequestRef: RefObject<number>
  activePath: string | null
  activePathRef: RefObject<string | null>
  /** gopls setting applied on start; App pushes later changes through setConfig. */
  localPrefix: string
  /** gopls staticcheck lint diagnostics (default on). */
  staticcheck: boolean
  /** gopls gofumpt formatter (default off). */
  gofumpt: boolean
  /** Applies gopls workspace edits (rename/quick fix) across files. Assigned after this hook returns. */
  workspaceEditsRef: RefObject<WorkspaceEditCallback | null>
  /** Runs `go get` for a module picked from a synthesized BrokenImport quick fix. */
  missingModuleRef: RefObject<((module: string) => void) | null>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

/** Owns the gopls client lifecycle for the current workspace plus its diagnostics state. */
export function useLsp(params: UseLspParams) {
  const {
    root, monacoApi, goplsAvailable, lspEpoch, tabsRef, navigateTo, captureEditorLocation,
    navigationRequestRef, activePath, activePathRef, workspaceEditsRef, missingModuleRef, localPrefix, staticcheck, gofumpt,
    notify, formatError, t,
  } = params
  const [lspState, setLspState] = useState<LspState>('idle')
  const [lspError, setLspError] = useState<string | null>(null)
  const [goplsLog, setGoplsLog] = useState<string[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([])
  const [retryEpoch, setRetryEpoch] = useState(0)
  const retryCountRef = useRef(0)
  const lspRef = useRef<GoplsClient | null>(null)

  // gopls stderr carries the real failure reasons (toolchain mismatch, module
  // load errors). Keep the tail so the status bar can explain an error state.
  useEffect(() => {
    if (!desktopAvailable || !root) return
    let disposed = false
    let unlisten: UnlistenFn[] = []
    const target = getCurrentWebviewWindow().label
    void Promise.all([
      listen<{ root: string; line: string }>('lsp-stderr', (event) => {
        if (event.payload.root !== root) return
        setGoplsLog((current) => [...current, event.payload.line].slice(-60))
      }, { target }),
      listen<{ root: string; error: string }>('lsp-error', (event) => {
        if (event.payload.root !== root) return
        setLspState('error')
        setLspError(event.payload.error)
      }, { target }),
      listen<{ root: string }>('lsp-exit', (event) => {
        if (event.payload.root !== root) return
        setLspState((current) => current === 'ready' ? 'error' : current)
      }, { target }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((stop) => stop())
      else unlisten = listeners
    }).catch(() => undefined)
    return () => { disposed = true; unlisten.forEach((stop) => stop()) }
  }, [root])

  useEffect(() => {
    if (!root || !monacoApi) return
    if (!goplsAvailable) { setLspState('missing'); return }
    let cancelled = false
    let failed = false
    const client = new GoplsClient(root, monacoApi, setDiagnostics, (message) => {
      if (!cancelled) { failed = true; setLspState('error'); setLspError(message) }
    }, (target, source) => navigateTo(target, captureEditorLocation(source), true), (changes, options) => {
      const apply = workspaceEditsRef.current
      if (!apply) throw new Error('Workspace edits are not ready')
      return apply(changes, options)
    }, (module) => missingModuleRef.current?.(module))
    lspRef.current = client
    client.setConfig({ localPrefix, staticcheck, gofumpt })
    setLspState('starting')
    setLspError(null)
    setGoplsLog([])
    void client.start().then(async () => {
      if (cancelled) return
      for (const path of tabsRef.current?.filter((item) => item.path.endsWith('.go') && !item.binary).map((item) => item.path) ?? []) {
        const latest = tabsRef.current?.find((item) => item.path === path)
        if (latest) await client.openDocument(path, latest.content)
      }
      if (!cancelled && !failed) setLspState('ready')
    }).catch((cause) => {
      if (!cancelled) {
        setLspState('error')
        const message = errorMessage(cause)
        setLspError(message)
        setGoplsLog((current) => [...current, message].slice(-60))
      }
    })
    return () => { cancelled = true; if (lspRef.current === client) lspRef.current = null; void client.stop() }
  }, [root, monacoApi, goplsAvailable, lspEpoch, retryEpoch, navigateTo, captureEditorLocation, workspaceEditsRef])

  // Restart crashed or failed servers with bounded backoff. A successful
  // minute resets the delay, so a one-off crash recovers quickly again.
  useEffect(() => {
    if (!root || !goplsAvailable || lspState !== 'error') return
    const attempt = retryCountRef.current++
    const timer = window.setTimeout(() => setRetryEpoch((value) => value + 1), Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)))
    return () => window.clearTimeout(timer)
  }, [root, goplsAvailable, lspState])

  useEffect(() => {
    if (!root || lspState !== 'ready') return
    const reset = window.setTimeout(() => { retryCountRef.current = 0 }, 60000)
    const check = window.setInterval(() => {
      void command<boolean>('lsp_health', { root }).then((healthy) => {
        if (!healthy) { setLspError('gopls stopped'); setLspState('error') }
      }).catch(() => undefined)
    }, 20000)
    return () => { window.clearTimeout(reset); window.clearInterval(check) }
  }, [root, lspState])

  useEffect(() => {
    if (root && goplsAvailable === undefined) return
    if (root && !goplsAvailable) setLspState('missing')
  }, [root, goplsAvailable])

  const goToDefinition = useCallback(async () => {
    if (!activePath || !lspRef.current || lspState !== 'ready') { notify(t('gopls 尚未就绪，无法跳转定义。'), 'error'); return }
    const source = captureEditorLocation()
    if (!source || source.path !== activePath) return
    const request = navigationRequestRef.current
    try {
      const target = await lspRef.current.goToDefinition(activePath, source.line, source.column)
      if (request !== navigationRequestRef.current || activePathRef.current !== activePath) return
      if (!target) { notify(t('未找到定义。'), 'error'); return }
      await navigateTo(target, source)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [activePath, activePathRef, captureEditorLocation, formatError, lspState, navigateTo, notify, t])

  /** Workspace switch: drop diagnostics; the client effect restarts via its own deps. */
  const reset = useCallback(() => {
    setDiagnostics([])
    setGoplsLog([])
    setLspError(null)
    setLspState('idle')
  }, [])

  return { lspState, lspError, goplsLog, lspRef, diagnostics, goToDefinition, reset }
}
