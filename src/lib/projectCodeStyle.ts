import type { GoPreferences } from './preferences'

export const PROJECT_CODE_STYLE_DIRECTORY = '.gomavo'
export const PROJECT_CODE_STYLE_FILE = 'code-style.json'
const LEGACY_PROJECT_CODE_STYLE_DIRECTORY = '.mgland'

export interface ProjectCodeStyleIO {
  listDirectory(path: string): Promise<Array<{ name: string; is_dir: boolean }>>
  readFile(path: string): Promise<string>
  createDirectory(path: string): Promise<void>
  createFile(path: string, content: string): Promise<void>
  writeFile(path: string, content: string, expectedContent: string): Promise<void>
}

const GO_STYLE_KEYS = [
  'formatOnSave', 'organizeImportsOnSave', 'staticcheck',
  'gofumpt', 'inlayHints', 'localPrefix',
] as const satisfies readonly (keyof GoPreferences)[]

function join(root: string, name: string): string {
  return `${root.replace(/\/+$/, '')}/${name}`
}

export function projectCodeStylePath(root: string): string {
  return join(join(root, PROJECT_CODE_STYLE_DIRECTORY), PROJECT_CODE_STYLE_FILE)
}

/** Only known keys are used, so an edited project file cannot inject arbitrary preferences. */
export function parseProjectCodeStyle(content: string): Partial<GoPreferences> {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Unsupported .gomavo/code-style.json version')
  }
  const go = (parsed as { go?: unknown }).go
  if (go === undefined) return {}
  if (!go || typeof go !== 'object' || Array.isArray(go)) {
    throw new Error('Invalid .gomavo/code-style.json Go settings')
  }
  const source = go as Record<string, unknown>
  const result: Partial<GoPreferences> = {}
  for (const key of GO_STYLE_KEYS) {
    if (!(key in source)) continue
    const value = source[key]
    if (key === 'localPrefix') {
      if (typeof value !== 'string' || value.length > 500) throw new Error(`Invalid Go style setting: ${key}`)
      result.localPrefix = value
    } else if (typeof value === 'boolean') {
      Object.assign(result, { [key]: value })
    } else throw new Error(`Invalid Go style setting: ${key}`)
  }
  return result
}

export function serializeProjectCodeStyle(go: Partial<GoPreferences>): string {
  const known: Partial<GoPreferences> = {}
  for (const key of GO_STYLE_KEYS) if (key in go) Object.assign(known, { [key]: go[key] })
  return `${JSON.stringify({ version: 1, go: known }, null, 2)}\n`
}

export async function projectCodeStyleExists(root: string, io: ProjectCodeStyleIO): Promise<boolean> {
  const directory = join(root, PROJECT_CODE_STYLE_DIRECTORY)
  const rootEntries = await io.listDirectory(root)
  if (!rootEntries.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) return false
  const entries = await io.listDirectory(directory)
  return entries.some((entry) => entry.name === PROJECT_CODE_STYLE_FILE && !entry.is_dir)
}

export interface ProjectCodeStyleSnapshot {
  go: Partial<GoPreferences>
  content: string
}

/** Keep the exact disk text for checked writes; other read errors propagate. */
export async function loadProjectCodeStyleSnapshot(root: string, io: ProjectCodeStyleIO): Promise<ProjectCodeStyleSnapshot | null> {
  if (!await projectCodeStyleExists(root, io)) return null
  const content = await io.readFile(projectCodeStylePath(root))
  return { go: parseProjectCodeStyle(content), content }
}

/** Copy a previous release's project settings into the new directory once. */
export async function migrateLegacyProjectCodeStyle(root: string, io: ProjectCodeStyleIO): Promise<ProjectCodeStyleSnapshot | null> {
  const existing = await loadProjectCodeStyleSnapshot(root, io)
  if (existing) return existing
  const rootEntries = await io.listDirectory(root)
  if (!rootEntries.some((entry) => entry.name === LEGACY_PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) return null
  const legacyDirectory = join(root, LEGACY_PROJECT_CODE_STYLE_DIRECTORY)
  const legacyEntries = await io.listDirectory(legacyDirectory)
  if (!legacyEntries.some((entry) => entry.name === PROJECT_CODE_STYLE_FILE && !entry.is_dir)) return null
  const content = await io.readFile(join(legacyDirectory, PROJECT_CODE_STYLE_FILE))
  const go = parseProjectCodeStyle(content)
  const directory = join(root, PROJECT_CODE_STYLE_DIRECTORY)
  if (!rootEntries.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) {
    if (rootEntries.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY)) throw new Error(`${directory} is not a directory`)
    try { await io.createDirectory(directory) }
    catch (cause) {
      const latest = await io.listDirectory(root)
      if (!latest.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) throw cause
    }
  }
  try {
    await io.createFile(projectCodeStylePath(root), content)
    return { go, content }
  } catch (cause) {
    const concurrent = await loadProjectCodeStyleSnapshot(root, io)
    if (concurrent) return concurrent
    throw cause
  }
}

/** Return null when the project has no own style file. */
export async function loadProjectCodeStyle(root: string, io: ProjectCodeStyleIO): Promise<Partial<GoPreferences> | null> {
  return (await loadProjectCodeStyleSnapshot(root, io))?.go ?? null
}

/** Create a style file without replacing one created by another editor. */
export async function createProjectCodeStyleIfMissing(root: string, go: Partial<GoPreferences>, io: ProjectCodeStyleIO): Promise<boolean> {
  const directory = join(root, PROJECT_CODE_STYLE_DIRECTORY)
  const entries = await io.listDirectory(root)
  if (!entries.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) {
    if (entries.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY)) {
      throw new Error(`${directory} is not a directory`)
    }
    try { await io.createDirectory(directory) }
    catch (cause) {
      const latest = await io.listDirectory(root)
      if (!latest.some((entry) => entry.name === PROJECT_CODE_STYLE_DIRECTORY && entry.is_dir)) throw cause
    }
  }
  try {
    await io.createFile(projectCodeStylePath(root), serializeProjectCodeStyle(go))
    return true
  } catch (cause) {
    if (await projectCodeStyleExists(root, io)) return false
    throw cause
  }
}

/** Update a known file only if another editor has not changed it since load. */
export async function saveProjectCodeStyle(root: string, go: Partial<GoPreferences>, io: ProjectCodeStyleIO, expectedContent: string): Promise<string> {
  const path = projectCodeStylePath(root)
  parseProjectCodeStyle(expectedContent)
  const document = JSON.parse(expectedContent) as Record<string, unknown>
  const previousGo = document.go as Record<string, unknown> | undefined
  const nextGo = { ...previousGo }
  for (const key of GO_STYLE_KEYS) delete nextGo[key]
  for (const key of GO_STYLE_KEYS) if (key in go) nextGo[key] = go[key]
  const content = `${JSON.stringify({ ...document, go: nextGo }, null, 2)}\n`
  await io.writeFile(path, content, expectedContent)
  return content
}
