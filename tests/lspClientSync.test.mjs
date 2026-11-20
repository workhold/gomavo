import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { fileUri } from '../src/lib/lsp/uri.ts'

test('consecutive Monaco edits sync to gopls without reading or rebuilding the whole model', async () => {
  const testsDir = dirname(fileURLToPath(import.meta.url))
  const temporary = await mkdtemp(join(testsDir, '.lsp-sync-'))
  try {
    const outfile = join(temporary, 'client.mjs')
    await build({ entryPoints: [join(testsDir, '../src/lib/lsp/client.ts')], bundle: true, platform: 'node', format: 'esm', outfile, packages: 'external' })
    const { GoplsClient } = await import(pathToFileURL(outfile).href)
    const path = '/project/large.go'
    const uri = fileUri(path)
    const original = 'package main\n' + 'var item = 1\n'.repeat(30_000)
    let liveVersion = 1
    let modelReads = 0
    const model = {
      getVersionId: () => liveVersion,
      getValue: () => { modelReads += 1; throw new Error('unexpected full model read') },
    }
    const client = new GoplsClient('/project', { editor: { getModel: () => model }, Uri: { parse: (value) => value } })
    client.start = async () => {}
    client.syncKind = 2
    const sent = []
    client.notify = async (_method, params) => { sent.push(params) }
    client.documents.set(uri, { text: original, version: 1, modelVersion: 1, model })

    let text = original
    for (let version = 2; version <= 4; version += 1) {
      const edit = {
        rangeOffset: text.length,
        rangeLength: 0,
        text: 'x',
        range: { startLineNumber: 30_002, startColumn: version - 1, endLineNumber: 30_002, endColumn: version - 1 },
      }
      text += 'x'
      liveVersion = version
      await client.changeDocumentIncremental(path, [edit], text, version)
    }

    assert.equal(modelReads, 0)
    assert.equal(client.documents.get(uri).text, text)
    assert.deepEqual(sent.map((entry) => entry.contentChanges[0].text), ['x', 'x', 'x'])
    assert.ok(sent.every((entry) => entry.contentChanges[0].range))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
