/** Top-level Go test declarations and the lines covered by their bodies. */
export interface GoTestDeclaration {
  name: string
  startLine: number
  endLine: number
}

/** A function or method in a Go source file that can receive a test stub. */
export interface GoSourceDeclaration {
  name: string
  receiver?: string
  startLine: number
  endLine: number
  testName: string
}

export interface CreatedGoTest {
  testFileContent: string
  createdNames: string[]
}

function testName(name: string): boolean {
  for (const prefix of ['Test', 'Benchmark', 'Fuzz']) {
    if (name.startsWith(prefix)) {
      return !/^\p{Ll}/u.test(name.slice(prefix.length))
    }
  }
  return name.startsWith('Example')
}

/** Mask comments and literals while retaining offsets and line breaks. */
function codeOnly(source: string): string {
  const chars = source.split('')
  let state: 'code' | 'line' | 'block' | 'quoted' | 'rune' | 'raw' = 'code'
  for (let i = 0; i < chars.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { chars[i] = chars[i + 1] = ' '; i += 1; state = 'line' }
      else if (ch === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i += 1; state = 'block' }
      else if (ch === '"' || ch === "'" || ch === '`') { chars[i] = ' '; state = ch === '"' ? 'quoted' : ch === "'" ? 'rune' : 'raw' }
      continue
    }
    if (ch !== '\n') chars[i] = ' '
    if (state === 'line' && ch === '\n') state = 'code'
    else if (state === 'block' && ch === '*' && next === '/') { chars[i + 1] = ' '; i += 1; state = 'code' }
    else if ((state === 'quoted' || state === 'rune') && ch === '\\') {
      if (next !== undefined) { if (next !== '\n') chars[i + 1] = ' '; i += 1 }
    } else if (state === 'quoted' && ch === '"') state = 'code'
    else if (state === 'rune' && ch === "'") state = 'code'
    else if (state === 'raw' && ch === '`') state = 'code'
  }
  return chars.join('')
}

/** Remove comments, retaining offsets and string literals for import parsing. */
function withoutComments(source: string): string {
  const chars = source.split('')
  let state: 'code' | 'line' | 'block' | 'quoted' | 'rune' | 'raw' = 'code'
  for (let i = 0; i < chars.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { chars[i] = chars[i + 1] = ' '; i += 1; state = 'line' }
      else if (ch === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i += 1; state = 'block' }
      else if (ch === '"' || ch === "'" || ch === '`') state = ch === '"' ? 'quoted' : ch === "'" ? 'rune' : 'raw'
      continue
    }
    if (state === 'line' || state === 'block') {
      if (ch !== '\n') chars[i] = ' '
      if (state === 'line' && ch === '\n') state = 'code'
      else if (state === 'block' && ch === '*' && next === '/') { chars[i + 1] = ' '; i += 1; state = 'code' }
    } else if ((state === 'quoted' || state === 'rune') && ch === '\\') {
      if (next !== undefined) i += 1
    } else if (state === 'quoted' && ch === '"') state = 'code'
    else if (state === 'rune' && ch === "'") state = 'code'
    else if (state === 'raw' && ch === '`') state = 'code'
  }
  return chars.join('')
}

const identifier = /[\p{L}_][\p{L}\p{N}_]*/u
const identifierCharacter = /[\p{L}\p{N}_]/u

function skipWhitespace(code: string, offset: number): number {
  while (offset < code.length && /\s/.test(code[offset])) offset += 1
  return offset
}

function skipHorizontalWhitespace(code: string, offset: number): number {
  while (offset < code.length && /[ \t]/.test(code[offset])) offset += 1
  return offset
}

function closingDelimiter(code: string, start: number, open: string, close: string): number | null {
  if (code[start] !== open) return null
  let depth = 0
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === open) depth += 1
    else if (code[i] === close && --depth === 0) return i
  }
  return null
}

