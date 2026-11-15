import type { Locale } from './i18n'

const browserOnlyMessage = '请在 Tauri 桌面应用中使用本机功能。运行 npm run tauri dev 启动桌面版。'

// Only messages created by this app are translated. External process and OS
// details remain in their original language so they can still be searched.
const exactMessages = new Map<string, string>([
  ['Internal state lock is poisoned', '内部状态锁已损坏'],
  ['Open a workspace before using project commands', '请先打开工作区，再使用项目命令'],
  ['Path is outside the open workspace', '路径不在当前工作区内'],
  ['Expected a file or directory name', '请提供文件或文件夹名称'],
  ['Expected a parent directory', '找不到上级文件夹'],
  ['Expected a directory', '需要文件夹'],
  ['Expected a file', '需要文件'],
  ['Workspace must be a directory', '工作区必须是文件夹'],
  ['Workspace root must be a directory', '工作区根路径必须是文件夹'],
  ['Only Go source files can be read outside the workspace', '工作区外只能读取 Go 源文件'],
  ['Expected a Go source file', '需要 Go 源文件'],
  ['Go source path is outside the SDK, module cache, and configured local modules', 'Go 源文件路径不在 SDK、模块缓存或已配置的本地模块中'],
  ['Save conflict: File no longer exists on disk', '保存冲突：磁盘上的文件已不存在'],
  ['Save conflict: File changed on disk. Reload before saving', '保存冲突：磁盘上的文件已改变，请重新加载后再保存'],
  ['Cannot rename the open workspace', '不能重命名当前工作区'],
  ['Destination already exists', '目标已存在'],
  ['Cannot delete the open workspace', '不能删除当前工作区'],
  ['Git command failed', 'Git 命令执行失败'],
  ['Current folder is not a Git repository', '当前文件夹不是 Git 仓库'],
  ['Git repository is outside the open workspace', 'Git 仓库不在当前工作区内'],
  ['Git path must stay inside the open workspace', 'Git 路径必须位于当前工作区内'],
  ['Expected a file path', '需要文件路径'],
  ['File is neither tracked nor present', '文件未被 Git 跟踪且不存在'],
  ['Commit message must not be empty', '提交说明不能为空'],
  ['Staged changes outside the open workspace must be committed separately', '当前工作区外的暂存更改需要单独提交'],
  ['No staged changes to commit', '没有可提交的暂存更改'],
  ['Run file scope requires a Go source file', '按文件运行时需要 Go 源文件'],
  ['Go source file has no parent directory', 'Go 源文件没有上级文件夹'],
  ['Additional Go task arguments are not supported', '不支持额外的 Go 任务参数'],
  ['Workspace test scope does not accept targetPath', '工作区测试范围不接受 targetPath'],
  ['File test scope requires targetPath', '按文件测试时必须提供 targetPath'],
  ['Package test scope requires targetPath', '按包测试时必须提供 targetPath'],
  ['Directory test scope requires targetPath', '按文件夹测试时必须提供 targetPath'],
  ['Run task does not accept testName', '运行任务不接受 testName'],
  ['Workspace run scope does not accept targetPath', '工作区运行范围不接受 targetPath'],
  ['File run scope requires targetPath', '按文件运行时必须提供 targetPath'],
  ['Package or directory run scope requires targetPath', '按包或文件夹运行时必须提供 targetPath'],
  ['Go task process ID is out of range', 'Go 任务进程 ID 超出范围'],
  ['Go stdout is unavailable', '无法读取 Go 标准输出'],
  ['Go stderr is unavailable', '无法读取 Go 标准错误输出'],
  ['Task has already exited', '任务已结束'],
  ['Terminal has already exited', '终端会话已结束'],
  ['Terminal size must be positive', '终端行数和列数必须大于零'],
  ['gopls stdin is unavailable', 'gopls 标准输入不可用'],
  ['gopls stdout is unavailable', 'gopls 标准输出不可用'],
  ['gopls stderr is unavailable', 'gopls 标准错误输出不可用'],
  ['gopls is not running for this workspace', 'gopls 未在当前工作区运行'],
  ['gopls is not installed', 'gopls 未安装'],
  ['Incomplete LSP headers', 'LSP 消息头不完整'],
  ['Invalid LSP Content-Length', 'LSP Content-Length 无效'],
  ['Missing LSP Content-Length', 'LSP 消息缺少 Content-Length'],
  ['LSP message is too large', 'LSP 消息过大'],
  ['File test scope requires a Go source file', '按文件测试时需要 Go 源文件'],
  ['Go test file has no parent directory', 'Go 测试文件没有上级文件夹'],
  ['Invalid Go filename', 'Go 文件名无效'],
  ["Package path contains Go's ... wildcard", '包路径包含 Go 的 ... 通配符'],
  ['Invalid test name', '测试名称无效'],
  ['gopls client has stopped', 'gopls 客户端已停止'],
  ['gopls stopped', 'gopls 已停止'],
  ['Workspace edits are not supported', '不支持工作区编辑'],
  ['initialize timed out', 'gopls 初始化超时'],
  ['textDocument/definition timed out', '跳转定义请求超时'],
  ['textDocument/completion timed out', '代码补全请求超时'],
  ['textDocument/hover timed out', '悬停信息请求超时'],
  ['textDocument/semanticTokens/full timed out', '语义高亮请求超时'],
])

const goplsStartPrefixes = ['Unable to start gopls: ', 'Could not start gopls: '] as const

export function localizeError(locale: Locale, message: string): string {
  if (locale === 'en-US' && message === browserOnlyMessage) {
    return 'Use the Tauri desktop app for local features. Run npm run tauri dev to start it.'
  }
  if (locale === 'en-US') return message

  const exact = exactMessages.get(message)
  if (exact !== undefined) return exact

  if (goplsStartPrefixes.some((prefix) => message.startsWith(prefix))) {
    let detail = message
    for (const prefix of goplsStartPrefixes) {
      if (detail.startsWith(prefix)) detail = detail.slice(prefix.length)
    }
    return `无法启动 gopls：${localizeError(locale, detail)}`
  }

  const metadataPrefix = 'Could not query Go project metadata: '
  if (message.startsWith(metadataPrefix)) return `无法查询 Go 项目元数据：${message.slice(metadataPrefix.length)}`

  const missingTestsPrefix = 'No Test, Example, or Fuzz functions found in '
  if (message.startsWith(missingTestsPrefix)) return `在 ${message.slice(missingTestsPrefix.length)} 中未找到 Test、Example 或 Fuzz 函数`

  const undeclaredTest = /^Test (.+) is not declared in (.+)$/.exec(message)
  if (undeclaredTest) return `测试 ${undeclaredTest[1]} 未在 ${undeclaredTest[2]} 中声明`

  const missingTestFile = /^No matching test file for (.+) \(expected (.+_test\.go)\)$/.exec(message)
  if (missingTestFile) return `找不到与 ${missingTestFile[1]} 对应的测试文件（预期为 ${missingTestFile[2]}）`

  const unsupportedTaskOptions = /^(\S+) does not accept scope, targetPath, or testName$/.exec(message)
  if (unsupportedTaskOptions) return `${unsupportedTaskOptions[1]} 不接受 scope、targetPath 或 testName 参数`

  const unknownTaskPrefix = 'Unknown Go task: '
  if (message.startsWith(unknownTaskPrefix)) return `未知的 Go 任务：${message.slice(unknownTaskPrefix.length)}`

  const missingMethodPrefix = 'Method not found: '
  if (message.startsWith(missingMethodPrefix)) return `找不到方法：${message.slice(missingMethodPrefix.length)}`

  return message
}
