/** The EditorConfig properties GoMavo can apply to its Monaco editor and saves. */
export type EditorConfigSettings = {
  indentStyle?: 'tab' | 'space'
  indentSize?: number | 'tab'
  tabWidth?: number
  endOfLine?: 'lf' | 'cr' | 'crlf'
  trimTrailingWhitespace?: boolean
  insertFinalNewline?: boolean
}

export type MonacoIndentOptions = {
  tabSize: number
  indentSize: number | 'tabSize'
  insertSpaces: boolean
}

type Property = keyof EditorConfigSettings
type Section = { glob: string; pairs: Array<[Property, EditorConfigSettings[Property] | 'unset']> }
type ParsedConfig = { root: boolean; sections: Section[] }

const properties: Record<string, Property> = {
  indent_style: 'indentStyle',
  indent_size: 'indentSize',
  tab_width: 'tabWidth',
  end_of_line: 'endOfLine',
  trim_trailing_whitespace: 'trimTrailingWhitespace',
  insert_final_newline: 'insertFinalNewline',
}

function propertyValue(key: Property, value: string): EditorConfigSettings[Property] | 'unset' | undefined {
  const normalized = value.toLowerCase()
  if (normalized === 'unset') return 'unset'
  switch (key) {
    case 'indentStyle': return normalized === 'tab' || normalized === 'space' ? normalized : undefined
    case 'indentSize': return normalized === 'tab' ? 'tab' : positiveInteger(normalized)
    case 'tabWidth': return positiveInteger(normalized)
    case 'endOfLine': return normalized === 'lf' || normalized === 'cr' || normalized === 'crlf' ? normalized : undefined
    case 'trimTrailingWhitespace':
    case 'insertFinalNewline': return normalized === 'true' ? true : normalized === 'false' ? false : undefined
  }
}

function positiveInteger(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseEditorConfig(content: string): ParsedConfig {
  const result: ParsedConfig = { root: false, sections: [] }
  let section: Section | null = null
  let inPreamble = true
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inPreamble = false
      section = line.endsWith(']') ? { glob: line.slice(1, -1), pairs: [] } : null
      if (section) result.sections.push(section)
      continue
    }
    const equals = line.indexOf('=')
    if (equals < 0) continue
    const key = line.slice(0, equals).trim().toLowerCase()
    const value = line.slice(equals + 1).trim()
    if (!section) {
      if (inPreamble && key === 'root') result.root = value.toLowerCase() === 'true'
      continue
    }
    const property = properties[key]
    if (!property) continue
    const parsed = propertyValue(property, value)
    if (parsed !== undefined) section.pairs.push([property, parsed])
  }
  return result
}

function regexEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** Convert EditorConfig's common filepath globs to a regular expression. */
function globRegex(glob: string): RegExp | null {
  let offset = 0
  const parse = (terminators: string): string => {
    let result = ''
    while (offset < glob.length && !terminators.includes(glob[offset])) {
      const char = glob[offset++]
      if (char === '\\') {
        result += regexEscape(glob[offset++] ?? '\\')
      } else if (char === '*') {
        if (glob[offset] === '*') {
          offset++
          if (glob[offset] === '/') { offset++; result += '(?:.*/)?' }
          else result += '.*'
        } else result += '[^/]*'
      } else if (char === '?') result += '[^/]'
      else if (char === '[') {
        const end = glob.indexOf(']', offset)
        if (end < 0) { result += '\\['; continue }
        const raw = glob.slice(offset, end)
        offset = end + 1
        if (!raw) { result += '\\[\\]'; continue }
        const negative = raw[0] === '!'
        const values = negative ? raw.slice(1) : raw
        const escaped = [...values].map((value) => value === '-' ? '\\-' : value.replace(/[\\\]^]/g, '\\$&')).join('')
        result += negative ? `[^${escaped}]` : `[${escaped}]`
      } else if (char === '{') {
        const start = offset
        const choices: string[] = []
        while (offset < glob.length) {
          choices.push(parse(',}'))
          if (glob[offset] === ',') { offset++; continue }
          break
        }
        if (glob[offset] === '}' && choices.length > 1) {
          offset++
          result += `(?:${choices.join('|')})`
        } else if (glob[offset] === '}' && choices.length === 1) {
          // A single choice is literal in EditorConfig, except a numeric range.
          const raw = glob.slice(start, offset)
          offset++
          const range = /^(-?\d+)\.\.(-?\d+)$/.exec(raw)
          if (range && Number(range[2]) >= Number(range[1]) && Number(range[2]) - Number(range[1]) <= 200) {
            const values = Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
            result += `(?:${values.join('|')})`
          } else result += regexEscape(`{${raw}}`)
        } else result += regexEscape(`{${glob.slice(start, offset)}`)
      } else result += regexEscape(char)
    }
    return result
  }
  try {
    return new RegExp(`^${parse('')}$`)
  } catch {
    return null
  }
}

function hasPathSeparator(glob: string): boolean {
  let escaped = false
  let inClass = false
  for (const char of glob) {
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return true
  }
  return false
}

