import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { joinPath, relativePath, type FileEntry } from '../../lib/api'
import { isWorkspaceFile } from '../helpers'
import type { SideView } from '../types'

interface UseTreeRevealParams {
  root: string | null
  activePath: string | null
  tree: Record<string, FileEntry[]>
  expanded: Set<string>
  revealPath: string | null
  sideView: SideView
  sidebarOpen: boolean
  treeScrollRef: RefObject<HTMLDivElement | null>
  refreshDirectory: (path: string) => Promise<void>
  setSideView: Dispatch<SetStateAction<SideView>>
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
  setSelectedTreePath: Dispatch<SetStateAction<string | null>>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  setRevealPath: Dispatch<SetStateAction<string | null>>
}

/** Expands project ancestors and scrolls the selected file into view. */
export function useTreeReveal({
  root, activePath, tree, expanded, revealPath, sideView, sidebarOpen,
  treeScrollRef, refreshDirectory, setSideView, setSidebarOpen,
  setSelectedTreePath, setExpanded, setRevealPath,
}: UseTreeRevealParams) {
  /** Reveal any workspace path in the project tree (expands ancestors, selects, scrolls). */
  const revealTreePath = useCallback((path: string) => {
    if (!root || !isWorkspaceFile(root, path)) return
    setSideView('files')
    setSidebarOpen(true)
    setSelectedTreePath(path)
    const relative = relativePath(root, path)
    const directories = [root]
    for (const segment of relative.split('/').slice(0, -1)) {
      directories.push(joinPath(directories[directories.length - 1], segment))
    }
    setExpanded((current) => new Set([...current, ...directories]))
    for (const directory of directories) if (!tree[directory]) void refreshDirectory(directory)
    setRevealPath(path)
  }, [refreshDirectory, root, tree])

  const revealCurrentFile = () => {
    if (!activePath) return
    revealTreePath(activePath)
  }

  useEffect(() => {
    if (!revealPath || sideView !== 'files' || !sidebarOpen) return
    const row = [...(treeScrollRef.current?.querySelectorAll<HTMLButtonElement>('.tree-row[data-entry-path]') ?? [])]
      .find((candidate) => candidate.dataset.entryPath === revealPath)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    row.focus({ preventScroll: true })
    setRevealPath(null)
  }, [expanded, revealPath, sideView, sidebarOpen, tree])

  return { revealTreePath, revealCurrentFile }
}
