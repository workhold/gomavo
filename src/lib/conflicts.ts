// Conflict-marker parsing for the merge resolution view. Git leaves
// `<<<<<<<`/`=======`/`>>>>>>>` blocks; this module locates them and applies
// per-conflict choices (ours/theirs/both/none) to rebuild the file.

export interface ConflictChoice {
  ours: boolean
  theirs: boolean
}

export interface ConflictBlock {
  /** One-based line of the `<<<<<<<` marker. */
  startLine: number
  /** One-based line of the `>>>>>>>` marker. */
  endLine: number
  /** Lines between `<<<<<<<` and `=======` (inclusive bounds, 1-based). */
  oursStart: number
  oursEnd: number
  /** Lines between `=======` and `>>>>>>>`. */
  theirsStart: number
  theirsEnd: number
}

export type ConflictResolution = 'ours' | 'theirs' | 'both' | 'none'

export function findConflictBlocks(source: string): ConflictBlock[] {
  const lines = source.split('\n')
  const blocks: ConflictBlock[] = []
  let stage: 'none' | 'ours' | 'separator' = 'none'
  let start = 0
  let separator = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (stage === 'none' && line.startsWith('<<<<<<<')) {
      stage = 'ours'
      start = index
    } else if (stage === 'ours' && line.startsWith('=======') && !line.startsWith('==========')) {
      stage = 'separator'
      separator = index
    } else if (stage === 'separator' && line.startsWith('>>>>>>>')) {
      blocks.push({
        startLine: start + 1,
        endLine: index + 1,
        oursStart: start + 2,
        oursEnd: separator,
        theirsStart: separator + 2,
        theirsEnd: index,
      })
      stage = 'none'
    }
  }
  return blocks
}

/** Rebuild the file with one chosen resolution per conflict, in order. */
export function applyResolutions(source: string, choices: ConflictResolution[]): string {
  const blocks = findConflictBlocks(source)
  const lines = source.split('\n')
  // Apply from the end so earlier offsets stay valid.
  const result = [...lines]
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    const choice = choices[index] ?? 'both'
    const ours = lines.slice(block.oursStart - 1, block.oursEnd)
    const theirs = lines.slice(block.theirsStart - 1, block.theirsEnd)
    const replacement =
      choice === 'ours' ? ours
        : choice === 'theirs' ? theirs
          : choice === 'both' ? [...ours, '', ...theirs]
            : []
    result.splice(block.startLine - 1, block.endLine - block.startLine + 1, ...replacement)
  }
  return result.join('\n')
}
