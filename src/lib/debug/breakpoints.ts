/** Keep persisted breakpoints within the current Monaco model. */
export function validBreakpointLines(lines: readonly number[], lineCount: number): number[] {
  return [...new Set(lines.filter((line) => Number.isInteger(line) && line >= 1 && line <= lineCount))]
    .sort((a, b) => a - b)
}
