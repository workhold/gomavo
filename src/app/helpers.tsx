import {
  Braces, File, FileJson2, FileText, Folder,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { GoFileIcon, GoTestFileIcon } from '../components/GoFileIcon'
import { command, displayName, type BinaryPreview, type FileEntry } from '../lib/api'
import type { Locale } from '../lib/i18n'
import type { OpenFile } from './types'

export function entryIcon(entry: FileEntry): LucideIcon | typeof GoFileIcon | typeof GoTestFileIcon {
  if (entry.is_dir) return Folder
  const name = entry.name.toLowerCase()
  if (name.endsWith('_test.go')) return GoTestFileIcon
  if (name.endsWith('.go')) return GoFileIcon
  if (name.endsWith('.json')) return FileJson2
  if (name === 'go.mod' || name === 'go.sum' || name === 'go.work') return Braces
  if (name.endsWith('.md') || name.endsWith('.txt')) return FileText
  return File
}

export function statusLabel(status: string): string {
  if (status.includes('?')) return 'U'
  if (status.includes('D')) return 'D'
  if (status.includes('A')) return 'A'
  if (status.includes('R')) return 'R'
  return 'M'
}

export function gitAppearance(status: string): string {
  if (status.includes('?')) return 'untracked'
  if (status.includes('U')) return 'conflict'
  if (status.includes('D')) return 'deleted'
  if (status.includes('A') || status.includes('C')) return 'added'
  if (status.includes('R')) return 'renamed'
  return 'modified'
}

export function formatBinaryPreview(path: string, preview: BinaryPreview, locale: Locale): string {
  const lines = [
    locale === 'zh-CN' ? `${displayName(path)} · 二进制文件 · ${preview.size.toLocaleString()} 字节` : `${displayName(path)} · Binary file · ${preview.size.toLocaleString()} bytes`,
    locale === 'zh-CN' ? '只读十六进制预览' : 'Read-only hexadecimal preview',
    '',
  ]
  for (let offset = 0; offset < preview.bytes.length; offset += 16) {
    const row = preview.bytes.slice(offset, offset + 16)
    const hex = row.map((byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const ascii = row.map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`)
  }
  if (preview.truncated) lines.push('', locale === 'zh-CN' ? `仅显示前 ${preview.bytes.length.toLocaleString()} 字节。` : `Showing only the first ${preview.bytes.length.toLocaleString()} bytes.`)
  return lines.join('\n')
}

export function isWorkspaceFile(root: string | null, path: string): boolean {
  if (!root) return false
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = path.replace(/\\/g, '/')
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

export async function readOptionalEditorConfig(path: string): Promise<string | null> {
  const slash = path.lastIndexOf('/')
  const directory = slash === 0 ? '/' : path.slice(0, slash)
  const entries = await command<FileEntry[]>('list_directory', { path: directory })
  if (!entries.some((entry) => entry.name === '.editorconfig' && !entry.is_dir)) return null
  return command<string>('read_file', { path })
}

export function displayedLineEnding(file: OpenFile | null): string {
  if (!file || file.binary) return 'LF'
  const detected = /\r\n|\r|\n/.exec(file.content)?.[0]
  if (detected) return detected === '\r\n' ? 'CRLF' : detected === '\r' ? 'CR' : 'LF'
  return file.editorConfig?.endOfLine?.toUpperCase() ?? 'LF'
}

export function iconButton(label: string, Icon: LucideIcon, onClick: () => void, disabled = false, className = '', tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right') {
  return <button className={`icon-button ${className}`} type="button" title={tooltipPlacement ? undefined : label} data-tooltip={tooltipPlacement ? label : undefined} data-tooltip-placement={tooltipPlacement} aria-label={label} onClick={onClick} disabled={disabled}><Icon size={15} strokeWidth={1.8} /></button>
}
