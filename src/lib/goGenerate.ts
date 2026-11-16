// Go code generation for the editor Generate menu (constructor, getters).
// The parsing stays deliberately textual — matching goTests.ts — so it works
// even while gopls is unavailable, and gopls formats the result on save.

export interface GoStructField {
  name: string
  type: string
  /** One-based line of the field inside the file. */
  line: number
}

export interface GoStruct {
  name: string
  startLine: number
  endLine: number
  fields: GoStructField[]
}

const STRUCT_PATTERN = /type\s+([\p{L}_][\p{L}\p{N}_]*)\s+struct\s*\{/gu
const RESERVED = new Set(['type', 'func', 'var', 'const', 'package', 'range', 'map', 'chan', 'interface', 'struct', 'select'])

function codeOnly(source: string): string {
  // Strip comments and strings the same way goTests.ts does, so a brace in a
  // string literal cannot confuse the body scan.
  let result = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      result += ' '
      index = end < 0 ? source.length : end + 2
    } else if (char === '"' || char === '`' || char === "'") {
      const quote = char
      let cursor = index + 1
      while (cursor < source.length && source[cursor] !== quote) {
        cursor += source[cursor] === '\\' ? 2 : 1
      }
      result += quote === '`' ? ' ' : `${quote} ${quote}`
      index = cursor + 1
    } else {
      result += char
      index += 1
    }
  }
  return result
}

