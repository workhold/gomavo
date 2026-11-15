import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ask } from '@tauri-apps/plugin-dialog'
import {
  command, errorMessage, relativePath,
  type GitBranch as GitBranchInfo, type GitCommitResult, type GitFileHistoryEntry,
  type GitGraphCommit, type GitLogEntry, type GitMergeResult, type GitStashEntry,
  type GitStatus, type GitBlameResult,
} from '../../lib/api'
import { isWorkspaceFile } from '../helpers'
import type { LocalEditHistory } from '../../lib/localHistory'
import type { FileEntry } from '../../lib/api'
import type { FileHistorySource, GitFileHistoryView } from '../types'
import type { MessageKey } from '../../lib/i18n'

export interface UseGitParams {
  root: string | null
  rootRef: RefObject<string | null>
  expandedRef: RefObject<Set<string>>
  treeRef: RefObject<Record<string, FileEntry[]>>
  workspaceGenerationRef: RefObject<number>
  localEditHistoryRef: RefObject<LocalEditHistory>
  refreshDirectory: (path: string) => Promise<void>
  refreshProjectFiles: (workspace: string) => Promise<void>
  reloadCleanTabs: () => Promise<void>
  dirtyCount: number
  openPanel: (view: 'diff' | 'history' | 'log' | 'merge') => void
  leaveHistoryPanel: () => void
  resetTreeAndExpansion: (root: string) => void
  setBranchMenu: (value: boolean) => void
  setNewBranchName: (value: string) => void
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

/** Git status, diffs, file history and branch operations for the current workspace. */
export function useGit(params: UseGitParams) {
  const {
    root, rootRef, expandedRef, treeRef, workspaceGenerationRef, localEditHistoryRef,
    refreshDirectory, refreshProjectFiles, reloadCleanTabs, dirtyCount, openPanel,
    leaveHistoryPanel, resetTreeAndExpansion, setBranchMenu, setNewBranchName, notify,
    formatError, t,
  } = params
  const [git, setGit] = useState<GitStatus | null>(null)
  const gitRefreshRequestRef = useRef(0)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitDiff, setGitDiff] = useState<{ path: string; staged: boolean; content: string } | null>(null)
  const [gitFileHistory, setGitFileHistory] = useState<GitFileHistoryView | null>(null)
  const [fileHistorySource, setFileHistorySource] = useState<FileHistorySource>('git')
  const [selectedLocalHistoryId, setSelectedLocalHistoryId] = useState<number | null>(null)
  const fileHistoryRequestRef = useRef(0)
  const fileHistoryDiffRequestRef = useRef(0)
  const [gitLog, setGitLog] = useState<GitLogEntry[]>([])
  const [gitBranches, setGitBranches] = useState<GitBranchInfo[]>([])
  const [branchBusy, setBranchBusy] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [stashEntries, setStashEntries] = useState<GitStashEntry[]>([])
  const [gitGraph, setGitGraph] = useState<GitGraphCommit[]>([])
  const [gitGraphLoading, setGitGraphLoading] = useState(false)
  const [mergeConflicts, setMergeConflicts] = useState<string[] | null>(null)
  const [gitBlame, setGitBlame] = useState<{ path: string; result: GitBlameResult } | null>(null)

  const refreshGit = useCallback(async (workspace: string, options: { refreshIgnored?: boolean } = {}) => {
    const request = ++gitRefreshRequestRef.current
    try {
      const status = await command<GitStatus>('git_status', { root: workspace })
      const [log, branches] = await Promise.all([
        command<GitLogEntry[]>('git_log', { root: workspace, limit: 10 }).catch(() => []),
        command<GitBranchInfo[]>('git_branches', { root: workspace }).catch(() => []),
      ])
      if (request !== gitRefreshRequestRef.current || rootRef.current !== workspace) return
      setGit(status)
      setGitLog(log)
      setGitBranches(branches)
      setGitError(null)
    } catch (cause) {
      if (request !== gitRefreshRequestRef.current || rootRef.current !== workspace) return
      setGit(null)
      setGitLog([])
      setGitBranches([])
      setGitError(errorMessage(cause))
    } finally {
      // Manual refreshes and ignore-rule edits update the visible tree. The
      // automatic Git poll only needs the status and stays inexpensive.
      if (options.refreshIgnored && rootRef.current === workspace) {
        const visible = [...expandedRef.current ?? []].filter((path) => isWorkspaceFile(workspace, path) && treeRef.current?.[path])
        await Promise.all(visible.map((path) => refreshDirectory(path)))
      }
    }
  }, [refreshDirectory, expandedRef, rootRef, treeRef])

