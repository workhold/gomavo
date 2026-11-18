import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import { fileUri, uriToPath } from '../../lib/lsp'
import { validBreakpointLines } from '../../lib/debug/breakpoints'
import type { OpenFile } from '../types'
import type { BreakpointSpec, useDebugger } from './useDebugger'

type BreakpointEdit = { path: string; line: number; condition: string; logMessage: string }

interface UseBreakpointActionsParams {
  editorRef: RefObject<Monaco.editor.IStandaloneCodeEditor | null>
  tabsRef: RefObject<OpenFile[]>
  activePathRef: RefObject<string | null>
  breakpointsRef: RefObject<Record<string, number[]>>
  breakpointSpecsRef: RefObject<Record<string, Record<number, BreakpointSpec>>>
  toggleBreakpointRef: RefObject<((path: string, line: number) => void) | null>
  pruneBreakpointsRef: RefObject<((path: string, lineCount: number) => void) | null>
  lineNumbersFormatterRef: RefObject<((line: number) => string) | null>
  breakpointEdit: BreakpointEdit | null
  setBreakpointEdit: Dispatch<SetStateAction<BreakpointEdit | null>>
  setBreakpoints: Dispatch<SetStateAction<Record<string, number[]>>>
  setBreakpointSpecs: Dispatch<SetStateAction<Record<string, Record<number, BreakpointSpec>>>>
  setBookmarks: Dispatch<SetStateAction<Record<string, number[]>>>
  syncBreakpoints: ReturnType<typeof useDebugger>['syncBreakpoints']
}

/** Updates breakpoint/bookmark state and keeps Monaco's gutter in sync. */
export function useBreakpointActions({
  editorRef, tabsRef, activePathRef, breakpointsRef, breakpointSpecsRef,
  toggleBreakpointRef, pruneBreakpointsRef, lineNumbersFormatterRef,
  breakpointEdit, setBreakpointEdit, setBreakpoints, setBreakpointSpecs,
  setBookmarks, syncBreakpoints,
}: UseBreakpointActionsParams) {
  // Line-number renderer: hides the number under a breakpoint dot so the dot
  // fully replaces it. Reads refs, so its identity never changes.
  const lineNumbersFormatter = useCallback((lineNumber: number): string => {
    const model = editorRef.current?.getModel()
    const path = model ? tabsRef.current?.find((item) => fileUri(item.path) === model.uri.toString())?.path ?? uriToPath(model.uri.toString()) : null
    const marked = path ? breakpointsRef.current[path]?.includes(lineNumber) : false
    return marked ? '' : String(lineNumber)
  }, [])

  const persistBreakpoints = useCallback((next: Record<string, number[]>) => {
    breakpointsRef.current = next
    setBreakpoints(next)
    const activePath = activePathRef.current
    if (activePath) void syncBreakpoints(activePath, next[activePath] ?? [])
    // Re-apply the formatter so the number under a new dot hides immediately.
    const formatter = lineNumbersFormatterRef.current
    if (formatter) editorRef.current?.updateOptions({ lineNumbers: formatter })
  }, [lineNumbersFormatter, syncBreakpoints])

  const pruneBreakpoints = useCallback((path: string, lineCount: number) => {
    const current = breakpointsRef.current[path]
    if (!current?.length) return
    const valid = validBreakpointLines(current, lineCount)
    if (valid.length === current.length && valid.every((line, index) => line === current[index])) return
    persistBreakpoints({ ...breakpointsRef.current, [path]: valid })
    setBreakpointSpecs((currentSpecs) => {
      const fileSpecs = currentSpecs[path]
      if (!fileSpecs) return currentSpecs
      const nextSpecs = Object.fromEntries(Object.entries(fileSpecs).filter(([line]) => valid.includes(Number(line))))
      const next = { ...currentSpecs, [path]: nextSpecs }
      breakpointSpecsRef.current = next
      return next
    })
  }, [persistBreakpoints])

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    const current = breakpointsRef.current[path] ?? []
    if (current.includes(line)) {
      persistBreakpoints({ ...breakpointsRef.current, [path]: current.filter((item) => item !== line) })
      // Drop any condition/logMessage spec attached to the removed breakpoint.
      setBreakpointSpecs((currentSpecs) => {
        const fileSpecs = { ...(currentSpecs[path] ?? {}) }
        delete fileSpecs[line]
        const next = { ...currentSpecs, [path]: fileSpecs }
        breakpointSpecsRef.current = next
        return next
      })
    } else {
      persistBreakpoints({ ...breakpointsRef.current, [path]: [...current, line].sort((a, b) => a - b) })
    }
  }, [persistBreakpoints])

  const toggleBookmark = useCallback((path: string, line: number) => {
    setBookmarks((current) => {
      const lines = current[path] ?? []
      const next = lines.includes(line) ? lines.filter((item) => item !== line) : [...lines, line].sort((a, b) => a - b)
      return { ...current, [path]: next }
    })
  }, [])
  toggleBreakpointRef.current = toggleBreakpoint
  pruneBreakpointsRef.current = pruneBreakpoints
  lineNumbersFormatterRef.current = lineNumbersFormatter

  /** Save the breakpoint condition/logMessage dialog back to the spec map. */
  const saveBreakpointEdit = useCallback(() => {
    if (!breakpointEdit) return
    const condition = breakpointEdit.condition.trim()
    const logMessage = breakpointEdit.logMessage.trim()
    setBreakpointSpecs((current) => {
      const fileSpecs = { ...(current[breakpointEdit.path] ?? {}) }
      if (condition || logMessage) fileSpecs[breakpointEdit.line] = { ...(condition ? { condition } : {}), ...(logMessage ? { logMessage } : {}) }
      else delete fileSpecs[breakpointEdit.line]
      const next = { ...current, [breakpointEdit.path]: fileSpecs }
      breakpointSpecsRef.current = next
      return next
    })
    const edited = breakpointEdit
    setBreakpointEdit(null)
    void syncBreakpoints(edited.path, breakpointsRef.current[edited.path] ?? [])
  }, [breakpointEdit, syncBreakpoints])

  return { lineNumbersFormatter, toggleBreakpoint, toggleBookmark, saveBreakpointEdit }
}
