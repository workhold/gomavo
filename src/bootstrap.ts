// The HTML parser has already loaded the selected Monaco NLS table before this
// module runs. Keep the application import behind this entry point so Monaco's
// ESM modules are evaluated only after that parser-blocking script.
await import('./main')

export {}
