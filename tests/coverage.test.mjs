import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCoveragePath, coverageRanges, coveragePercent } from '../src/lib/coverage.ts'

test('resolveCoveragePath handles absolute, joined, and suffix matches', () => {
  const root = '/work/app'
  const files = ['/work/app/main.go', '/work/app/pkg/api.go']
  assert.equal(resolveCoveragePath('/work/app/main.go', root, files), '/work/app/main.go')
  assert.equal(resolveCoveragePath('pkg/api.go', root, files), '/work/app/pkg/api.go')
  assert.equal(resolveCoveragePath('github.com/other/dep/x.go', root, files), null)
})

test('coverageRanges merges blocks into per-line coverage', () => {
  const ranges = coverageRanges([
    { startLine: 1, startCol: 1, endLine: 2, endCol: 5, statements: 2, count: 1 },
    { startLine: 4, startCol: 1, endLine: 4, endCol: 9, statements: 1, count: 0 },
  ])
  assert.deepEqual(ranges, [
    { startLine: 1, endLine: 1, covered: true },
    { startLine: 2, endLine: 2, covered: true },
    { startLine: 4, endLine: 4, covered: false },
  ])
})

test('coveragePercent weights statements by execution', () => {
  assert.equal(coveragePercent([
    { startLine: 1, startCol: 1, endLine: 1, endCol: 5, statements: 3, count: 2 },
    { startLine: 2, startCol: 1, endLine: 2, endCol: 5, statements: 1, count: 0 },
  ]), 75)
  assert.equal(coveragePercent([]), 0)
})