function packageClause(source: string): { name: string; end: number } | null {
  const code = codeOnly(source)
  const match = /^[ \t]*package[ \t]+([\p{L}_][\p{L}\p{N}_]*)(?=\s|$)/mu.exec(code)
  if (!match) return null
  return { name: match[1], end: match.index + match[0].length }
}

function sourceTestName(name: string, receiver?: string): string {
  if (receiver) return `Test${/^\p{Lu}/u.test(receiver) ? receiver : `_${receiver}`}_${name}`
  // TestMain is a Go testing hook with a different signature, and Testfoo is
  // not discovered by `go test`. The underscore keeps both names runnable.
  return /^\p{Lu}/u.test(name) && name !== 'Main' ? `Test${name}` : `Test_${name}`
}

function receiverType(code: string): string | null {
  const withoutTypeArguments = code.split('[')[0]
  return [...withoutTypeArguments.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)].at(-1)?.[0] ?? null
}

function functionBodyStart(code: string, afterParameters: number): number | null {
  let cursor = skipWhitespace(code, afterParameters)
  if (code[cursor] === '(') {
    const resultsEnd = closingDelimiter(code, cursor, '(', ')')
    if (resultsEnd === null) return null
    cursor = resultsEnd + 1
  }
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === '[') {
      const end = closingDelimiter(code, cursor, '[', ']')
      if (end === null) return null
      cursor = end
    } else if (code[cursor] === '(') {
      const end = closingDelimiter(code, cursor, '(', ')')
      if (end === null) return null
      cursor = end
    } else if (code[cursor] === '{') {
      // A result type may itself be `struct { ... }` or `interface { ... }`.
      const prior = /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(code.slice(afterParameters, cursor))?.[1]
      if (prior === 'struct' || prior === 'interface') {
        const end = closingDelimiter(code, cursor, '{', '}')
        if (end === null) return null
        cursor = end
      } else return cursor
    } else if (code[cursor] === ';') return null
    else if (code.startsWith('func', cursor) && !identifierCharacter.test(code[cursor - 1] ?? '') && !identifierCharacter.test(code[cursor + 4] ?? '') && /^\s*\n\s*$/.test(code.slice(afterParameters, cursor))) return null
  }
  return null
}

/** Find complete top-level source declarations, including receiver methods. */
export function goSourceDeclarations(source: string): GoSourceDeclaration[] {
  const code = codeOnly(source)
  const lineStarts = [0]
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1)
  const lineAt = (offset: number): number => {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return low + 1
  }
  const declarations: GoSourceDeclaration[] = []
  let depth = 0
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') { depth += 1; continue }
    if (code[i] === '}') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0 || !code.startsWith('func', i) || identifierCharacter.test(code[i - 1] ?? '') || identifierCharacter.test(code[i + 4] ?? '')) continue

    let cursor = skipWhitespace(code, i + 4)
    let receiver: string | undefined
    if (code[cursor] === '(') {
      const receiverEnd = closingDelimiter(code, cursor, '(', ')')
      if (receiverEnd === null) continue
      receiver = receiverType(code.slice(cursor + 1, receiverEnd)) ?? undefined
      cursor = skipWhitespace(code, receiverEnd + 1)
    }
    const nameMatch = identifier.exec(code.slice(cursor))
    if (!nameMatch || nameMatch.index !== 0) continue
    const name = nameMatch[0]
    cursor = skipWhitespace(code, cursor + name.length)
    if (code[cursor] === '[') {
      const typeParametersEnd = closingDelimiter(code, cursor, '[', ']')
      if (typeParametersEnd === null) continue
      cursor = skipWhitespace(code, typeParametersEnd + 1)
    }
    if (code[cursor] !== '(') continue
    const parametersEnd = closingDelimiter(code, cursor, '(', ')')
    if (parametersEnd === null) continue
    const bodyStart = functionBodyStart(code, parametersEnd + 1)
    if (bodyStart === null) continue
    const bodyEnd = closingDelimiter(code, bodyStart, '{', '}')
    if (bodyEnd === null) continue
    declarations.push({ name, ...(receiver ? { receiver } : {}), startLine: lineAt(i), endLine: lineAt(bodyEnd), testName: sourceTestName(name, receiver) })
    i = bodyEnd
  }
  return declarations
}

