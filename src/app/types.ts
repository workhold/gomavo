import type * as Monaco from 'monaco-editor'
import type { FileEntry, GitFileHistoryEntry } from '../lib/api'
import type { NavigationLocation } from '../lib/navigationHistory'
import type { EditorConfigSettings } from '../lib/editorConfig'

export type OpenFile = { path: string; content: string; savedContent: string; readOnly?: boolean; binary?: boolean; pinned?: boolean; editorConfig?: EditorConfigSettings }
export type SideView = 'files' | 'git' | 'structure' | 'bookmarks'
export type PanelView = 'terminal' | 'output' | 'tests' | 'problems' | 'diff' | 'history' | 'search' | 'debug' | 'log' | 'merge' | 'todo' | 'usages'
export type FileHistorySource = 'local' | 'git'
export type DialogState = { kind: 'go' | 'file' | 'module' | 'workspace' | 'folder' | 'rename'; parent: string; target?: FileEntry }
export type ContextState = { x: number; y: number; entry: FileEntry; parent: string; mode: 'context' | 'new' }
export type TabContextState = { x: number; y: number; path: string }
export type Toast = { text: string; kind: 'success' | 'error' }
export type OutputLine = { id: number; text: string; stream: 'meta' | 'stdout' | 'stderr' }
export type LspState = 'idle' | 'starting' | 'ready' | 'missing' | 'error'
export type TestResult = { package: string; name: string; status: 'run' | 'pass' | 'fail' | 'skip'; elapsed?: number }
export type GoTestEvent = { Action?: string; Package?: string; Test?: string; Output?: string; Elapsed?: number }
export type PaletteMode = 'all' | 'files' | 'actions' | 'symbols' | 'recent' | 'intentions' | 'generate'
export type TaskScope = 'workspace' | 'file' | 'package' | 'directory'
export type TaskOptions = {
  scope?: TaskScope
  targetPath?: string
  testName?: string
  label?: string
  /** Passed to the program after `go run <pkg>`. */
  programArgs?: string[]
  envVars?: Record<string, string>
  buildTags?: string
  race?: boolean
  /** Collect a coverage profile for `go test`. */
  coverage?: boolean
  module?: string
  /** Benchmark pattern for `go test -bench` (`-run=^$`); empty string runs all. */
  bench?: string
}
export type StartupIntent = { workspace: string | null; newProject: boolean; emptyWindow: boolean }
export type EditorNavigationLocation = NavigationLocation<Monaco.editor.ICodeEditorViewState>
export type NavigationCompletion = { request: number; resolve: (applied: boolean) => void; timer: number }
export type GitFileHistoryView = {
  path: string
  entries: GitFileHistoryEntry[]
  loading: boolean
  error: string | null
  selectedHash: string | null
  diff: string | null
  diffLoading: boolean
  diffError: string | null
}
