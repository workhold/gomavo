import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProjectCodeStyleIfMissing, loadProjectCodeStyle, loadProjectCodeStyleSnapshot, parseProjectCodeStyle, projectCodeStyleExists, projectCodeStylePath,
  saveProjectCodeStyle, serializeProjectCodeStyle,
} from '../src/lib/projectCodeStyle.ts'

test('project code style keeps supported Go overrides in .mgland/code-style.json', async () => {
  const files = new Map()
  const directories = new Set(['/project'])
  const io = {
    async listDirectory(path) {
      assert.ok(directories.has(path))
      return [
        ...[...directories].filter((entry) => entry !== path && entry.slice(0, entry.lastIndexOf('/')) === path)
          .map((entry) => ({ name: entry.slice(entry.lastIndexOf('/') + 1), is_dir: true })),
        ...[...files.keys()].filter((entry) => entry.slice(0, entry.lastIndexOf('/')) === path)
          .map((entry) => ({ name: entry.slice(entry.lastIndexOf('/') + 1), is_dir: false })),
      ]
    },
    async readFile(path) { return files.get(path) },
    async createDirectory(path) { directories.add(path) },
    async createFile(path, content) {
      if (files.has(path)) throw new Error('file exists')
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing')
      files.set(path, content)
    },
    async writeFile(path, content, expectedContent) {
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing')
      if (files.get(path) !== expectedContent) throw new Error('Save conflict: File changed on disk')
      files.set(path, content)
    },
  }

  assert.equal(await loadProjectCodeStyle('/project', io), null)
  assert.equal(await projectCodeStyleExists('/project', io), false)
  assert.equal(await createProjectCodeStyleIfMissing('/project', { localPrefix: 'example.com/app' }, io), true)
  const expected = files.get(projectCodeStylePath('/project'))
  await saveProjectCodeStyle('/project', { localPrefix: 'example.com/app', organizeImportsOnSave: false }, io, expected)
  assert.equal(await projectCodeStyleExists('/project', io), true)
  assert.equal(projectCodeStylePath('/project'), '/project/.mgland/code-style.json')
  assert.deepEqual(await loadProjectCodeStyle('/project', io), {
    organizeImportsOnSave: false,
    localPrefix: 'example.com/app',
  })
  assert.match(files.get(projectCodeStylePath('/project')), /"version": 1/)
  assert.equal((await loadProjectCodeStyleSnapshot('/project', io)).content, files.get(projectCodeStylePath('/project')))
  await assert.rejects(() => saveProjectCodeStyle('/project', { staticcheck: false }, io, expected), /Save conflict/)
  assert.deepEqual(await loadProjectCodeStyle('/project', io), {
    organizeImportsOnSave: false,
    localPrefix: 'example.com/app',
  })
})

test('migration creation preserves a style file written by another editor', async () => {
  let content = ''
  const io = {
    async listDirectory(directory) {
      return directory === '/project'
        ? [{ name: '.mgland', is_dir: true }]
        : [{ name: 'code-style.json', is_dir: false }]
    },
    async readFile() { return content },
    async createDirectory() { throw new Error('already exists') },
    async createFile() {
      content = serializeProjectCodeStyle({ staticcheck: false })
      throw new Error('file exists')
    },
    async writeFile() { throw new Error('must not overwrite external file') },
  }
  assert.equal(await createProjectCodeStyleIfMissing('/project', { staticcheck: true }, io), false)
  assert.deepEqual(await loadProjectCodeStyle('/project', io), { staticcheck: false })
})

test('checked settings save preserves newer JSON fields', async () => {
  const before = JSON.stringify({ version: 1, futureOption: 7, go: { unknown: 'keep', staticcheck: false } })
  let onDisk = before
  const io = {
    async writeFile(_path, content, expectedContent) {
      assert.equal(expectedContent, onDisk)
      onDisk = content
    },
  }
  await saveProjectCodeStyle('/project', { localPrefix: 'example.com/app' }, io, before)
  assert.deepEqual(JSON.parse(onDisk), {
    version: 1,
    futureOption: 7,
    go: { unknown: 'keep', localPrefix: 'example.com/app' },
  })
})

test('project code style rejects unsupported versions and ignores unrelated keys', () => {
  assert.throws(() => parseProjectCodeStyle('{"version":2,"go":{}}'), /Unsupported/)
  assert.deepEqual(parseProjectCodeStyle('{"version":1,"go":{"staticcheck":false,"unknown":true}}'), { staticcheck: false })
  assert.throws(() => parseProjectCodeStyle('{"version":1,"go":{"gofumpt":"yes"}}'), /Invalid Go style setting/)
  assert.deepEqual(parseProjectCodeStyle(serializeProjectCodeStyle({ formatOnSave: true })), { formatOnSave: true })
})
