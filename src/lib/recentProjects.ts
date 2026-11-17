// Recent-project tracking for the welcome screen and project menu.

const STORAGE_KEY = 'gomavo.recentProjects'
const LIMIT = 10

export function loadRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, LIMIT)
  } catch {
    return []
  }
}

/** Move a workspace to the front of the list, dropping duplicates. */
export function rememberProject(path: string): string[] {
  const next = [path, ...loadRecentProjects().filter((item) => item !== path)].slice(0, LIMIT)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* storage may be full */ }
  return next
}

export function forgetProject(path: string): string[] {
  const next = loadRecentProjects().filter((item) => item !== path)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
