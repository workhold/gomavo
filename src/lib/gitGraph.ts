// Layout for the Git log graph: assigns commits to lanes and emits the edge
// moves a renderer draws between consecutive rows.

export type GraphCommitInput = { hash: string; parents: string[] }

export type GraphEdge = {
  /** Lane at the top of the row. */
  from: number
  /** Lane at the bottom of the row. */
  to: number
  /** True when the edge leaves this row's commit node. */
  fromNode: boolean
}

export type GraphRow = {
  /** Lane of this commit's node. */
  column: number
  edges: GraphEdge[]
}

/**
 * Compute lanes for commits in `--topo-order` (newest first). Pass-through
 * lanes become vertical segments (`from === to`); merges and forks produce
 * diagonals into the parent's lane.
 */
export function computeGraphRows(commits: GraphCommitInput[]): GraphRow[] {
  const rows: GraphRow[] = []
  /** Parent hash -> active lane index. */
  let lanes = new Map<string, number>()

  const allocateLane = (hash: string): number => {
    const existing = lanes.get(hash)
    if (existing !== undefined) return existing
    const used = new Set(lanes.values())
    let lane = 0
    while (used.has(lane)) lane += 1
    lanes.set(hash, lane)
    return lane
  }

  for (const commit of commits) {
    const before = new Map(lanes)
    const column = allocateLane(commit.hash)
    lanes.delete(commit.hash)
    // The commit's lane is freed for its first parent; further parents take
    // the next free lanes so siblings never share a track.
    const after = new Map<string, number>()
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        const lane = allocateLane(parent)
        after.set(parent, lane)
      } else {
        after.set(parent, allocateLane(parent))
      }
    })
    // Rebuild the lane map: untouched pass-through lanes keep their columns.
    const next = new Map<string, number>()
    for (const [hash, lane] of before) {
      if (hash === commit.hash) continue
      next.set(hash, after.get(hash) ?? lane)
    }
    for (const [hash, lane] of after) {
      next.set(hash, next.get(hash) ?? lane)
    }
    lanes = next

    const edges: GraphEdge[] = []
    // Pass-through lanes (including verticals) are drawn through this row.
    for (const [hash, lane] of before) {
      if (hash === commit.hash) continue
      const target = lanes.get(hash)
      if (target !== undefined) edges.push({ from: lane, to: target, fromNode: false })
    }
    commit.parents.forEach((parent) => {
      const target = lanes.get(parent)
      if (target !== undefined) edges.push({ from: column, to: target, fromNode: true })
    })
    rows.push({ column, edges })
  }
  return rows
}
