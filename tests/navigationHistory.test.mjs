import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationHistory } from '../src/lib/navigationHistory.ts'

const point = (path, line, column = 1, viewState) => ({ path, line, column, viewState })

test('back and forward restore the exact locations and latest editor view state', () => {
  const history = new NavigationHistory()
  history.push(point('/repo/a.go', 14, 7, { scrollTop: 320 }), point('/repo/b.go', 40, 3))
  history.push(point('/repo/b.go', 44, 9, { scrollTop: 800 }), point('/repo/b.go', 90, 5))

  assert.deepEqual(history.back(point('/repo/b.go', 92, 2, { scrollTop: 1500 })), point('/repo/b.go', 44, 9, { scrollTop: 800 }))
  assert.deepEqual(history.back(point('/repo/b.go', 46, 1, { scrollTop: 900 })), point('/repo/a.go', 14, 7, { scrollTop: 320 }))
  assert.equal(history.canGoBack, false)
  assert.deepEqual(history.forward(point('/repo/a.go', 16, 4, { scrollTop: 360 })), point('/repo/b.go', 46, 1, { scrollTop: 900 }))
  assert.deepEqual(history.forward(point('/repo/b.go', 47, 1, { scrollTop: 950 })), point('/repo/b.go', 92, 2, { scrollTop: 1500 }))
  assert.equal(history.canGoForward, false)
})

test('a new jump after going back drops the forward branch', () => {
  const history = new NavigationHistory()
  history.push(point('/repo/a.go', 1), point('/repo/b.go', 2))
  history.push(point('/repo/b.go', 2), point('/repo/c.go', 3))
  history.back(point('/repo/c.go', 3))
  history.push(point('/repo/b.go', 9), point('/repo/d.go', 4))

  assert.equal(history.canGoForward, false)
  assert.deepEqual(history.back(point('/repo/d.go', 4)), point('/repo/b.go', 9))
  assert.deepEqual(history.back(point('/repo/b.go', 9)), point('/repo/a.go', 1))
})

test('rename remaps history and deleting a file removes its locations', () => {
  const history = new NavigationHistory()
  history.push(point('/repo/old/a.go', 1), point('/repo/old/b.go', 2))
  history.push(point('/repo/old/b.go', 2), point('/repo/elsewhere.go', 3))
  history.remapPaths((path) => path.replace('/repo/old/', '/repo/new/'))
  assert.deepEqual(history.back(point('/repo/elsewhere.go', 3)), point('/repo/new/b.go', 2))

  history.removePaths((path) => path === '/repo/new/b.go')
  assert.deepEqual(history.back(null), point('/repo/new/a.go', 1))
  assert.equal(history.canGoBack, false)
})

test('recent returns newest-first distinct paths', () => {
  const history = new NavigationHistory()
  history.push(null, { path: '/a.go', line: 1, column: 1 })
  history.push({ path: '/a.go', line: 2, column: 1 }, { path: '/b.go', line: 1, column: 1 })
  history.push({ path: '/b.go', line: 3, column: 1 }, { path: '/a.go', line: 9, column: 1 })
  history.push({ path: '/a.go', line: 9, column: 2 }, { path: '/c.go', line: 1, column: 1 })
  const recent = history.recent(2)
  assert.deepEqual(recent.map((entry) => entry.path), ['/c.go', '/a.go'])
})
