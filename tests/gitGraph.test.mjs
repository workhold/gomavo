import assert from 'node:assert/strict'
import test from 'node:test'
import { computeGraphRows } from '../src/lib/gitGraph.ts'

test('linear history keeps one lane', () => {
  const rows = computeGraphRows([
    { hash: 'c3', parents: ['c2'] },
    { hash: 'c2', parents: ['c1'] },
    { hash: 'c1', parents: [] },
  ])
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 0])
  assert.deepEqual(rows[0].edges, [{ from: 0, to: 0, fromNode: true }])
  assert.deepEqual(rows[2].edges, [])
})

test('a merge fan-out reuses the first lane and opens a new one', () => {
  const rows = computeGraphRows([
    { hash: 'm', parents: ['a', 'b'] },
    { hash: 'a', parents: [] },
    { hash: 'b', parents: [] },
  ])
  assert.equal(rows[0].column, 0)
  assert.deepEqual(rows[0].edges, [
    { from: 0, to: 0, fromNode: true },
    { from: 0, to: 1, fromNode: true },
  ])
  assert.equal(rows[1].column, 0)
  assert.equal(rows[2].column, 1)
  assert.deepEqual(rows[2].edges, [])
})

test('pass-through lanes keep their column across a row', () => {
  const rows = computeGraphRows([
    { hash: 'm', parents: ['a', 'b'] },
    { hash: 'a', parents: ['a1'] },
    { hash: 'b', parents: [] },
    { hash: 'a1', parents: [] },
  ])
  // While 'a' is processed, lane 1 carries 'b' straight down.
  assert.deepEqual(rows[1].edges, [
    { from: 1, to: 1, fromNode: false },
    { from: 0, to: 0, fromNode: true },
  ])
  assert.equal(rows[2].column, 1)
  assert.equal(rows[3].column, 0)
})
