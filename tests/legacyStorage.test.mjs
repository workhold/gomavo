import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateLegacyLocalStorage } from '../src/lib/legacyStorage.ts'

test('rebrand copies existing settings without replacing new settings', () => {
  const values = new Map([
    ['mgland.locale', 'en-US'],
    ['mgland.preferences.v1', '{"theme":"dark"}'],
    ['gomavo.preferences.v1', '{"theme":"light"}'],
    ['mgland.recentProjects', '["/project"]'],
  ])
  const storage = {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
  }
  migrateLegacyLocalStorage(storage)
  assert.equal(values.get('gomavo.locale'), 'en-US')
  assert.equal(values.get('gomavo.preferences.v1'), '{"theme":"light"}')
  assert.equal(values.get('gomavo.recentProjects'), '["/project"]')
  migrateLegacyLocalStorage(storage)
  assert.equal(values.get('gomavo.recentProjects'), '["/project"]')
})