function matchingSection(glob: string, relativeFile: string): boolean {
  if (glob.endsWith('/')) return false
  const anchored = hasPathSeparator(glob) || glob.startsWith('/')
  const expression = globRegex(glob.replace(/^\//, ''))
  if (!expression) return false
  return expression.test(anchored ? relativeFile : relativeFile.split('/').at(-1) ?? '')
}

function normalizedPath(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  return slashes === '/' ? slashes : slashes.replace(/\/+$/, '')
}

function relativeFile(root: string, path: string): string | null {
  const normalizedRoot = normalizedPath(root)
  const normalizedFile = normalizedPath(path)
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`
  if (!normalizedFile.startsWith(prefix)) return null
  const relative = normalizedFile.slice(prefix.length)
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) return null
  return relative
}

/**
 * Resolve .editorconfig files from the target directory up to the workspace root.
 * The callback returns null for a missing .editorconfig file; other read errors should reject.
 * A root=true config stops the search inside the workspace. Parent folders outside the
 * workspace are intentionally inaccessible through GoMavo's file commands.
 */
export async function resolveEditorConfig(
  workspaceRoot: string,
  filePath: string,
  readConfig: (path: string) => Promise<string | null>,
): Promise<EditorConfigSettings> {
  const relative = relativeFile(workspaceRoot, filePath)
  if (relative === null) return {}
  const root = normalizedPath(workspaceRoot)
  const parts = relative.split('/')
  const configs: Array<{ directory: string; parsed: ParsedConfig }> = []
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const directory = depth ? `${root === '/' ? '' : root}/${parts.slice(0, depth).join('/')}` : root
    const path = `${directory === '/' ? '' : directory}/.editorconfig`
    const content = await readConfig(path)
    if (content === null) continue
    const parsed = parseEditorConfig(content)
    configs.push({ directory, parsed })
    if (parsed.root) break
  }

  const settings: EditorConfigSettings = {}
  for (const { directory, parsed } of configs.reverse()) {
    const inDirectory = relativeFile(directory, filePath)
    if (inDirectory === null) continue
    for (const section of parsed.sections) {
      if (!matchingSection(section.glob, inDirectory)) continue
      for (const [key, value] of section.pairs) {
        if (value === 'unset') delete settings[key]
        else Object.assign(settings, { [key]: value })
      }
    }
  }
  return settings
}

/** Monaco keeps tab width and indentation width separately on its text model. */
export function editorConfigIndentOptions(settings: EditorConfigSettings, defaults: { tabSize: number; insertSpaces: boolean }): MonacoIndentOptions {
  const tabSize = settings.tabWidth ?? (typeof settings.indentSize === 'number' ? settings.indentSize : defaults.tabSize)
  return {
    tabSize,
    indentSize: settings.indentSize === 'tab' ? 'tabSize' : settings.indentSize ?? 'tabSize',
    insertSpaces: settings.indentStyle ? settings.indentStyle === 'space' : defaults.insertSpaces,
  }
}

/** Apply the save-time rules without changing lines when no matching rule exists. */
export function applyEditorConfigToContent(content: string, settings: EditorConfigSettings): string {
  let result = content
  const originalEnding = /\r\n|\r|\n/.exec(content)?.[0] ?? '\n'
  if (settings.trimTrailingWhitespace) result = result.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, '')
  if (settings.endOfLine) {
    const ending = settings.endOfLine === 'crlf' ? '\r\n' : settings.endOfLine === 'cr' ? '\r' : '\n'
    result = result.replace(/\r\n|\r|\n/g, ending)
  }
  const ending = settings.endOfLine === 'crlf' ? '\r\n' : settings.endOfLine === 'cr' ? '\r' : settings.endOfLine === 'lf' ? '\n' : originalEnding
  if (settings.insertFinalNewline === true && result && !/(?:\r\n|\r|\n)$/.test(result)) result += ending
  if (settings.insertFinalNewline === false) result = result.replace(/(?:\r\n|\r|\n)+$/, '')
  return result
}

/**
 * Parses GoLand's `.idea/codeStyles/Project.xml` for the basic indent
 * properties GoMavo applies. Accepts both the global `<option>` entries and
 * the per-language `<codeStyleSettings language="Go">` block (preferred).
 */
export function parseGoLandCodeStyle(xml: string): Partial<EditorConfigSettings> {
  if (!xml.includes('<code_scheme')) return {}
  const pick = (name: string): string | null => {
    // Go-specific block first, then any codeStyleSettings block, then global.
    const patterns = [
      new RegExp(`<codeStyleSettings language="Go">[^]*?<option name="${name}" value="([^"]*)"`, 'i'),
      new RegExp(`<codeStyleSettings[^]*?<option name="${name}" value="([^"]*)"`, 'i'),
      new RegExp(`<option name="${name}" value="([^"]*)"`, 'i'),
    ]
    for (const pattern of patterns) {
      const found = pattern.exec(xml)
      if (found) return found[1]
    }
    return null
  }
  const settings: Partial<EditorConfigSettings> = {}
  const useTab = pick('USE_TAB_CHARACTER')
  if (useTab === 'true') settings.indentStyle = 'tab'
  else if (useTab === 'false') settings.indentStyle = 'space'
  const indent = pick('INDENT_SIZE')
  if (indent && /^\d+$/.test(indent) && Number(indent) > 0) settings.indentSize = Number(indent)
  const tab = pick('TAB_SIZE')
  if (tab && /^\d+$/.test(tab) && Number(tab) > 0) settings.tabWidth = Number(tab)
  const separator = pick('LINE_SEPARATOR')
  if (separator) {
    // LINE_SEPARATOR arrives as an XML numeric entity (&#10;) or a literal.
    // Trim the entity text BEFORE decoding — the decoded value is whitespace.
    const trimmed = separator.trim()
    const decoded = /^&#(\d+);$/.test(trimmed)
      ? String.fromCodePoint(Number(trimmed.replace(/\D/g, '')))
      : trimmed
    if (decoded === '\n') settings.endOfLine = 'lf'
    else if (decoded === '\r\n') settings.endOfLine = 'crlf'
    else if (decoded === '\r') settings.endOfLine = 'cr'
  }
  return settings
}
