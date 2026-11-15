import assert from 'node:assert/strict'
import test from 'node:test'
import { fileLanguage } from '../src/lib/api.ts'

test('recognizes Go metadata and ignore patterns as highlighted project files', () => {
  assert.equal(fileLanguage('/repo/go.mod'), 'gomod')
  assert.equal(fileLanguage('/repo/go.work'), 'gomod')
  assert.equal(fileLanguage('/repo/go.sum'), 'gosum')
  assert.equal(fileLanguage('/repo/.gitignore'), 'gitignore')
  assert.equal(fileLanguage('/repo/.dockerignore'), 'gitignore')
  assert.equal(fileLanguage('/repo/.editorconfig'), 'ini')
  assert.equal(fileLanguage('/repo/Makefile'), 'makefile')
  assert.equal(fileLanguage('/repo/Dockerfile'), 'dockerfile')
  assert.equal(fileLanguage('/repo/.env.local'), 'dotenv')
})