type ImportDeclaration = { start: number; end: number; bodyStart: number; bodyEnd: number; grouped: boolean }

function importDeclarations(source: string): ImportDeclaration[] {
  const code = codeOnly(source)
  const imports: ImportDeclaration[] = []
  let depth = 0
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') { depth += 1; continue }
    if (code[i] === '}') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0 || !code.startsWith('import', i) || identifierCharacter.test(code[i - 1] ?? '') || identifierCharacter.test(code[i + 6] ?? '')) continue
    const bodyStart = skipHorizontalWhitespace(code, i + 6)
    if (code[bodyStart] === '(') {
      const close = closingDelimiter(code, bodyStart, '(', ')')
      if (close === null) continue
      imports.push({ start: i, end: close + 1, bodyStart: bodyStart + 1, bodyEnd: close, grouped: true })
      i = close
    } else {
      const lineEnd = code.indexOf('\n', bodyStart)
      const end = lineEnd < 0 ? code.length : lineEnd
      imports.push({ start: i, end, bodyStart, bodyEnd: end, grouped: false })
      i = end
    }
  }
  return imports
}

function testingImport(source: string, declarations: ImportDeclaration[]): { qualifier: string; blankAliasOffset?: number } | null {
  const clean = withoutComments(source)
  for (const declaration of declarations) {
    const body = clean.slice(declaration.bodyStart, declaration.bodyEnd)
    for (const part of body.matchAll(/[^\r\n;]+/g)) {
      const spec = /^[ \t]*(?:(\.|_|[\p{L}_][\p{L}\p{N}_]*)[ \t]+)?(["`])testing\2[ \t]*$/u.exec(part[0])
      if (!spec) continue
      if (spec[1] === '_') return { qualifier: 'testing.', blankAliasOffset: declaration.bodyStart + (part.index ?? 0) + part[0].indexOf('_') }
      return { qualifier: spec[1] === '.' ? '' : `${spec[1] ?? 'testing'}.` }
    }
  }
  return null
}

function addTestingImport(source: string, packageEnd: number, declarations: ImportDeclaration[], ending: string): string {
  const grouped = declarations.find((declaration) => declaration.grouped)
  if (grouped) {
    const closeLineStart = source.lastIndexOf('\n', grouped.bodyEnd - 1) + 1
    const indent = /(?:^|\n)([ \t]+)(?:(?:\.|_|[\p{L}_][\p{L}\p{N}_]*)[ \t]+)?["`]/u.exec(source.slice(grouped.bodyStart, grouped.bodyEnd))?.[1] ?? '\t'
    if (closeLineStart > grouped.bodyStart && /^[ \t]*$/.test(source.slice(closeLineStart, grouped.bodyEnd))) {
      return `${source.slice(0, closeLineStart)}${indent}"testing"${ending}${source.slice(closeLineStart)}`
    }
    const existing = source.slice(grouped.bodyStart, grouped.bodyEnd).trim()
    const body = existing ? `${ending}${indent}${existing}${ending}${indent}"testing"${ending}` : `${ending}${indent}"testing"${ending}`
    return `${source.slice(0, grouped.bodyStart)}${body}${source.slice(grouped.bodyEnd)}`
  }
  if (declarations.length) {
    const end = declarations[0].end
    return `${source.slice(0, end)}${ending}import "testing"${source.slice(end)}`
  }
  const lineEnd = source.indexOf('\n', packageEnd)
  const end = lineEnd < 0 ? source.length : lineEnd
  const rest = source.slice(end).replace(/^(?:\r?\n)*/, '')
  return `${source.slice(0, end)}${ending}${ending}import "testing"${rest ? `${ending}${ending}${rest}` : ending}`
}

/** Create runnable test stubs for one declaration or every declaration in a file. */
export function createGoTest(source: string, existingTest: string | null, targetName?: string): CreatedGoTest | null {
  const sourcePackage = packageClause(source)?.name
  if (!sourcePackage) return null
  const candidates = goSourceDeclarations(source).filter((declaration) => !targetName || declaration.testName === targetName)
  if (!candidates.length) return null

  const existing = existingTest ?? ''
  const existingPackage = existing ? packageClause(existing) : null
  if (existing && (!existingPackage || (existingPackage.name !== sourcePackage && existingPackage.name !== `${sourcePackage}_test`))) return null
  const existingNames = new Set(goTestDeclarations(existing).map((declaration) => declaration.name))
  const code = codeOnly(existing)
  for (const match of code.matchAll(/\bfunc\s+(Test[\p{L}\p{N}_]*)\s*\(/gu)) existingNames.add(match[1])
  const selected = candidates.filter((declaration) => {
    if (existingNames.has(declaration.testName)) return false
    existingNames.add(declaration.testName)
    return true
  })
  if (!selected.length) return null

  const ending = /\r\n|\n/.exec(existing)?.[0] ?? /\r\n|\n/.exec(source)?.[0] ?? '\n'
  const imports = importDeclarations(existing)
  const imported = testingImport(existing, imports)
  const qualifier = imported?.qualifier ?? 'testing.'
  const stubs = selected.map(({ testName }) => `func ${testName}(t *${qualifier}T) {${ending}\tt.Skip("TODO: add test cases")${ending}}`).join(`${ending}${ending}`)

  let testFileContent: string
  if (!existing) testFileContent = `package ${sourcePackage}${ending}${ending}import "testing"${ending}${ending}${stubs}${ending}`
  else {
    let updated = existing
    if (imported?.blankAliasOffset !== undefined) {
      const offset = imported.blankAliasOffset
      updated = `${updated.slice(0, offset)}testing${updated.slice(offset + 1)}`
    } else if (!imported) updated = addTestingImport(updated, existingPackage!.end, imports, ending)
    testFileContent = `${updated.replace(/\s*$/, '')}${ending}${ending}${stubs}${ending}`
  }
  return { testFileContent, createdNames: selected.map((declaration) => declaration.testName) }
}

export function goPackageDeclarationLine(source: string): number | null {
  const code = codeOnly(source)
  const match = /^[ \t]*package[ \t]+[\p{L}_][\p{L}\p{N}_]*(?=\s|$)/mu.exec(code)
  if (!match) return null
  return code.slice(0, match.index).split('\n').length
}

export function goTestDeclarations(source: string): GoTestDeclaration[] {
  const code = codeOnly(source)
  const lineStarts = [0]
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lineStarts.push(i + 1)
  const lineAt = (offset: number): number => {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return low + 1
  }

  const declarations: GoTestDeclaration[] = []
  let depth = 0
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') { depth += 1; continue }
    if (code[i] === '}') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0 || !code.startsWith('func', i) || /[\p{L}\p{N}_]/u.test(code[i - 1] ?? '') || /[\p{L}\p{N}_]/u.test(code[i + 4] ?? '')) continue
    const match = /^func\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(code.slice(i))
    if (!match || !testName(match[1])) continue

    let cursor = i + match[0].length - 1
    let parens = 0
    for (; cursor < code.length; cursor += 1) {
      if (code[cursor] === '(') parens += 1
      else if (code[cursor] === ')' && --parens === 0) break
    }
    if (parens !== 0) continue
    cursor += 1
    while (/\s/.test(code[cursor] ?? '') && cursor < code.length) cursor += 1
    if (code[cursor] !== '{') continue
    let braces = 0
    for (; cursor < code.length; cursor += 1) {
      if (code[cursor] === '{') braces += 1
      else if (code[cursor] === '}' && --braces === 0) break
    }
    if (braces !== 0) continue
    declarations.push({ name: match[1], startLine: lineAt(i), endLine: lineAt(cursor) })
    i = cursor
  }
  return declarations
}
