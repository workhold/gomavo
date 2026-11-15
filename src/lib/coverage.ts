// Coverage profile helpers: resolve `go test -coverprofile` paths and map
// blocks to editor decoration ranges.

export interface CoverageBlockInput {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  statements: number
  count: number
}

export interface CoverageFileInput {
  path: string
  blocks: CoverageBlockInput[]
}

export interface CoverageProfileInput {
  mode: string
  files: CoverageFileInput[]
}

export interface CoveredRange {
  startLine: number
  endLine: number
  covered: boolean
}

/**
 * Resolve one profile entry against the workspace: cover profiles use
 * absolute paths for workspace files and import paths for dependencies, so
 * try the absolute path, the workspace join, and a project-file suffix match.
 */
export function resolveCoveragePath(rawPath: string, root: string, projectFilePaths: string[]): string | null {
  if (rawPath.startsWith('/')) {
    if (rawPath.startsWith(root)) return rawPath
    return projectFilePaths.find((path) => path === rawPath) ?? null
  }
  const joined = `${root}/${rawPath}`
  if (projectFilePaths.includes(joined)) return joined
  const suffix = `/${rawPath}`
  const candidates = projectFilePaths.filter((path) => path.endsWith(suffix))
  return candidates.length ? candidates.sort((a, b) => a.length - b.length)[0] : null
}

/** Merge a file's blocks into per-line ranges for gutter decorations. */
export function coverageRanges(blocks: CoverageBlockInput[]): CoveredRange[] {
  const lineCounts = new Map<number, { statements: number; covered: number }>()
  for (const block of blocks) {
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      const entry = lineCounts.get(line) ?? { statements: 0, covered: 0 }
      entry.statements += block.statements
      if (block.count > 0) entry.covered += block.statements
      lineCounts.set(line, entry)
    }
  }
  return [...lineCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, entry]) => ({ startLine: line, endLine: line, covered: entry.covered > 0 }))
}

export function coveragePercent(blocks: CoverageBlockInput[]): number {
  const statements = blocks.reduce((total, block) => total + block.statements, 0)
  if (!statements) return 0
  const covered = blocks.reduce((total, block) => total + (block.count > 0 ? block.statements : 0), 0)
  return Math.round((covered / statements) * 100)
}