  const openGitDiff = useCallback(async (path: string, staged = false) => {
    if (!root) return
    try {
      const content = await command<string>('git_diff', { root, path, staged })
      setGitDiff({ path, staged, content })
      openPanel('diff')
    } catch (cause) { notify(errorMessage(cause), 'error') }
  }, [notify, root, openPanel])

  const openGitFileHistory = useCallback(async (path: string) => {
    const workspace = rootRef.current
    if (!workspace || !isWorkspaceFile(workspace, path)) return
    const relative = relativePath(workspace, path)
    const request = ++fileHistoryRequestRef.current
    fileHistoryDiffRequestRef.current += 1
    const generation = workspaceGenerationRef.current
    const localEntries = localEditHistoryRef.current?.getEntries(path) ?? []
    setFileHistorySource(localEntries.length ? 'local' : 'git')
    setSelectedLocalHistoryId(localEntries[0]?.id ?? null)
    setGitFileHistory({ path: relative, entries: [], loading: true, error: null, selectedHash: null, diff: null, diffLoading: false, diffError: null })
    openPanel('history')
    try {
      const entries = await command<GitFileHistoryEntry[]>('git_file_history', { root: workspace, path: relative, limit: 50 })
      if (request !== fileHistoryRequestRef.current || generation !== workspaceGenerationRef.current) return
      setGitFileHistory((current) => current?.path === relative ? { ...current, entries, loading: false } : current)
    } catch (cause) {
      if (request !== fileHistoryRequestRef.current || generation !== workspaceGenerationRef.current) return
      setGitFileHistory((current) => current?.path === relative ? { ...current, loading: false, error: formatError(cause) } : current)
    }
  }, [formatError, localEditHistoryRef, openPanel, rootRef, workspaceGenerationRef])

  const openGitFileCommitDiff = useCallback(async (entry: GitFileHistoryEntry) => {
    const workspace = rootRef.current
    const path = gitFileHistory?.path
    if (!workspace || !path) return
    const request = ++fileHistoryDiffRequestRef.current
    const generation = workspaceGenerationRef.current
    setGitFileHistory((current) => current?.path === path ? { ...current, selectedHash: entry.hash, diff: null, diffLoading: true, diffError: null } : current)
    try {
      const diff = await command<string>('git_file_commit_diff', { root: workspace, path, hash: entry.hash })
      if (request !== fileHistoryDiffRequestRef.current || generation !== workspaceGenerationRef.current) return
      setGitFileHistory((current) => current?.path === path && current.selectedHash === entry.hash ? { ...current, diff, diffLoading: false } : current)
    } catch (cause) {
      if (request !== fileHistoryDiffRequestRef.current || generation !== workspaceGenerationRef.current) return
      setGitFileHistory((current) => current?.path === path && current.selectedHash === entry.hash ? { ...current, diffLoading: false, diffError: formatError(cause) } : current)
    }
  }, [formatError, gitFileHistory?.path, rootRef, workspaceGenerationRef])

  const invalidateFileHistory = useCallback(() => {
    fileHistoryRequestRef.current += 1
    fileHistoryDiffRequestRef.current += 1
    setGitFileHistory(null)
  }, [])

  const updateGitIndex = useCallback(async (path: string, staged: boolean) => {
    if (!root) return
    try {
      setGit(await command<GitStatus>(staged ? 'git_unstage' : 'git_stage', { root, path }))
      if (gitDiff?.path === path) void openGitDiff(path, !staged)
    } catch (cause) { notify(errorMessage(cause), 'error') }
  }, [gitDiff?.path, notify, openGitDiff, root])

