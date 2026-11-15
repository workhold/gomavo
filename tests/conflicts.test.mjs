import assert from 'node:assert/strict'
import test from 'node:test'
import { findConflictBlocks, applyResolutions } from '../src/lib/conflicts.ts'

const SOURCE = [
  'package main',
  '',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  '',
  'trailing',
].join('\n')

test('findConflictBlocks reports both sides with one-based lines', () => {
  const blocks = findConflictBlocks(SOURCE)
  assert.equal(blocks.length, 1)
  const block = blocks[0]
  assert.equal(block.startLine, 3)
  assert.equal(block.endLine, 7)
  assert.equal(block.oursStart, 4)
  assert.equal(block.oursEnd, 4)
  assert.equal(block.theirsStart, 6)
  assert.equal(block.theirsEnd, 6)
})

test('applyResolutions honors each choice per conflict', () => {
  assert.equal(
    applyResolutions(SOURCE, ['ours']),
    ['package main', '', 'ours line', '', 'trailing'].join('\n'),
  )
  assert.equal(
    applyResolutions(SOURCE, ['theirs']),
    ['package main', '', 'theirs line', '', 'trailing'].join('\n'),
  )
  assert.equal(
    applyResolutions(SOURCE, ['none']),
    ['package main', '', '', 'trailing'].join('\n'),
  )
})

test('multiple conflicts apply without offset drift', () => {
  const two = ['<<<<<<< a', 'one', '=======', 'two', '>>>>>>> a',
    'middle',
    '<<<<<<< b', 'three', '=======', 'four', '>>>>>>> b'].join('\n')
  assert.equal(
    applyResolutions(two, ['ours', 'theirs']),
    ['one', 'middle', 'four'].join('\n'),
  )
})
