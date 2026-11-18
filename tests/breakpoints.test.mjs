import assert from 'node:assert/strict'
import test from 'node:test'
import { validBreakpointLines } from '../src/lib/debug/breakpoints.ts'

test('removed tail lines cannot leave a visible breakpoint on the last line', () => {
  assert.deepEqual(validBreakpointLines([18], 2), [])
  assert.deepEqual(validBreakpointLines([1, 18], 2), [1])
})

test('valid breakpoints remain stable while corrupt or repeated lines are dropped', () => {
  assert.deepEqual(validBreakpointLines([3, 1, 3, 0, -2, 2.5, Number.NaN], 3), [1, 3])
})
