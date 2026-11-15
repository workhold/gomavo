export interface NavigationLocation<ViewState = unknown> {
  path: string
  line: number
  column: number
  viewState?: ViewState | null
}

function samePosition(a: NavigationLocation, b: NavigationLocation): boolean {
  return a.path === b.path && a.line === b.line && a.column === b.column
}

/** A bounded location history, with the current editor position refreshed before leaving it. */
export class NavigationHistory<ViewState = unknown> {
  private entries: NavigationLocation<ViewState>[] = []
  private index = -1

  get canGoBack(): boolean { return this.index > 0 }
  get canGoForward(): boolean { return this.index >= 0 && this.index < this.entries.length - 1 }
  peekBack(): NavigationLocation<ViewState> | null { return this.canGoBack ? this.entries[this.index - 1] : null }
  peekForward(): NavigationLocation<ViewState> | null { return this.canGoForward ? this.entries[this.index + 1] : null }

  clear(): void {
    this.entries = []
    this.index = -1
  }

  push(from: NavigationLocation<ViewState> | null, to: NavigationLocation<ViewState>): void {
    if (from && samePosition(from, to)) return
    this.entries = this.entries.slice(0, this.index + 1)
    if (from) {
      if (this.entries.length && this.entries.at(-1)!.path === from.path) {
        this.entries[this.entries.length - 1] = from
      } else if (!this.entries.length || !samePosition(this.entries.at(-1)!, from)) {
        this.entries.push(from)
      }
    }
    if (!this.entries.length || !samePosition(this.entries.at(-1)!, to)) this.entries.push(to)
    while (this.entries.length > 100) this.entries.shift()
    this.index = this.entries.length - 1
  }

  back(current: NavigationLocation<ViewState> | null): NavigationLocation<ViewState> | null {
    return this.step(-1, current)
  }

  forward(current: NavigationLocation<ViewState> | null): NavigationLocation<ViewState> | null {
    return this.step(1, current)
  }

  private step(direction: -1 | 1, current: NavigationLocation<ViewState> | null): NavigationLocation<ViewState> | null {
    const next = this.index + direction
    if (next < 0 || next >= this.entries.length) return null
    if (current && this.entries[this.index].path === current.path) this.entries[this.index] = current
    this.index = next
    return this.entries[next]
  }

  remapPaths(remap: (path: string) => string): void {
    this.entries = this.entries.map((entry) => ({ ...entry, path: remap(entry.path) }))
  }

  removePaths(removed: (path: string) => boolean): void {
    const current = this.entries[this.index]
    this.entries = this.entries.filter((entry) => !removed(entry.path))
    this.index = current && !removed(current.path) ? this.entries.indexOf(current) : Math.min(this.index, this.entries.length - 1)
  }

  /** Newest-first distinct locations, for the recent-files palette. */
  recent(limit: number): NavigationLocation<ViewState>[] {
    const seen = new Set<string>()
    const result: NavigationLocation<ViewState>[] = []
    for (let index = this.entries.length - 1; index >= 0 && result.length < limit; index -= 1) {
      const entry = this.entries[index]
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      result.push(entry)
    }
    return result
  }
}
