import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { command, joinPath } from '../../lib/api'
import { parseGoLandCodeStyle, resolveEditorConfig, type EditorConfigSettings } from '../../lib/editorConfig'
import { readOptionalEditorConfig } from '../helpers'
import type { OpenFile } from '../types'

interface UseEditorConfigParams {
  rootRef: RefObject<string | null>
  workspaceGenerationRef: RefObject<number>
  tabsRef: RefObject<OpenFile[]>
  setTabs: Dispatch<SetStateAction<OpenFile[]>>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

/** Resolves .editorconfig with a GoLand style fallback for open files. */
export function useEditorConfig({ rootRef, workspaceGenerationRef, tabsRef, setTabs, notify, formatError }: UseEditorConfigParams) {
  // GoLand project code style (.idea/codeStyles/Project.xml), resolved once
  // per workspace and used when .editorconfig does not specify indentation.
  const goLandCodeStyleCacheRef = useRef<{ workspace: string; value: Partial<EditorConfigSettings> } | null>(null)
  const loadEditorConfig = useCallback(async (workspace: string, path: string): Promise<EditorConfigSettings> => {
    try {
      const settings = await resolveEditorConfig(workspace, path, readOptionalEditorConfig)
      if (settings.indentStyle !== undefined && settings.indentSize !== undefined) return settings
      if (goLandCodeStyleCacheRef.current?.workspace !== workspace) {
        let value: Partial<EditorConfigSettings> = {}
        try {
          const xml = await command<string>('read_file', { path: joinPath(workspace, '.idea/codeStyles/Project.xml') })
          value = parseGoLandCodeStyle(xml)
        } catch { /* projects without .idea or GoLand styles simply skip this */ }
        goLandCodeStyleCacheRef.current = { workspace, value }
      }
      return { ...goLandCodeStyleCacheRef.current.value, ...settings }
    }
    catch (cause) {
      if (rootRef.current === workspace) notify(`.editorconfig: ${formatError(cause)}`, 'error')
      return {}
    }
  }, [formatError, notify])

  const refreshOpenEditorConfigs = useCallback(async () => {
    const workspace = rootRef.current
    if (!workspace) return
    const generation = workspaceGenerationRef.current
    const files = tabsRef.current.filter((file) => !file.readOnly && !file.binary)
    const resolved = await Promise.all(files.map(async (file) => [file.path, await loadEditorConfig(workspace, file.path)] as const))
    if (generation !== workspaceGenerationRef.current) return
    const configs = new Map(resolved)
    const next = tabsRef.current.map((file) => configs.has(file.path) ? { ...file, editorConfig: configs.get(file.path) } : file)
    tabsRef.current = next
    setTabs(next)
  }, [loadEditorConfig])

  return { loadEditorConfig, refreshOpenEditorConfigs }
}
