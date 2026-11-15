import type * as Monaco from 'monaco-editor/editor/editor.api'

/** Small grammars for project files that Monaco does not ship with. */
export function installProjectFileHighlight(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'gomod', filenames: ['go.mod', 'go.work'], aliases: ['Go module', 'Go workspace'] })
  monaco.languages.setMonarchTokensProvider('gomod', {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\b(?:module|go|toolchain|require|replace|exclude|retract|use|tool|godebug)\b/, 'keyword'],
        [/=>/, 'operator'],
        [/\bv\d+(?:\.\d+)+(?:[-+][\w.]+)?(?:\/go\.mod)?\b/, 'number'],
        [/\b\d+(?:\.\d+)+\b/, 'number'],
        [/[()\[\]]/, 'delimiter'],
        [/"(?:\\.|[^"\\])*"/, 'string'],
        [/[^\s()\[\]"=]+/, 'string'],
      ],
    },
  })
  monaco.languages.setLanguageConfiguration('gomod', { comments: { lineComment: '//' }, brackets: [['(', ')']] })

  monaco.languages.register({ id: 'gosum', filenames: ['go.sum', 'go.work.sum'], aliases: ['Go checksums'] })
  monaco.languages.setMonarchTokensProvider('gosum', {
    tokenizer: {
      root: [
        [/\s+/, ''],
        [/\bv\d+(?:\.\d+)+(?:[-+][\w.]+)?(?:\/go\.mod)?\b/, 'number'],
        [/\bh1:[A-Za-z0-9+/=]+/, 'string'],
        [/[^\s]+/, 'identifier'],
      ],
    },
  })

  monaco.languages.register({ id: 'gitignore', filenames: ['.gitignore', '.dockerignore', '.ignore', '.rgignore'], aliases: ['Ignore patterns'] })
  monaco.languages.setMonarchTokensProvider('gitignore', {
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*!/, 'keyword'],
        [/\\[#!*?\[\]\\]/, 'string.escape'],
        [/\*\*|\*|\?/, 'regexp'],
        [/\[[^\]]+\]/, 'regexp'],
        [/\//, 'delimiter'],
        [/[^\\*?\[\]\/]+/, 'string'],
      ],
    },
  })
  monaco.languages.setLanguageConfiguration('gitignore', { comments: { lineComment: '#' } })

  monaco.languages.register({ id: 'dotenv', aliases: ['Environment variables'] })
  monaco.languages.setMonarchTokensProvider('dotenv', {
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*(?:export\s+)?[A-Za-z_][\w]*(?=\s*=)/, 'attribute.name'],
        [/\$\{[A-Za-z_][\w]*\}/, 'keyword'],
        [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'string'],
        [/\b(?:true|false|yes|no)\b/i, 'keyword'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
        [/#.*$/, 'comment'],
        [/=/, 'operator'],
        [/[\w./:@+%\-]+/, 'string'],
      ],
    },
  })
  monaco.languages.setLanguageConfiguration('dotenv', { comments: { lineComment: '#' } })

  monaco.languages.register({ id: 'makefile', filenames: ['Makefile', 'GNUmakefile'], aliases: ['Makefile'] })
  monaco.languages.setMonarchTokensProvider('makefile', {
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^[^\s:#=]+(?=\s*:)/, 'function.definition'],
        [/^[A-Za-z_][\w.-]*(?=\s*(?::=|\?=|\+=|=))/, 'attribute.name'],
        [/\$\([^)]*\)|\$\{[^}]*\}|\$[@<?^+*]/, 'keyword'],
        [/\b(?:include|export|override|define|endef|ifdef|ifndef|ifeq|ifneq|else|endif|.PHONY)\b/, 'keyword'],
        [/(?::=|\?=|\+=|=|:)/, 'operator'],
        [/[^\s]+/, 'string'],
      ],
    },
  })
  monaco.languages.setLanguageConfiguration('makefile', { comments: { lineComment: '#' } })
}
