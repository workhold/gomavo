import type * as Monaco from 'monaco-editor'

export type LocalHistoryKind = 'edit' | 'undo' | 'redo' | 'external'

export type LocalHistoryChange = Partial<Pick<Monaco.editor.IModelContentChangedEvent, 'changes' | 'isUndoing' | 'isRedoing' | 'isFlush'>>

export interface LocalHistoryEntry {
  id: number
  path: string
  kind: LocalHistoryKind
  at: number
  line: number | null
  changeCount: number
  before: string
  after: string
}

export interface LocalHistoryOptions {
  /** Maximum number of visible edits for one file. */
  maxEntriesPerFile?: number
  /** Maximum number of files remembered in the current app session. */
  maxFiles?: number
  /** Files larger than this are omitted from local history. */
  maxFileChars?: number
  /** Shared character budget for retained snapshots. */
  maxTotalChars?: number
  /** Nearby typing within this interval is shown as one edit. */
  typingGroupMs?: number
}

interface Revision {
  id: number
  kind: LocalHistoryKind
  at: number
  line: number | null
  changeCount: number
  after: string
  groupable: boolean
}

interface FileHistory {
  base: string
  revisions: Revision[]
  touchedAt: number
}

const DEFAULTS: Required<LocalHistoryOptions> = {
  maxEntriesPerFile: 40,
  maxFiles: 12,
  maxFileChars: 250_000,
  maxTotalChars: 3_000_000,
  typingGroupMs: 1_200,
}

function changeLine(change?: LocalHistoryChange): number | null {
  const lines = change?.changes?.map((item) => item.range.startLineNumber) ?? []
  return lines.length ? Math.min(...lines) : null
}

function isSmallTyping(change?: LocalHistoryChange): boolean {
  if (change?.isFlush || change?.changes?.length !== 1) return false
  const item = change.changes[0]
  return item.rangeLength <= 2 && item.text.length <= 2
}

/**
 * A bounded, in-memory view of edits observed through Monaco's public change
 * event. Monaco does not expose its native undo stack; these entries describe
 * observed edit groups and undo/redo actions, not private stack elements.
 */
export class LocalEditHistory {
  private readonly options: Required<LocalHistoryOptions>
  private readonly files = new Map<string, FileHistory>()
  private nextId = 1

  constructor(options: LocalHistoryOptions = {}) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Open/reopen a file without discarding edits retained earlier this session. */
  ensureFile(path: string, content: string, at = Date.now()): boolean {
    if (content.length > this.options.maxFileChars) {
      this.files.delete(path)
      return false
    }
    const file = this.files.get(path)
    if (!file) {
      this.files.set(path, { base: content, revisions: [], touchedAt: at })
      this.trim()
      return true
    }
    file.touchedAt = at
    const latest = file.revisions.at(-1)?.after ?? file.base
    if (latest !== content) this.append(file, content, 'external', null, 1, false, at)
    this.trim()
    return true
  }

  /** Record a real content change, usually from @monaco-editor/react onChange. */
  record(path: string, before: string, after: string, change?: LocalHistoryChange, at = Date.now()): boolean {
    if (before === after) return false
    if (before.length > this.options.maxFileChars || after.length > this.options.maxFileChars) {
      this.files.delete(path)
      return false
    }
    if (!this.files.has(path)) this.ensureFile(path, before, at)
    const file = this.files.get(path)
    if (!file) return false
    const latest = file.revisions.at(-1)?.after ?? file.base
    if (latest !== before) this.append(file, before, 'external', null, 1, false, at)

    const kind: LocalHistoryKind = change?.isUndoing ? 'undo' : change?.isRedoing ? 'redo' : 'edit'
    const line = changeLine(change)
    const groupable = kind === 'edit' && isSmallTyping(change)
    const previous = file.revisions.at(-1)
    if (groupable && previous?.kind === 'edit' && previous.groupable &&
      at >= previous.at && at - previous.at <= this.options.typingGroupMs &&
      (line === null || previous.line === null || Math.abs(line - previous.line) <= 1)) {
      previous.after = after
      previous.at = at
      previous.changeCount += change?.changes?.length ?? 1
      file.touchedAt = at
      const priorContent = file.revisions.length > 1 ? file.revisions[file.revisions.length - 2].after : file.base
      if (priorContent === after) file.revisions.pop()
    } else {
      this.append(file, after, kind, line, change?.changes?.length ?? 1, groupable, at)
    }
    this.trim()
    return true
  }

  /** Entries are newest first; each contains the exact before/after text for a diff. */
  getEntries(path: string): LocalHistoryEntry[] {
    const file = this.files.get(path)
    if (!file) return []
    return file.revisions.map((revision, index) => ({
      id: revision.id,
      path,
      kind: revision.kind,
      at: revision.at,
      line: revision.line,
      changeCount: revision.changeCount,
      before: index ? file.revisions[index - 1].after : file.base,
      after: revision.after,
    })).reverse()
  }

  clear(): void { this.files.clear() }

  removePaths(removed: (path: string) => boolean): void {
    for (const path of this.files.keys()) if (removed(path)) this.files.delete(path)
  }