  const commitGit = useCallback(async () => {
    if (!root || !commitMessage.trim()) return
    try {
      const result = await command<GitCommitResult>('git_commit', { root, message: commitMessage.trim() })
      setGit(result.status)
      setCommitMessage('')
      setGitDiff(null)
      invalidateFileHistory()
      leaveHistoryPanel()
      void refreshGit(root)
      notify(`已提交 ${result.hash.slice(0, 8)}`)
    } catch (cause) { notify(errorMessage(cause), 'error') }
  }, [commitMessage, invalidateFileHistory, leaveHistoryPanel, notify, refreshGit, root])

  const changeBranch = useCallback(async (name: string, create = false) => {
    if (!root || branchBusy) return
    setBranchBusy(true)
    try {
      if (dirtyCount) {
        const confirmed = await ask(t('有 {count} 个未保存文件。仍要切换分支吗？', { count: dirtyCount }), {
          title: t('切换分支'), kind: 'warning', okLabel: t('切换分支'), cancelLabel: t('取消'),
        })
        if (!confirmed) return
      }
      setGit(await command<GitStatus>(create ? 'git_create_branch' : 'git_checkout_branch', { root, name }))
      setBranchMenu(false)
      setNewBranchName('')
      resetTreeAndExpansion(root)
      invalidateFileHistory()
      leaveHistoryPanel()
      await Promise.all([refreshGit(root), refreshProjectFiles(root), refreshDirectory(root), reloadCleanTabs()])
      notify(create ? `已创建并切换至 ${name}` : `已切换至 ${name}`)
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setBranchBusy(false) }
  }, [branchBusy, dirtyCount, formatError, invalidateFileHistory, leaveHistoryPanel, notify, refreshDirectory, refreshGit, refreshProjectFiles, reloadCleanTabs, resetTreeAndExpansion, root, setBranchMenu, setNewBranchName, t])

  /** Workspace switch: drop every Git view state. */
  const reset = useCallback(() => {
    setGit(null)
    setGitError(null)
    setGitDiff(null)
    fileHistoryRequestRef.current += 1
    fileHistoryDiffRequestRef.current += 1
    setGitFileHistory(null)
    setGitLog([])
    setGitBranches([])
    setCommitMessage('')
    setStashEntries([])
    setGitGraph([])
    setMergeConflicts(null)
    setGitBlame(null)
  }, [])

  // --- Remote operations --------------------------------------------------

  const refreshAfterRemote = useCallback(async () => {
    const workspace = rootRef.current
    if (!workspace) return
    await Promise.all([
      refreshGit(workspace),
      refreshProjectFiles(workspace),
      refreshDirectory(workspace),
      reloadCleanTabs(),
    ])
  }, [refreshDirectory, refreshGit, refreshProjectFiles, reloadCleanTabs, rootRef])

