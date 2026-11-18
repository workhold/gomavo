export type DiffLineKind = 'file' | 'meta' | 'hunk' | 'addition' | 'deletion' | 'context' | 'marker'

export type DiffLine = {
  kind: DiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

export type SideBySideRow =
  | { kind: 'header'; line: DiffLine }
  | { kind: 'content'; old: DiffLine | null; next: DiffLine | null }

/** Align removed and added lines in each change block for a two-column diff. */
export function sideBySideRows(lines: readonly DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  let markers: DiffLine[] = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      rows.push({ kind: 'content', old: removed[index] ?? null, next: added[index] ?? null })
    }
    removed = []
    added = []
    for (const marker of markers) rows.push({ kind: 'header', line: marker })
    markers = []
  }
  for (const line of lines) {
    if (line.kind === 'deletion') { removed.push(line); continue }
    if (line.kind === 'addition') { added.push(line); continue }
    if (line.kind === 'marker' && (removed.length || added.length)) { markers.push(line); continue }
    flush()
    if (line.kind === 'context') rows.push({ kind: 'content', old: line, next: line })
    else rows.push({ kind: 'header', line })
  }
  flush()
  return rows
}

/** Parse a unified patch without interpreting its file content as markup. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return []

  const sourceLines = diff.split('\n')
  if (sourceLines.at(-1) === '') sourceLines.pop()

  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const sourceLine of sourceLines) {
    const text = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine

    if (text.startsWith('diff --git ') || text.startsWith('diff --no-index ')) {
      inHunk = false
      lines.push({ kind: 'file', text, oldLine: null, newLine: null })
      continue
    }

    const hunk = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/.exec(text)
    if (hunk?.groups) {
      oldLine = Number(hunk.groups.old)
      newLine = Number(hunk.groups.new)
      inHunk = true
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null })
      continue
    }

    if (text.startsWith('\\ No newline at end of file')) {
      lines.push({ kind: 'marker', text, oldLine: null, newLine: null })
      continue
    }

    if (!inHunk) {
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null })
      continue
    }

    if (text.startsWith('+')) {
      lines.push({ kind: 'addition', text, oldLine: null, newLine: newLine++ })
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'deletion', text, oldLine: oldLine++, newLine: null })
    } else if (text.startsWith(' ')) {
      lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
    } else {
      // Git metadata can follow a hunk (for example in a combined patch).
      inHunk = false
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null })
    }
  }

  return lines
}
