import type { MonacoContentChange } from './protocol'

/** Monaco's ranges and offsets refer to the text before the whole event. */
export function applyMonacoContentChanges(
  original: string,
  changes: readonly MonacoContentChange[],
): string | null {
  const descending = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)
  let previousStart = original.length
  let result = original
  for (const change of descending) {
    const { rangeOffset: start, rangeLength: length } = change
    if (!Number.isInteger(start) || !Number.isInteger(length)
      || start < 0 || length < 0 || start + length > previousStart) return null
    result = result.slice(0, start) + change.text + result.slice(start + length)
    previousStart = start
  }
  return result
}
