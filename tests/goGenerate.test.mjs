import assert from 'node:assert/strict'
import test from 'node:test'
import { goStructs, generateConstructor, generateGetters, generateSetters, generateStructTags } from '../src/lib/goGenerate.ts'

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

test('generateSetters creates setters for unexported fields only', () => {
  const result = generateSetters(SOURCE, 'Server')
  assert.ok(result)
  assert.match(result.content, /func \(s \*Server\) SetPort\(port int\)/)
  assert.match(result.content, /s\.port = port/)
  assert.ok(!result.content.includes('SetName'), 'exported fields stay untouched')
  assert.equal(result.insertLine, 11)
})

test('generateSetters respects field selection', () => {
  const result = generateSetters(SOURCE, 'Server', ['port'])
  assert.ok(result)
  assert.ok(result.content.includes('SetPort'))
  assert.ok(!result.content.includes('SetLimits'))
})

test('generateStructTags appends json tags with snake_case names', () => {
  const result = generateStructTags(SOURCE, 'Server', 'json')
  assert.ok(result)
  assert.match(result.nextContent, /Name string `json:"name"`/)
  assert.match(result.nextContent, /port int `json:"port"`/)
  assert.match(result.nextContent, /Tags \[\]string `json:"tags"`/)
})

test('generateStructTags extends existing tags and replaces same key', () => {
  const tagged = SOURCE.replace('Name string', 'Name string `xml:"name" json:"fullName"`')
  const result = generateStructTags(tagged, 'Server', 'json')
  assert.ok(result)
  assert.match(result.nextContent, /json:"name"`/)
  assert.ok(!result.nextContent.includes('fullName'))
  assert.match(result.nextContent, /xml:"name"/)
})

test('generateStructTags yaml keeps lowerCamel and db uses snake_case', () => {
  const yaml = generateStructTags(SOURCE, 'Server', 'yaml')
  assert.ok(yaml)
  assert.match(yaml.nextContent, /yaml:"name"/)
  const db = generateStructTags(SOURCE, 'Server', 'db')
  assert.ok(db)
  assert.match(db.nextContent, /db:"name"/)
})