  const gitFetch = useCallback(async () => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      setGit(await command<GitStatus>('git_fetch', { root }))
      await refreshAfterRemote()
      notify(t('已拉取远程更新（fetch）'))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshAfterRemote, remoteBusy, root, t])

  const gitPull = useCallback(async (rebase = false) => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      setGit(await command<GitStatus>('git_pull', { root, rebase }))
      resetTreeAndExpansion(root)
      await refreshAfterRemote()
      notify(rebase ? t('已通过 rebase 拉取') : t('已拉取远程更改'))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshAfterRemote, remoteBusy, resetTreeAndExpansion, root, t])

  const gitPush = useCallback(async (setUpstream = false) => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      const message = await command<string>('git_push', { root, setUpstream })
      await refreshGit(root)
      notify(message)
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshGit, remoteBusy, root])

  // --- Merge and conflicts --------------------------------------------------

  const gitMerge = useCallback(async (name: string) => {
    if (!root || branchBusy) return
    setBranchBusy(true)
    setBranchMenu(false)
    try {
      const result = await command<GitMergeResult>('git_merge', { root, name })
      setGit(result.status)
      setMergeConflicts(result.conflicted ? result.conflicts : null)
      if (result.conflicted) {
        notify(t('合并存在冲突：{count} 个文件需要解决', { count: result.conflicts.length }), 'error')
      } else {
        notify(t('已合并 {name}', { name }))
      }
      resetTreeAndExpansion(root)
      await refreshAfterRemote()
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setBranchBusy(false) }
  }, [branchBusy, formatError, notify, refreshAfterRemote, resetTreeAndExpansion, root, setBranchMenu, t])

  const gitAbortMerge = useCallback(async () => {
    if (!root) return
    try {
      setGit(await command<GitStatus>('git_abort_merge', { root }))
      setMergeConflicts(null)
      resetTreeAndExpansion(root)
      await refreshAfterRemote()
      notify(t('已中止合并'))
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, refreshAfterRemote, resetTreeAndExpansion, root, t])

  const openMergeResolver = useCallback((path: string) => {
    setMergeConflicts((current) => current ?? [])
    openPanel('merge')
    setMergeResolverPath(path)
  }, [openPanel])
  const [mergeResolverPath, setMergeResolverPath] = useState<string | null>(null)

  const mergeResolved = useCallback(() => {
    setMergeResolverPath(null)
    const workspace = rootRef.current
    if (workspace) void refreshGit(workspace)
  }, [refreshGit, rootRef])

  // --- Stash ---------------------------------------------------------------

  const refreshStash = useCallback(async () => {
    const workspace = rootRef.current
    if (!workspace) return
    try { setStashEntries(await command<GitStashEntry[]>('git_stash_list', { root: workspace })) }
    catch { setStashEntries([]) }
  }, [rootRef])

  const gitStashPush = useCallback(async () => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      const status = await command<GitStatus>('git_stash_push', { root })
      setGit(status)
      await refreshAfterRemote()
      await refreshStash()
      notify(t('已贮藏当前更改'))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshAfterRemote, refreshStash, remoteBusy, root, t])

  const gitStashPop = useCallback(async (index = 0) => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      setGit(await command<GitStatus>('git_stash_pop', { root, index }))
      await refreshAfterRemote()
      await refreshStash()
      notify(t('已恢复贮藏的更改'))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshAfterRemote, refreshStash, remoteBusy, root, t])

  const gitStashDrop = useCallback(async (index = 0) => {
    if (!root || remoteBusy) return
    setRemoteBusy(true)
    try {
      await command('git_stash_drop', { root, index })
      await refreshStash()
      notify(t('已删除贮藏'))
    } catch (cause) { notify(formatError(cause), 'error') }
    finally { setRemoteBusy(false) }
  }, [formatError, notify, refreshStash, remoteBusy, root, t])

  // --- Blame and the log graph ----------------------------------------------

  const openGitBlame = useCallback(async (path: string) => {
    const workspace = rootRef.current
    if (!workspace || !isWorkspaceFile(workspace, path)) return
    try {
      const result = await command<GitBlameResult>('git_blame', { root: workspace, path: relativePath(workspace, path) })
      setGitBlame({ path, result })
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, rootRef])

  const openGitGraph = useCallback(async () => {
    const workspace = rootRef.current
    if (!workspace) return
    setGitGraphLoading(true)
    openPanel('log')
    try {
      setGitGraph(await command<GitGraphCommit[]>('git_log_graph', { root: workspace, limit: 300, all: true }))
    } catch (cause) {
      setGitGraph([])
      notify(formatError(cause), 'error')
    } finally { setGitGraphLoading(false) }
  }, [formatError, notify, openPanel, rootRef])

  return {
    git, gitError, gitDiff, setGitDiff, gitFileHistory,
    fileHistorySource, setFileHistorySource,
    selectedLocalHistoryId, setSelectedLocalHistoryId,
    gitLog, gitBranches, branchBusy, commitMessage, setCommitMessage,
    refreshGit, openGitDiff, openGitFileHistory, openGitFileCommitDiff,
    invalidateFileHistory, updateGitIndex, commitGit, changeBranch, reset,
    remoteBusy, gitFetch, gitPull, gitPush,
    gitMerge, gitAbortMerge, mergeConflicts, setMergeConflicts,
    mergeResolverPath, openMergeResolver, mergeResolved,
    stashEntries, refreshStash, gitStashPush, gitStashPop, gitStashDrop,
    gitBlame, setGitBlame, openGitBlame,
    gitGraph, gitGraphLoading, openGitGraph,
  }
}
