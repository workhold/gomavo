import assert from 'node:assert/strict'
import test from 'node:test'
import { createGoTest, goPackageDeclarationLine, goSourceDeclarations, goTestDeclarations } from '../src/lib/goTests.ts'

test('finds real test declarations and their bodies while ignoring comments and literals', () => {
  const declarations = goTestDeclarations([
    'package demo',
    '// func TestComment(t *testing.T) {}',
    'var fixture = `func TestString(t *testing.T) {}`',
    'func TestGood(t *testing.T) {',
    '  if true { println("}") }',
    '}',
    'func BenchmarkGood(b *testing.B) {}',
    'func ExampleGood() {}',
    'func FuzzGood(f *testing.F) {}',
    'func Testlower(t *testing.T) {}',
    'func (subject T) TestMethod(t *testing.T) {}',
  ].join('\n'))
  assert.deepEqual(declarations, [
    { name: 'TestGood', startLine: 4, endLine: 6 },
    { name: 'BenchmarkGood', startLine: 7, endLine: 7 },
    { name: 'ExampleGood', startLine: 8, endLine: 8 },
    { name: 'FuzzGood', startLine: 9, endLine: 9 },
  ])
})

test('supports multiline declarations and ignores nested function literals', () => {
  assert.deepEqual(goTestDeclarations([
    'func',
    'TestAcrossLines(t *testing.T) {',
    '  helper := func() {',
    '    // func TestFake(t *testing.T) {}',
    '  }',
    '  helper()',
    '}',
  ].join('\n')), [{ name: 'TestAcrossLines', startLine: 1, endLine: 7 }])
})

test('locates the real package clause after comments', () => {
  assert.equal(goPackageDeclarationLine('// package fake\n/* package hidden */\npackage demo\nfunc TestX(t *testing.T) {}'), 3)
  assert.equal(goPackageDeclarationLine('var text = `package fake`'), null)
})

test('finds source functions and receiver methods without matching comments or nested functions', () => {
  const source = [
    'package demo',
    '// func Fake() {}',
    'var example = `func AlsoFake() {}`',
    'func Add(a, b int) int { return a + b }',
    'func (counter *Counter) Increment() {',
    '  nested := func() {}',
    '  nested()',
    '}',
    'func (cache *cache[K, V]) fetch(key K) V { panic("TODO") }',
    'func main() {}',
    'func Main() {}',
    'func ReturnStruct() struct { Value int } { return struct { Value int }{} }',
    'func Identity[T any](value T) T { return value }',
    'func MakeFunc() func() int { return func() int { return 1 } }',
  ].join('\n')
  assert.deepEqual(goSourceDeclarations(source).map(({ name, receiver, startLine, endLine, testName }) => ({ name, receiver, startLine, endLine, testName })), [
    { name: 'Add', receiver: undefined, startLine: 4, endLine: 4, testName: 'TestAdd' },
    { name: 'Increment', receiver: 'Counter', startLine: 5, endLine: 8, testName: 'TestCounter_Increment' },
    { name: 'fetch', receiver: 'cache', startLine: 9, endLine: 9, testName: 'Test_cache_fetch' },
    { name: 'main', receiver: undefined, startLine: 10, endLine: 10, testName: 'Test_main' },
    { name: 'Main', receiver: undefined, startLine: 11, endLine: 11, testName: 'Test_Main' },
    { name: 'ReturnStruct', receiver: undefined, startLine: 12, endLine: 12, testName: 'TestReturnStruct' },
    { name: 'Identity', receiver: undefined, startLine: 13, endLine: 13, testName: 'TestIdentity' },
    { name: 'MakeFunc', receiver: undefined, startLine: 14, endLine: 14, testName: 'TestMakeFunc' },
  ])
})

test('creates a runnable stub for a selected method and all missing stubs for a file', () => {
  const source = 'package demo\n\nfunc Add() {}\nfunc add() {}\nfunc (x *Thing) Run() {}\n'
  const method = createGoTest(source, null, 'TestThing_Run')
  assert.deepEqual(method?.createdNames, ['TestThing_Run'])
  assert.equal(method?.testFileContent, [
    'package demo', '', 'import "testing"', '',
    'func TestThing_Run(t *testing.T) {', '\tt.Skip("TODO: add test cases")', '}', '',
  ].join('\n'))
  assert.deepEqual(createGoTest(source, method.testFileContent)?.createdNames, ['TestAdd', 'Test_add'])
  assert.equal(createGoTest(source, method.testFileContent, 'TestThing_Run'), null)
  assert.equal(createGoTest(source, null, 'TestMissing'), null)
})

test('reuses aliased and dot testing imports and ignores fake imports in comments and strings', () => {
  const source = 'package demo\nfunc Add() {}\n'
  const aliased = 'package demo\n\nimport testpkg "testing"\n'
  const dot = 'package demo\n\nimport . "testing"\n'
  assert.match(createGoTest(source, aliased).testFileContent, /func TestAdd\(t \*testpkg\.T\)/)
  assert.match(createGoTest(source, dot).testFileContent, /func TestAdd\(t \*T\)/)

  const fake = 'package demo\n\n// import "testing"\nvar note = `import "testing"`\n'
  const generated = createGoTest(source, fake).testFileContent
  assert.match(generated, /^import "testing"$/m)
  assert.match(generated, /func TestAdd\(t \*testing\.T\)/)

  const blank = 'package demo\n\nimport _ "testing"\n'
  assert.match(createGoTest(source, blank).testFileContent, /import testing "testing"/)
})

test('adds testing to grouped and single imports while preserving CRLF', () => {
  const source = 'package demo\nfunc Add() {}\n'
  const grouped = 'package demo\r\n\r\nimport (\r\n\t"fmt"\r\n)\r\n\r\nvar _ = fmt.Sprint\r\n'
  const generated = createGoTest(source, grouped).testFileContent
  assert.match(generated, /\t"fmt"\r\n\t"testing"\r\n\)/)
  assert.equal(/(?<!\r)\n/.test(generated), false)

  const single = 'package demo\n\nimport "fmt"\n\nvar _ = fmt.Sprint\n'
  assert.match(createGoTest(source, single).testFileContent, /import "fmt"\nimport "testing"/)
})

test('does not modify an unrelated or malformed test file', () => {
  const source = 'package demo\nfunc Add() {}\n'
  assert.equal(createGoTest(source, 'package other\n'), null)
  assert.equal(createGoTest(source, '// package demo\n'), null)
  assert.equal(createGoTest('func Add() {}', null), null)
})
