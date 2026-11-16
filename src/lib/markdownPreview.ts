// Minimal, safe Markdown renderer for the editor preview pane. All source
// text is HTML-escaped before the handful of structural transforms run, so
// content can never inject markup.

interface Block {
  kind: 'code' | 'html'
  html: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inline(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) =>
    /^(https?:|#|\/)/.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>` : label)
  return out
}

/** Convert Markdown source to HTML with the subset GoLand's preview renders. */
export function renderMarkdown(source: string): string {
  const blocks: Block[] = []
  // Fence code blocks first so their content passes through untouched.
  const withoutCode = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    blocks.push({ kind: 'code', html: `<pre><code class="lang-${escapeHtml(lang.trim())}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>` })
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })
  const lines = withoutCode.split('\n')
  const html: string[] = []
  let listMode: 'ul' | 'ol' | null = null
  let paragraph: string[] = []
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) { html.push(`<p>${inline(paragraph.join('\n'))}</p>`); paragraph = [] }
  }
  const flushList = () => { if (listMode) { html.push(`</${listMode}>`); listMode = null } }
  const flushQuote = () => {
    if (quote.length) { html.push(`<blockquote><p>${inline(quote.join('\n'))}</p></blockquote>`); quote = [] }
  }
  const flushAll = () => { flushParagraph(); flushList(); flushQuote() }

  for (const raw of lines) {
    const line = raw
    const blockMarker = /^\u0000BLOCK(\d+)\u0000$/.exec(line.trim())
    if (blockMarker) { flushAll(); html.push(blocks[Number(blockMarker[1])].html); continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); html.push('<hr />'); continue }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph(); flushQuote()
      if (listMode !== 'ul') { flushList(); html.push('<ul>'); listMode = 'ul' }
      html.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph(); flushQuote()
      if (listMode !== 'ol') { flushList(); html.push('<ol>'); listMode = 'ol' }
      html.push(`<li>${inline(ordered[1])}</li>`)
      continue
    }
    const quoted = /^>\s?(.*)$/.exec(line)
    if (quoted) {
      flushParagraph(); flushList()
      quote.push(quoted[1])
      continue
    }
    if (!line.trim()) { flushAll(); continue }
    flushList(); flushQuote()
    paragraph.push(line)
  }
  flushAll()
  return html.join('\n')
}
