// A MGLand native plugin is one self-contained JavaScript module.
// The host passes a small, MGLand-owned API to activate(context).
export function activate(context) {
  context.subscriptions.push(context.commands.registerCommand('example.native-hello.greet', () => {
    const location = context.workspace.rootPath ?? '尚未打开项目'
    context.window.showInformationMessage(`Native Hello：${location}`)
  }))

  context.subscriptions.push(context.languages.registerCompletionItemProvider('go', {
    provideCompletionItems() {
      return [{
        label: 'mghello',
        insertText: 'println("Hello, MGLand")',
        detail: 'MGLand 原生插件示例',
        documentation: '插入使用 Go 内置 println 的问候语。',
        kind: 'function',
      }]
    },
  }))

  context.subscriptions.push(context.languages.registerHoverProvider('go', {
    provideHover(document, position) {
      const line = document.text.split(/\r?\n/)[position.lineNumber - 1] ?? ''
      const offset = position.column - 1
      const start = line.slice(0, offset).match(/[A-Za-z_][A-Za-z_0-9]*$/)?.[0] ?? ''
      const end = line.slice(offset).match(/^[A-Za-z_0-9]*/)?.[0] ?? ''
      return `${start}${end}` === 'mghello' ? 'MGLand 原生插件提供的示例悬停提示。' : null
    },
  }))
}