/** Parse top-level struct declarations with their fields. */
export function goStructs(source: string): GoStruct[] {
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

  const structs: GoStruct[] = []
  for (const match of code.matchAll(STRUCT_PATTERN)) {
    const name = match[1]
    const openBrace = match.index + match[0].length - 1
    let depth = 1
    let cursor = openBrace + 1
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === '{') depth += 1
      else if (code[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth !== 0) continue
    const body = code.slice(openBrace + 1, cursor - 1)
    const bodyStartLine = lineAt(openBrace + 1)

    const fields: GoStructField[] = []
    let nested = 0
    body.split('\n').forEach((text, index) => {
      for (const char of text) {
        if (char === '{') nested += 1
        else if (char === '}') nested = Math.max(0, nested - 1)
      }
      if (nested !== 0) return
      const trimmed = text.trim()
      if (!trimmed) return
      const declaration = /^([\p{L}_][\p{L}\p{N}_]*(?:\s*,\s*[\p{L}_][\p{L}\p{N}_]*)*)\s+(.+)$/u.exec(trimmed)
      if (!declaration) return // Embedded fields and comments are skipped.
      const type = declaration[2].replace(/`[^`]*`/u, '').trim()
      if (!type) return
      for (const field of declaration[1].split(',')) {
        const fieldName = field.trim()
        if (fieldName) fields.push({ name: fieldName, type, line: bodyStartLine + index })
      }
    })

    structs.push({
      name,
      startLine: lineAt(match.index),
      endLine: lineAt(cursor - 1),
      fields,
    })
  }
  return structs
}

/** Constructor parameters use the field name lower-cased, avoiding keywords. */
function parameterName(name: string): string {
  const lowered = /^[A-Z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name
  return RESERVED.has(lowered) ? `${lowered}Value` : lowered
}

/** Build a `func NewX(...) *X` constructor inserted after the struct. */
export function generateConstructor(source: string, structName: string): { content: string; insertLine: number } | null {
  const target = goStructs(source).find((item) => item.name === structName)
  if (!target) return null
  const fields = target.fields.filter((field) => !field.name.startsWith('_') || /^[A-Z]/.test(field.name))
  if (!fields.length) return null
  const used = new Set<string>()
  const parameterFor = (name: string): string => {
    let candidate = parameterName(name)
    while (used.has(candidate)) candidate = `${candidate}Value`
    used.add(candidate)
    return candidate
  }
  const pairs = fields.map((field) => ({ field, parameter: parameterFor(field.name) }))
  const parameters = pairs
    .map(({ field, parameter }) => `${parameter} ${field.type}`)
    .join(', ')
  const assignments = pairs
    .map(({ field, parameter }) => `\t${field.name}: ${parameter},`)
    .join('\n')
  return {
    content: `\n// New${structName} creates a ${structName} with the given fields.\nfunc New${structName}(${parameters}) *${structName} {\n\treturn &${structName}{\n${assignments}\n\t}\n}\n`,
    insertLine: target.endLine + 1,
  }
}

/** Build getter methods for the unexported fields of a struct. */
export function generateGetters(source: string, structName: string, fieldNames?: string[]): { content: string; insertLine: number } | null {
  const target = goStructs(source).find((item) => item.name === structName)
  if (!target) return null
  const selected = target.fields.filter(
    (field) => /^[a-z_]/.test(field.name) && (!fieldNames || fieldNames.includes(field.name)),
  )
  if (!selected.length) return null
  const methods = selected
    .map((field) => {
      const accessor = field.name[0].toUpperCase() + field.name.slice(1)
      return `\n// ${accessor} returns the ${field.name} field.\nfunc (s *${structName}) ${accessor}() ${field.type} {\n\treturn s.${field.name}\n}\n`
    })
    .join('')
  return { content: methods, insertLine: target.endLine + 1 }
}

/** Build setter methods for the unexported fields of a struct. */
export function generateSetters(source: string, structName: string, fieldNames?: string[]): { content: string; insertLine: number } | null {
  const target = goStructs(source).find((item) => item.name === structName)
  if (!target) return null
  const selected = target.fields.filter(
    (field) => /^[a-z_]/.test(field.name) && (!fieldNames || fieldNames.includes(field.name)),
  )
  if (!selected.length) return null
  const methods = selected
    .map((field) => {
      const accessor = field.name[0].toUpperCase() + field.name.slice(1)
      const parameter = parameterName(field.name)
      return `\n// ${accessor} sets the ${field.name} field.\nfunc (s *${structName}) Set${accessor}(${parameter} ${field.type}) {\n\ts.${field.name} = ${parameter}\n}\n`
    })
    .join('')
  return { content: methods, insertLine: target.endLine + 1 }
}

export type StructTagScheme = 'json' | 'yaml' | 'db'

const TAG_KEY: Record<StructTagScheme, string> = { json: 'json', yaml: 'yaml', db: 'db' }

/** Rewrite every field of the struct to carry a `<scheme>:"name"` tag. */
export function generateStructTags(source: string, structName: string, scheme: StructTagScheme): { nextContent: string } | null {
  const target = goStructs(source).find((item) => item.name === structName)
  if (!target || !target.fields.length) return null
  const key = TAG_KEY[scheme]
  const lines = source.split('\n')
  const fieldLines = new Map(target.fields.map((field) => [field.line, field.name]))
  const tagName = (name: string): string => scheme === 'db' || scheme === 'json' ? camelToLowerSnake(name) : lowerCamel(name)
  // Field lines sit inside the struct body; append or extend their backtick tags.
  for (const [line, name] of fieldLines) {
    const lineIndex = line - 1
    if (lineIndex < 0 || lineIndex >= lines.length) continue
    const text = lines[lineIndex]
    const tag = `${key}:"${tagName(name)}"`
    const existing = /`([^`]*)`/.exec(text)
    if (existing) {
      const inside = existing[1]
      // Replace a same-key tag, otherwise append the new key.
      const next = new RegExp(`${key}:"[^"]*"`).test(inside)
        ? inside.replace(new RegExp(`(?:^|\\s)?${key}:"[^"]*"`), tag).trim()
        : `${inside} ${tag}`.trim()
      lines[lineIndex] = text.replace(/`[^`]*`/, `\`${next}\``)
    } else {
      const withoutComment = text.replace(/\/\/.*$/, '')
      lines[lineIndex] = `${withoutComment.replace(/\s+$/, '')} \`${tag}\``
    }
  }
  return { nextContent: lines.join('\n') }
}

/** json/db tag names are lower snake case; yaml keeps lower camel. */
function camelToLowerSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .toLowerCase()
}

function lowerCamel(name: string): string {
  return /^[A-Z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name
}
