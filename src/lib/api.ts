import { invoke, isTauri } from '@tauri-apps/api/core'

export type FileEntry = {
  name: string
  path: string
  is_dir: boolean
  ignored: boolean
}

export type BinaryPreview = {
  size: number
  bytes: number[]
  truncated: boolean
}

export type GitFile = {
  path: string
  status: string
  staged: boolean
  unstaged: boolean
}

export type GitLogEntry = {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
}

export type GitFileHistoryEntry = GitLogEntry & { path: string }

export type GitCommitResult = { hash: string; status: GitStatus }
export type GitBranch = { name: string; current: boolean }

export type GitStatus = {
  branch: string
  files: GitFile[]
}

export type ToolVersions = {
  go: string | null
  gopls: string | null
  git: string | null
  dlv: string | null
  govulncheck: string | null
}

export type GoRequire = { module: string; version: string }

export type GoModInfo = { requires: GoRequire[] }

export type TaskOutput = {
  id: string
  stream: string
  line: string
}

export type CoverageBlock = {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  statements: number
  count: number
}

export type CoverageFile = {
  path: string
  blocks: CoverageBlock[]
}

export type CoverageProfile = {
  mode: string
  files: CoverageFile[]
}

export type TaskExit = {
  id: string
  code: number | null
  coverage?: CoverageProfile
  root?: string
}

export type SearchOptions = {
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  includeIgnored: boolean
}

export type SearchMatch = {
  line: number
  column: number
  length: number
  lineText: string
}

export type SearchFileResult = {
  path: string
  matches: SearchMatch[]
}

export type ReplaceFileResult = {
  path: string
  replacements: number
  before: string
  after: string
}

export type GitStashEntry = {
  index: number
  message: string
  date: string
}

export type GitMergeResult = {
  status: GitStatus
  conflicted: boolean
  conflicts: string[]
}

export type GitBlameLine = { line: number; hash: string }
export type GitBlameCommit = { shortHash: string; author: string; date: string; summary: string }
export type GitBlameResult = {
  path: string
  lines: GitBlameLine[]
  commits: Record<string, GitBlameCommit>
}

export type GitGraphCommit = {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
  parents: string[]
  refs: string[]
  isHead: boolean
}

export const desktopAvailable = isTauri()

export function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktopAvailable) {
    return Promise.reject(new Error('请在 Tauri 桌面应用中使用本机功能。运行 npm run tauri dev 启动桌面版。'))
  }
  return invoke<T>(name, args)
}

export function displayName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

export function joinPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, '')}/${name}`
}

export function relativePath(root: string, path: string): string {
  return path.replace(/\\/g, '/').replace(root.replace(/\\/g, '/').replace(/\/+$/, '') + '/', '')
}

export function fileLanguage(path: string): string {
  const name = displayName(path).toLowerCase()
  if (name.endsWith('.go')) return 'go'
  if (name === 'go.mod' || name === 'go.work') return 'gomod'
  if (name === 'go.sum' || name === 'go.work.sum') return 'gosum'
  if (['.gitignore', '.dockerignore', '.ignore', '.rgignore'].includes(name)) return 'gitignore'
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'dotenv'
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile'
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile'
  if (['.editorconfig', '.gitconfig', '.gitmodules', '.gitattributes'].includes(name) || name.endsWith('.ini') || name.endsWith('.properties') || name.endsWith('.toml')) return 'ini'
  if (['.bashrc', '.zshrc', '.profile', '.bash_profile'].includes(name) || /\.(?:sh|bash|zsh)$/.test(name)) return 'shell'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml'
  if (name.endsWith('.ts')) return 'typescript'
  if (name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js')) return 'javascript'
  if (name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.xml') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.rs')) return 'rust'
  if (name.endsWith('.sql')) return 'sql'
  if (/\.(?:cpp|cc|cxx|hpp|hh|hxx)$/.test(name)) return 'cpp'
  if (name.endsWith('.c') || name.endsWith('.h')) return 'c'
  if (name.endsWith('.java')) return 'java'
  if (name.endsWith('.kt') || name.endsWith('.kts')) return 'kotlin'
  if (name.endsWith('.proto')) return 'proto'
  if (name.endsWith('.graphql') || name.endsWith('.gql')) return 'graphql'
  if (/\.(?:tf|tfvars|hcl)$/.test(name)) return 'hcl'
  return 'plaintext'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
