import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown } from '../src/lib/markdownPreview.ts'

test('escapes raw HTML so content cannot inject markup', () => {
  const html = renderMarkdown('<script>alert(1)</script>')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('renders headings, lists, code fences, quotes, and rules', () => {
  const html = renderMarkdown([
    '# Title',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```go',
    'x := 1 < 2 && "a"',
    '```',
  ].join('\n'))
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/)
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/)
  assert.match(html, /<hr \/>/)
  assert.match(html, /<pre><code class="lang-go">/)
  assert.ok(html.includes('x := 1 &lt; 2 &amp;&amp; &quot;a&quot;'))
})

test('renders inline emphasis, code, and safe links', () => {
  const html = renderMarkdown('a **bold** and *em* with `code` and [x](https://a.b) and [bad](javascript:alert(1))')
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>em<\/em>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<a href="https:\/\/a\.b" target="_blank" rel="noreferrer noopener">x<\/a>/)
  assert.ok(!html.includes('javascript:alert'))
})
