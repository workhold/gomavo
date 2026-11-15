/** Convert an absolute local path to the file URI expected by gopls. */
export function fileUri(path: string): string {
  if (path.startsWith('file://')) return path

  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('//')) {
    const [host, ...segments] = normalized.slice(2).split('/')
    return `file://${host}/${segments.map(encodeURIComponent).join('/')}`
  }

  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${absolute
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')}`
}

/** Convert a gopls file URI back to a local path. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const parsed = new URL(uri)
  let path = decodeURIComponent(parsed.pathname)
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  if (parsed.host && parsed.host !== 'localhost') path = `//${parsed.host}${path}`
  return path
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '')
}
