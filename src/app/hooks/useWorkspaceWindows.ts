import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { command, desktopAvailable } from '../../lib/api'
import type { MessageKey } from '../../lib/i18n'

interface UseWorkspaceWindowsParams {
  rootRef: RefObject<string | null>
  activateWorkspace: (path: string) => Promise<void>
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>
  setNewProjectOpen: Dispatch<SetStateAction<boolean>>
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
  t: (key: MessageKey, values?: Record<string, string | number>) => string
}

/** Opens projects in this window or launches a separate desktop window. */
export function useWorkspaceWindows({
  rootRef, activateWorkspace, setProjectMenuOpen, setNewProjectOpen,
  notify, formatError, t,
}: UseWorkspaceWindowsParams) {
  const openNewProject = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try {
      if (rootRef.current) await command('open_new_project_window')
      else setNewProjectOpen(true)
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, t])

  const openEmptyWindow = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try { await command('open_empty_project_window') }
    catch (cause) { notify(formatError(cause), 'error') }
  }, [formatError, notify, t])

  const chooseWorkspace = useCallback(async () => {
    if (!desktopAvailable) { notify(t('请通过 npm run tauri dev 启动桌面应用。'), 'error'); return }
    setProjectMenuOpen(false)
    try {
      const picked = await open({ directory: true, multiple: false, title: t('选择 Go 项目文件夹') })
      if (typeof picked === 'string') {
        if (rootRef.current) await command('open_project_window', { root: picked })
        else await activateWorkspace(picked)
      }
    } catch (cause) { notify(formatError(cause), 'error') }
  }, [activateWorkspace, formatError, notify, t])

  return { openNewProject, openEmptyWindow, chooseWorkspace }
}
