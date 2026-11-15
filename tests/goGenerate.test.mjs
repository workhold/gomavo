import assert from 'node:assert/strict'
import test from 'node:test'
import { goStructs, generateConstructor, generateGetters } from '../src/lib/goGenerate.ts'

const SOURCE = `package model

// Server holds runtime configuration.
type Server struct {
	Name string
	port int
	Tags []string
	// nested anonymous struct stays on one line
	Limits struct{ Max int }
}

func (s *Server) Start() {}
`

test('goStructs parses fields, skipping comments and nested braces', () => {
  const structs = goStructs(SOURCE)
  assert.equal(structs.length, 1)
  const server = structs[0]
  assert.equal(server.name, 'Server')
  const names = server.fields.map((field) => field.name)
  assert.deepEqual(names, ['Name', 'port', 'Tags', 'Limits'])
  assert.equal(server.fields[1].type, 'int')
  assert.ok(server.fields[3].type.startsWith('struct'))
  assert.equal(server.startLine, 4)
})

test('generateConstructor emits parameters and assignments', () => {
  const generated = generateConstructor(SOURCE, 'Server')
  assert.ok(generated)
  assert.ok(generated.content.includes('func NewServer(name string, port int, tags []string, limits struct{ Max int }) *Server {'))
  assert.ok(generated.content.includes('Name: name,'))
  assert.ok(generated.content.includes('port: port,'))
  assert.equal(generated.insertLine, 11)
})

test('generateGetters targets only unexported fields', () => {
  const generated = generateGetters(SOURCE, 'Server')
  assert.ok(generated)
  assert.ok(generated.content.includes('func (s *Server) Port() int {'))
  assert.ok(!generated.content.includes('func (s *Server) Name()'))
  const limited = generateGetters(SOURCE, 'Server', ['name'])
  assert.equal(limited, null)
})

test('strings containing braces do not confuse the struct scan', () => {
  const tricky = 'type Config struct {\n\tTemplate string\n}\n'
  const structs = goStructs(`package p\n\n${tricky}`)
  assert.equal(structs[0].fields[0].name, 'Template')
})