  remapPaths(remap: (path: string) => string): void {
    const entries = [...this.files.entries()]
    this.files.clear()
    for (const [path, history] of entries) this.files.set(remap(path), history)
  }

  private append(file: FileHistory, after: string, kind: LocalHistoryKind, line: number | null, changeCount: number, groupable: boolean, at: number): void {
    file.revisions.push({ id: this.nextId++, kind, at, line, changeCount, after, groupable })
    file.touchedAt = at
  }

  private trim(): void {
    const { maxEntriesPerFile, maxFiles, maxTotalChars } = this.options
    for (const file of this.files.values()) {
      while (file.revisions.length > maxEntriesPerFile) this.dropOldestRevision(file)
    }
    while (this.files.size > maxFiles) {
      const oldest = [...this.files].reduce((a, b) => a[1].touchedAt <= b[1].touchedAt ? a : b)
      this.files.delete(oldest[0])
    }
    const size = () => [...this.files.values()].reduce((sum, file) =>
      sum + file.base.length + file.revisions.reduce((revisionSum, revision) => revisionSum + revision.after.length, 0), 0)
    while (this.files.size && size() > maxTotalChars) {
      const candidates = [...this.files.entries()].filter(([, file]) => file.revisions.length)
      if (!candidates.length) {
        const oldest = [...this.files].reduce((a, b) => a[1].touchedAt <= b[1].touchedAt ? a : b)
        this.files.delete(oldest[0])
      } else {
        const oldest = candidates.reduce((a, b) => a[1].revisions[0].at <= b[1].revisions[0].at ? a : b)
        this.dropOldestRevision(oldest[1])
      }
    }
  }

  private dropOldestRevision(file: FileHistory): void {
    const first = file.revisions.shift()
    if (first) file.base = first.after
  }
}

type DiffOperation = { type: ' ' | '+' | '-'; text: string }

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function lineOperations(before: string[], after: string[]): DiffOperation[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++

  const operations: DiffOperation[] = before.slice(0, prefix).map((text) => ({ type: ' ', text }))
  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const oldCount = oldMiddle.length
  const newCount = newMiddle.length

  if (oldCount * newCount <= 250_000) {
    const width = newCount + 1
    const lengths = new Uint32Array((oldCount + 1) * width)
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        lengths[i * width + j] = oldMiddle[i] === newMiddle[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && oldMiddle[i] === newMiddle[j]) {
        operations.push({ type: ' ', text: oldMiddle[i++] }); j++
      } else if (i < oldCount && (j === newCount || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        operations.push({ type: '-', text: oldMiddle[i++] })
      } else {
        operations.push({ type: '+', text: newMiddle[j++] })
      }
    }
  } else {
    for (const text of oldMiddle) operations.push({ type: '-', text })
    for (const text of newMiddle) operations.push({ type: '+', text })
  }
  for (const text of before.slice(before.length - suffix)) operations.push({ type: ' ', text })
  return operations
}

/** Create a small-context unified diff for a selected local edit. */
export function createLocalUnifiedDiff(before: string, after: string, path: string, context = 3): string {
  if (before === after) return ''
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const operations = lineOperations(oldLines, newLines)
  const oldFinalNewline = !before || before.endsWith('\n')
  const newFinalNewline = !after || after.endsWith('\n')
  if (oldFinalNewline !== newFinalNewline && oldLines.length && newLines.length &&
    operations.at(-1)?.type === ' ') {
    const last = operations.pop()!
    operations.push({ type: '-', text: last.text }, { type: '+', text: last.text })
  }
  const changed = operations.flatMap((item, index) => item.type === ' ' ? [] : [index])
  if (!changed.length) return ''

  const normalizedPath = path.replace(/[\r\n\t]/g, ' ')
  const lines = [`--- a/${normalizedPath}`, `+++ b/${normalizedPath}`]
  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(operations.length, index + context + 1)
    const last = ranges.at(-1)
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  const oldBefore = new Uint32Array(operations.length + 1)
  const newBefore = new Uint32Array(operations.length + 1)
  for (let index = 0; index < operations.length; index++) {
    oldBefore[index + 1] = oldBefore[index] + (operations[index].type === '+' ? 0 : 1)
    newBefore[index + 1] = newBefore[index] + (operations[index].type === '-' ? 0 : 1)
  }
  for (const { start, end } of ranges) {
    const oldCount = oldBefore[end] - oldBefore[start]
    const newCount = newBefore[end] - newBefore[start]
    const oldStart = oldBefore[start] + (oldCount ? 1 : 0)
    const newStart = newBefore[start] + (newCount ? 1 : 0)
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (let index = start; index < end; index++) {
      const operation = operations[index]
      lines.push(`${operation.type}${operation.text}`)
      const oldLast = operation.type !== '+' && oldBefore[index + 1] === oldLines.length && !oldFinalNewline
      const newLast = operation.type !== '-' && newBefore[index + 1] === newLines.length && !newFinalNewline
      if (oldLast || newLast) lines.push('\\ No newline at end of file')
    }
  }
  return `${lines.join('\n')}\n`
}
