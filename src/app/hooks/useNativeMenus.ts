import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { command, desktopAvailable, displayName } from '../../lib/api'
import type { Locale } from '../../lib/i18n'

interface UseNativeMenusParams {
  locale: Locale
  recentProjects: string[]
  notify: (text: string, kind?: 'success' | 'error') => void
  formatError: (cause: unknown) => string
}

/** Synchronizes native menu state and forwards menu events to the latest handler. */
export function useNativeMenus({ locale, recentProjects, notify, formatError }: UseNativeMenusParams) {
  /** Native menu bar actions dispatch through this ref so they always see the latest callbacks. */
  const menuActionRef = useRef<(id: string, path?: string) => void>(() => undefined)
  useEffect(() => {
    if (!desktopAvailable) return
    let disposed = false
    let unlisten: UnlistenFn[] = []
    const target = getCurrentWebviewWindow().label
    void Promise.all([
      listen<{ id: string; path?: string }>('menu-action', (event) => menuActionRef.current?.(event.payload.id, event.payload.path), { target }),
    ]).then((listeners) => { if (disposed) listeners.forEach((stop) => stop()); else unlisten = listeners })
      .catch((cause) => notify(formatError(cause), 'error'))
    return () => { disposed = true; unlisten.forEach((stop) => stop()) }
  }, [formatError, notify])

  // Keep the native menu bar localized and the Recent Projects submenu current.
  useEffect(() => {
    if (!desktopAvailable) return
    // Replacing the macOS menu during a webview click can interrupt the
    // language popover's own close/render cycle. Update it after that paint.
    let timer: number | undefined
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        command('set_menu_locale', { locale }).catch(() => undefined)
      }, 0)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [desktopAvailable, locale])
  useEffect(() => {
    if (!desktopAvailable) return
    command('set_recent_projects', {
      projects: recentProjects.map((path) => ({ name: displayName(path), path, branch: null })),
    }).catch(() => undefined)
  }, [desktopAvailable, recentProjects])

  return menuActionRef
}
