const LEGACY_SUFFIXES = [
  'locale',
  'preferences.v1',
  'project-go.v1',
  'plugins.v1',
  'recentProjects',
  'breakpoints',
  'breakpointSpecs',
  'bookmarks',
  'lastWorkspace',
  'projectParent',
  'bottomPanel.height',
] as const

/** Preserve settings from existing installs without overwriting newer GoMavo data. */
export function migrateLegacyLocalStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  for (const suffix of LEGACY_SUFFIXES) {
    try {
      const currentKey = `gomavo.${suffix}`
      const legacyValue = storage.getItem(`mgland.${suffix}`)
      if (legacyValue !== null && storage.getItem(currentKey) === null) {
        storage.setItem(currentKey, legacyValue)
      }
    } catch { /* storage may be unavailable or full; other keys can still migrate */ }
  }
}
