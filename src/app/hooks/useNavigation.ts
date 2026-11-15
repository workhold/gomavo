import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type * as Monaco from 'monaco-editor'
import { fileUri, uriToPath } from '../../lib/lsp'
import { NavigationHistory } from '../../lib/navigationHistory'
import type { EditorNavigationLocation, NavigationCompletion } from '../types'

export type OpenFileFn = (path: string, options?: { preserveNavigation?: boolean }) => Promise<boolean>

export interface UseNavigationParams {
  /** Assigned during render after `openFile` is defined; breaks the hook/App dependency cycle. */
  openFileRef: RefObject<OpenFileFn | null>
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  activePathRef: RefObject<string | null>
  activePath: string | null
}

/**
 * Editor navigation history: back/forward locations with saved view states,
 * plus the pending-navigation state machine that applies a target after the
 * editor model has switched.
 */
export function useNavigation(params: UseNavigationParams) {
  const { openFileRef, editorRef, activePathRef, activePath } = params

  const openFile = useCallback((path: string, options?: { preserveNavigation?: boolean }) => {
    const opener = openFileRef.current
    return opener ? opener(path, options) : Promise.resolve(false)
  }, [])
  const [navigation, setNavigation] = useState<EditorNavigationLocation | null>(null)
  const pendingNavigationRef = useRef<EditorNavigationLocation | null>(null)
  const navigationCompletionRef = useRef<NavigationCompletion | null>(null)
  const navigationRequestRef = useRef(0)
  const historyRef = useRef(new NavigationHistory<Monaco.editor.ICodeEditorViewState>())
  const [historyAvailability, setHistoryAvailability] = useState({ back: false, forward: false })
  const historyNavigationBusyRef = useRef(false)
  const historyNavigationQueueRef = useRef<Array<'back' | 'forward'>>([])
  const [historyNavigationBusy, setHistoryNavigationBusy] = useState(false)

  const completeNavigation = useCallback((applied: boolean) => {
    const completion = navigationCompletionRef.current
    if (!completion) return
    navigationCompletionRef.current = null
    window.clearTimeout(completion.timer)
    completion.resolve(applied)
  }, [])

  const cancelPendingNavigation = useCallback((preserveQueuedHistory = false) => {
    if (!preserveQueuedHistory) historyNavigationQueueRef.current = []
    navigationRequestRef.current += 1
    pendingNavigationRef.current = null
    setNavigation(null)
    completeNavigation(false)
  }, [completeNavigation])

  const refreshHistoryAvailability = useCallback(() => {
    const history = historyRef.current
    setHistoryAvailability({ back: history.canGoBack, forward: history.canGoForward })
  }, [])

  const captureEditorLocation = useCallback((editor: Monaco.editor.ICodeEditor | null = editorRef.current): EditorNavigationLocation | null => {
    if (!editor) return null
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position || model.uri.scheme !== 'file') return null
    return { path: uriToPath(model.uri.toString()), line: position.lineNumber, column: position.column, viewState: editor.saveViewState() }
  }, [])

  const applyNavigation = useCallback(() => {
    const target = pendingNavigationRef.current
    const editor = editorRef.current
    if (!target || !editor || activePathRef.current !== target.path || editor.getModel()?.uri.toString() !== fileUri(target.path)) return
    const position = { lineNumber: target.line, column: target.column }
    if (target.viewState) editor.restoreViewState(target.viewState)
    else {
      editor.setPosition(position)
      editor.revealPositionInCenterIfOutsideViewport(position)
    }
    editor.focus()
    pendingNavigationRef.current = null
    setNavigation(null)
    completeNavigation(true)
  }, [completeNavigation, editorRef, activePathRef])

  const waitForNavigationApplication = useCallback((request: number): Promise<boolean> => new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (navigationRequestRef.current === request) cancelPendingNavigation()
    }, 5000)
    navigationCompletionRef.current = { request, resolve, timer }
  }), [cancelPendingNavigation])

  const navigateTo = useCallback(async (target: EditorNavigationLocation, from = captureEditorLocation(), awaitApplied = false): Promise<boolean> => {
    cancelPendingNavigation()
    const request = navigationRequestRef.current
    if (!await openFile(target.path, { preserveNavigation: true }) || request !== navigationRequestRef.current) return false
    historyRef.current.push(from, target)
    refreshHistoryAvailability()
    pendingNavigationRef.current = target
    const completion = awaitApplied ? waitForNavigationApplication(request) : null
    setNavigation(target)
    return completion ?? true
  }, [cancelPendingNavigation, captureEditorLocation, openFile, refreshHistoryAvailability, waitForNavigationApplication])

  const navigateHistory = useCallback(async (direction: 'back' | 'forward') => {
    if (historyNavigationBusyRef.current) {
      historyNavigationQueueRef.current.push(direction)
      return
    }
    historyNavigationBusyRef.current = true
    setHistoryNavigationBusy(true)
    try {
      let next: 'back' | 'forward' | undefined = direction
      while (next) {
        const history = historyRef.current
        const target = next === 'back' ? history.peekBack() : history.peekForward()
        if (!target) break
        const current = captureEditorLocation()
        cancelPendingNavigation(true)
        const request = navigationRequestRef.current
        if (!await openFile(target.path, { preserveNavigation: true }) || request !== navigationRequestRef.current) break
        const destination = next === 'back' ? history.back(current) : history.forward(current)
        if (!destination) break
        refreshHistoryAvailability()
        pendingNavigationRef.current = destination
        const completion = waitForNavigationApplication(request)
        setNavigation(destination)
        if (!await completion) break
        next = historyNavigationQueueRef.current.shift()
      }
    } finally {
      historyNavigationQueueRef.current = []
      historyNavigationBusyRef.current = false
      setHistoryNavigationBusy(false)
    }
  }, [cancelPendingNavigation, captureEditorLocation, openFile, refreshHistoryAvailability, waitForNavigationApplication])

  useEffect(() => {
    if (!navigation) return
    const frame = requestAnimationFrame(applyNavigation)
    return () => cancelAnimationFrame(frame)
  }, [activePath, applyNavigation, navigation])

  /** Workspace switch: drop the whole history and any in-flight navigation. */
  const reset = useCallback(() => {
    cancelPendingNavigation()
    historyRef.current.clear()
    setHistoryAvailability({ back: false, forward: false })
  }, [cancelPendingNavigation])

  return {
    navigation,
    setNavigation,
    pendingNavigationRef,
    navigationRequestRef,
    historyRef,
    historyAvailability,
    historyNavigationBusy,
    completeNavigation,
    cancelPendingNavigation,
    refreshHistoryAvailability,
    captureEditorLocation,
    applyNavigation,
    navigateTo,
    navigateHistory,
    reset,
  }
}
