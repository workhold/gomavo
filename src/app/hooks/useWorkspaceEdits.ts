import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as Monaco from 'monaco-editor'
import { command } from '../../lib/api'
import { applyTextEdits, fileUri, uriToPath, type GoplsClient, type WorkspaceEditCallback } from '../../lib/lsp'
import { commitWorkspaceFileWrites, type WorkspaceFileWrite } from '../../lib/lsp/workspaceEditTransaction'
import type { LocalEditHistory } from '../../lib/localHistory'
import { isWorkspaceFile } from '../helpers'
import type { OpenFile } from '../types'

interface UseWorkspaceEditsParams {
  rootRef: RefObject<string | null>
  tabsRef: RefObject<OpenFile[]>
  monacoApi: typeof Monaco | null
  lspRef: RefObject<GoplsClient | null>
  localEditHistoryRef: RefObject<LocalEditHistory>
  setTabs: Dispatch<SetStateAction<OpenFile[]>>
  setLocalHistoryRevision: Dispatch<SetStateAction<number>>
  applyExternalContent: (path: string, content: string) => void
  formatError: (cause: unknown) => string
}

/** Validates and commits gopls edits across open buffers and files on disk. */
export function useWorkspaceEdits({
  rootRef, tabsRef, monacoApi, lspRef, localEditHistoryRef,
  setTabs, setLocalHistoryRevision, applyExternalContent, formatError,
}: UseWorkspaceEditsParams): WorkspaceEditCallback {
  const workspaceEditApplyQueueRef = useRef<Promise<void>>(Promise.resolve())
  const applyWorkspaceEdits: WorkspaceEditCallback = useCallback((changes, options) => {
    const run = workspaceEditApplyQueueRef.current.then(async () => {
      const workspace = rootRef.current
      if (!workspace) throw new Error('The workspace closed while the edit was running')

      type PlannedEdit = {
        path: string
        before: string
        next: string
        open: OpenFile | null
        model: Monaco.editor.ITextModel | null
        modelVersion: number | null
        diskBefore: string | null | undefined
      }
      const planned: PlannedEdit[] = []
      const paths = new Set<string>()
      for (const [uri, edits] of Object.entries(changes)) {
        if (!edits.length) continue
        options?.validate?.()
        const path = uriToPath(uri)
        if (!isWorkspaceFile(workspace, path)) throw new Error(`${path}: outside the workspace`)
        if (paths.has(path)) throw new Error(`${path}: duplicate workspace edit target`)
        paths.add(path)
        const open = tabsRef.current.find((file) => file.path === path) ?? null
        if (open?.readOnly || open?.binary) throw new Error(`${path}: file is read-only`)
        const model = open ? monacoApi?.editor.getModel(monacoApi.Uri.parse(fileUri(path))) ?? null : null
        if (model && (model.isDisposed() || model.getValue() !== open?.content)) {
          throw new Error(`${path}: editor content changed; retry the edit`)
        }
        const before = open?.content ?? await command<string>('read_file', { path }).catch((cause) => {
          if (options?.requireExisting) throw new Error(`${path}: ${formatError(cause)}`)
          return null
        })
        let next: string
        try { next = applyTextEdits(before ?? '', edits) }
        catch (cause) { throw new Error(`${path}: ${formatError(cause)}`) }
        if (next === before) continue
        let diskBefore: string | null | undefined
        if (!open) {
          diskBefore = before
        } else if (open.content === open.savedContent) {
          // Preflight clean tabs against disk before any file is changed.
          const disk = await command<string>('read_file', { path }).catch((cause) => {
            throw new Error(`${path}: ${formatError(cause)}`)
          })
          if (disk !== open.savedContent) throw new Error(`${path}: file changed on disk; reload before renaming`)
          diskBefore = disk
        }
        planned.push({ path, before: before ?? '', next, open, model, modelVersion: model?.getVersionId() ?? null, diskBefore })
      }

      const validate = () => {
        if (rootRef.current !== workspace) throw new Error('The workspace changed while the edit was running')
        options?.validate?.()
        for (const edit of planned) {
          if (!edit.open) continue
          const latest = tabsRef.current.find((file) => file.path === edit.path)
          if (!latest || latest.content !== edit.open.content || latest.savedContent !== edit.open.savedContent) {
            throw new Error(`${edit.path}: editor content changed; retry the edit`)
          }
          if (edit.model && (edit.model.isDisposed() || edit.model.getVersionId() !== edit.modelVersion)) {
            throw new Error(`${edit.path}: editor content changed; retry the edit`)
          }
        }
      }
      const writes: WorkspaceFileWrite[] = planned
        .filter((edit) => edit.diskBefore !== undefined)
        .map((edit) => ({ path: edit.path, before: edit.diskBefore!, after: edit.next }))
      await commitWorkspaceFileWrites(writes, {
        read: (path) => command<string>('read_file', { path }),
        write: (path, content, expectedContent) => command<void>('write_file', { path, content, expectedContent }),
        create: (path, content) => command<void>('create_file_with_content', { path, content }),
        remove: (path) => command<void>('delete_path', { path }),
      }, validate, () => {
        const openEdits = planned.filter((edit) => edit.open)
        if (!openEdits.length) return
        const originalTabs = tabsRef.current
        try {
          for (const edit of openEdits) applyExternalContent(edit.path, edit.next)
          const byPath = new Map(openEdits.map((edit) => [edit.path, edit]))
          const updated = tabsRef.current.map((file) => {
            const edit = byPath.get(file.path)
            if (!edit) return file
            return { ...file, content: edit.next, savedContent: edit.diskBefore === undefined ? file.savedContent : edit.next }
          })
          tabsRef.current = updated
          setTabs(updated)
        } catch (cause) {
          for (const edit of openEdits) {
            try { applyExternalContent(edit.path, edit.before) } catch { /* Preserve the original failure. */ }
          }
          tabsRef.current = originalTabs
          setTabs(originalTabs)
          throw cause
        }
      })
      for (const edit of planned) {
        if (edit.open && localEditHistoryRef.current.ensureFile(edit.path, edit.next)) {
          setLocalHistoryRevision((value) => value + 1)
        }
        if (edit.path.endsWith('.go')) {
          if (edit.open) void lspRef.current?.changeDocument(edit.path, edit.next).catch(() => undefined)
          else void lspRef.current?.openDocument(edit.path, edit.next).catch(() => undefined)
        }
      }
    })
    workspaceEditApplyQueueRef.current = run.catch(() => undefined)
    return run
  }, [applyExternalContent, formatError, monacoApi, rootRef, tabsRef, lspRef, localEditHistoryRef, setTabs, setLocalHistoryRevision])

  return applyWorkspaceEdits
}
