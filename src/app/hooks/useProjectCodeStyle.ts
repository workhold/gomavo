import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { command, desktopAvailable, type FileEntry } from '../../lib/api'
import { loadProjectGoOverrides, saveProjectGoOverrides, type GoPreferences } from '../../lib/preferences'
import {
  createProjectCodeStyleIfMissing, loadProjectCodeStyleSnapshot, migrateLegacyProjectCodeStyle,
  projectCodeStylePath, saveProjectCodeStyle, serializeProjectCodeStyle, type ProjectCodeStyleIO,
} from '../../lib/projectCodeStyle'

interface UseProjectCodeStyleParams {
  root: string | null
  rootRef: RefObject<string | null>
  treeRef: RefObject<Record<string, FileEntry[]>>
  setTree: Dispatch<SetStateAction<Record<string, FileEntry[]>>>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

export const projectCodeStyleIO: ProjectCodeStyleIO = {
  listDirectory: (path) => command<FileEntry[]>('list_directory', { path }),
  readFile: (path) => command<string>('read_file', { path }),
  createDirectory: (path) => command('create_directory', { path }),
  createFile: (path, content) => command('create_file_with_content', { path, content }),
  writeFile: (path, content, expectedContent) => command('write_file', { path, content, expectedContent }),
}

/** Loads, saves and watches the workspace's Go code style overrides. */
export function useProjectCodeStyle({ root, rootRef, treeRef, setTree, notify, formatError }: UseProjectCodeStyleParams) {
  /** Style-family scope: "global" applies everywhere, "project" only to the open workspace. */
  const [goScope, setGoScope] = useState<'global' | 'project'>('global')
  const [projectGoOverrides, setProjectGoOverrides] = useState<Partial<GoPreferences>>({})
  const [projectStyleReady, setProjectStyleReady] = useState(false)
  const projectStyleDiskRef = useRef(new Map<string, string | null>())
  const projectStyleExternalRevisionRef = useRef(new Map<string, number>())
  const projectStyleSaveRef = useRef<Promise<void>>(Promise.resolve())
  const projectStyleLoadRef = useRef<{ root: string; promise: Promise<void> } | null>(null)
  const projectStyleLoadRequestRef = useRef(0)
  const syncProjectStyleTabRef = useRef<((path: string, content: string) => void) | null>(null)

  // Project style now lives in .gomavo/code-style.json. Copy the previous
  // project file, then migrate older browser-local overrides if needed.
  useEffect(() => {
    const request = ++projectStyleLoadRequestRef.current
    setProjectGoOverrides({})
    setGoScope('global')
    setProjectStyleReady(false)
    if (!root || !desktopAvailable) {
      projectStyleLoadRef.current = null
      return
    }
    const load = (async () => {
      let snapshot = await migrateLegacyProjectCodeStyle(root, projectCodeStyleIO)
      if (snapshot === null) {
        const legacy = loadProjectGoOverrides(root)
        if (Object.keys(legacy).length) {
          const created = await createProjectCodeStyleIfMissing(root, legacy, projectCodeStyleIO)
          snapshot = created
            ? { go: legacy, content: serializeProjectCodeStyle(legacy) }
            : await loadProjectCodeStyleSnapshot(root, projectCodeStyleIO)
          if (snapshot === null) throw new Error('Project code-style file disappeared during migration')
          saveProjectGoOverrides(root, {})
        }
      } else saveProjectGoOverrides(root, {})
      if (request !== projectStyleLoadRequestRef.current || rootRef.current !== root) return
      const overrides = snapshot?.go ?? {}
      projectStyleDiskRef.current.set(root, snapshot?.content ?? null)
      setProjectGoOverrides(overrides)
      setGoScope(Object.keys(overrides).length ? 'project' : 'global')
      setProjectStyleReady(true)
    })()
    projectStyleLoadRef.current = { root, promise: load }
    void load.catch((cause) => {
      if (request === projectStyleLoadRequestRef.current && rootRef.current === root) notify(formatError(cause), 'error')
    })
  }, [root, formatError, notify])

  const persistProjectGoOverrides = useCallback((workspace: string, overrides: Partial<GoPreferences>) => {
    const request = ++projectStyleLoadRequestRef.current
    const externalRevision = projectStyleExternalRevisionRef.current.get(workspace) ?? 0
    setProjectGoOverrides(overrides)
    projectStyleSaveRef.current = projectStyleSaveRef.current.catch(() => undefined).then(async () => {
      const load = projectStyleLoadRef.current
      if (load?.root === workspace) await load.promise
      if ((projectStyleExternalRevisionRef.current.get(workspace) ?? 0) !== externalRevision
        || !projectStyleDiskRef.current.has(workspace)) {
        throw new Error('Save conflict: File changed on disk. Reload before saving')
      }
      const expected = projectStyleDiskRef.current.get(workspace)
      let content: string
      if (expected === null) {
        if (!await createProjectCodeStyleIfMissing(workspace, overrides, projectCodeStyleIO)) {
          throw new Error('Save conflict: File changed on disk. Reload before saving')
        }
        content = serializeProjectCodeStyle(overrides)
      } else {
        content = await saveProjectCodeStyle(workspace, overrides, projectCodeStyleIO, expected!)
      }
      if ((projectStyleExternalRevisionRef.current.get(workspace) ?? 0) !== externalRevision) return
      projectStyleDiskRef.current.set(workspace, content)
      saveProjectGoOverrides(workspace, {})
      if (rootRef.current === workspace) {
        syncProjectStyleTabRef.current?.(projectCodeStylePath(workspace), content)
        if (!treeRef.current[workspace]?.some((entry) => entry.name === '.gomavo')) {
          const entries = await command<FileEntry[]>('list_directory', { path: workspace })
          setTree((current) => ({ ...current, [workspace]: entries }))
        }
      }
    }).catch(async (cause) => {
      if (rootRef.current !== workspace) return
      notify(formatError(cause), 'error')
      if (request !== projectStyleLoadRequestRef.current) return
      try {
        const snapshot = await loadProjectCodeStyleSnapshot(workspace, projectCodeStyleIO)
        if (request !== projectStyleLoadRequestRef.current || rootRef.current !== workspace) return
        const latest = snapshot?.go ?? {}
        const content = snapshot?.content ?? null
        if (projectStyleDiskRef.current.has(workspace) && projectStyleDiskRef.current.get(workspace) !== content) {
          projectStyleExternalRevisionRef.current.set(workspace, (projectStyleExternalRevisionRef.current.get(workspace) ?? 0) + 1)
        }
        projectStyleDiskRef.current.set(workspace, content)
        setProjectGoOverrides(latest)
        setGoScope(Object.keys(latest).length ? 'project' : 'global')
        setProjectStyleReady(true)
      } catch (reloadError) {
        if (request === projectStyleLoadRequestRef.current && rootRef.current === workspace) {
          setProjectStyleReady(false)
          notify(formatError(reloadError), 'error')
        }
      }
    })
  }, [formatError, notify])

  const reloadProjectCodeStyle = useCallback(async (workspace: string) => {
    if (rootRef.current !== workspace) return
    const request = ++projectStyleLoadRequestRef.current
    try {
      await projectStyleSaveRef.current.catch(() => undefined)
      const snapshot = await loadProjectCodeStyleSnapshot(workspace, projectCodeStyleIO)
      if (request !== projectStyleLoadRequestRef.current || rootRef.current !== workspace) return
      const content = snapshot?.content ?? null
      if (projectStyleDiskRef.current.has(workspace) && projectStyleDiskRef.current.get(workspace) !== content) {
        projectStyleExternalRevisionRef.current.set(workspace, (projectStyleExternalRevisionRef.current.get(workspace) ?? 0) + 1)
      }
      projectStyleDiskRef.current.set(workspace, content)
      const overrides = snapshot?.go ?? {}
      setProjectGoOverrides(overrides)
      setGoScope(Object.keys(overrides).length ? 'project' : 'global')
      setProjectStyleReady(true)
    } catch (cause) {
      if (request === projectStyleLoadRequestRef.current && rootRef.current === workspace) {
        setProjectStyleReady(false)
        notify(formatError(cause), 'error')
      }
    }
  }, [formatError, notify])

  return {
    goScope, setGoScope, projectGoOverrides, setProjectGoOverrides, projectStyleReady, setProjectStyleReady,
    projectStyleDiskRef, projectStyleExternalRevisionRef, projectStyleSaveRef,
    projectStyleLoadRef, projectStyleLoadRequestRef, syncProjectStyleTabRef,
    persistProjectGoOverrides, reloadProjectCodeStyle,
  }
}
