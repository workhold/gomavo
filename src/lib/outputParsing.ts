// Terminal-style output parsing for the Run console: ANSI SGR colors and
// clickable `file:line[:col]` references, in the spirit of GoLand's console.

export type OutputSpan = { text: string; className?: string }

const SGR_CLASS: Record<number, string> = {
  30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
  34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
  90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green',
  93: 'ansi-bright-yellow', 94: 'ansi-bright-blue', 95: 'ansi-bright-magenta',
  96: 'ansi-bright-cyan', 97: 'ansi-bright-white',
}

/** Split one console line into colored spans, dropping other ANSI sequences. */
export function parseAnsiLine(line: string): OutputSpan[] {
  const spans: OutputSpan[] = []
  let plain = ''
  let className: string | undefined
  const flush = () => {
    if (plain) { spans.push({ text: plain, className }); plain = '' }
  }
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char !== '\u001b' || line[index + 1] !== '[') {
      plain += char
      index += 1
      continue
    }
    const end = line.indexOf('m', index + 2)
    if (end < 0) {
      plain += line.slice(index)
      break
    }
    const codes = line.slice(index + 2, end).split(';').map((code) => Number.parseInt(code, 10) || 0)
    flush()
    // Only SGR ('m') sequences are interpreted; CSI sequences without 'm'
    // cannot appear here because we searched for the 'm' terminator.
    if (codes.includes(0)) {
      className = undefined
    } else {
      const next: string[] = []
      let brightened = false
      for (const code of codes) {
        if (code === 1) brightened = true
        if (SGR_CLASS[code]) next.push(SGR_CLASS[code])
      }
      if (brightened && next.length) next.push('ansi-bold')
      className = next.length ? next.join(' ') : className
    }
    index = end + 1
  }
  flush()
  return spans.length ? spans : [{ text: line }]
}

export type OutputReference = {
  /** Text of the match for display. */
  text: string
  /** Candidate absolute paths in the workspace, best guess first. */
  paths: Array<{ path: string; line: number; column?: number }>
}

const REFERENCE_PATTERN = /((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.(?:go|mod|sum|s|json|yaml|yml|md)):(\d+)(?::(\d+))?/g

/** Find `file.go:12:3` references in one console line. */
export function findOutputReferences(line: string): OutputReference[] {
  const references: OutputReference[] = []
  for (const match of line.matchAll(REFERENCE_PATTERN)) {
    const text = match[1]
    const line_ = Number.parseInt(match[2], 10)
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined
    references.push({ text, paths: [{ path: text, line: line_, column }] })
  }
  return references
}

/**
 * Resolve a `file:line` reference against the project's file index. `go test`
 * prints package-relative paths, so match by path suffix when the reference
 * is not already absolute, preferring exact relative-path matches.
 */
export function resolveOutputReference(reference: OutputReference, root: string | null, projectFilePaths: string[]): string | null {
  const raw = reference.paths[0]?.path
  if (!raw) return null
  if (raw.startsWith('/')) return projectFilePaths.includes(raw) || !root ? raw : raw
  if (!root) return null
  const normalized = raw.replace(/\\/g, '/')
  const suffix = `/${normalized}`
  const candidates = projectFilePaths.filter((path) => path === normalized || path.endsWith(suffix))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    // Prefer the shortest path: closest to the workspace root.
    return [...candidates].sort((a, b) => a.length - b.length)[0]
  }
  return null
}
