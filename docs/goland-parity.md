# GoLand 与 GoMavo 功能对照

对照日期：2026-11-14（2026-11-15 更新调试、覆盖率与 blame 条目）。本机 GoLand 为 **2026.1.1**（#GO-261.23567.143）；JetBrains 官方帮助页可能已更新至 2026.2。GoMavo 指本工作区当前代码。表中的“实机”表示观察到界面或行为；“代码”表示实现存在，尚不能等同于在所有项目中通过桌面验证。

| 功能 | GoLand 基线 | GoMavo 当前状态 | 尚有的差距 |
| --- | --- | --- | --- |
| 新建与打开项目 | 实机 File 菜单提供 New → Project 与 Open。 | Dock 菜单可新建窗口；File 菜单和顶部项目入口可新建窗口、新建或打开项目。空白新窗口显示打开已有项目与新建 Go 项目的选择。新建项目创建目录并执行 `go mod init`。已打开项目时，新项目在单独的应用窗口中启动。 | 尚无 GoLand 的项目模板、SDK 配置向导和多模块工程模型。 |
| 设置 | 实机设置采用分组树；可搜索设置项，并在应用菜单或 ⌘, 打开。 | 设置对话框提供分组导航与搜索；顶部齿轮、⌘, 及 macOS 应用菜单 Settings… 都可打开。现有选项涵盖外观、编辑器、项目树、版本控制刷新、终端字号、语言、快捷键与插件管理。 | Go SDK、构建/部署、同步和高级设置等 GoLand 分类尚无对应配置能力。 |
| 代码样式 | 项目可通过 `.editorconfig` 指定缩进、换行和保存时的空白规则。 | 按当前文件位置合并项目内 `.editorconfig`；缩进设置作用于编辑器，换行与空白规则作用于保存。项目树可新建 EditorConfig 文件。 | 暂未覆盖 EditorConfig 全部属性与插件扩展。 |
| 插件 | 实机设置内分 Marketplace／已安装，支持从磁盘安装。JetBrains 插件依赖 IntelliJ Platform 的 JVM 扩展点和产品模块。 | 「设置 → 插件」中可从磁盘导入、启停和移除 [GoMavo 原生插件](../src/lib/plugins/nativePlugins.ts)或 [JSON 命令清单](../src/lib/plugins/plugins.ts)。原生插件能贡献命令、Monaco 补全与悬停；JSON 命令只可调用已有 Go 任务或打开项目文件。 | 当前没有在线插件市场。Marketplace ZIP/JAR **无法在现有 Tauri 宿主中直接运行**。原版插件需要 IntelliJ Platform 宿主；[JetBrains 插件内容](https://plugins.jetbrains.com/docs/intellij/plugin-content.html)、[GoLand 插件开发](https://plugins.jetbrains.com/docs/intellij/goland.html)。 |
| 项目树 | 实机可打开文件、显示 Git 状态颜色；工具栏有选择打开文件、扩展所选、全部收起和选项。[官方项目树说明](https://www.jetbrains.com/help/go/project-tool-window.html) | 可打开、创建、重命名、删除、刷新文件；文件和目录右键菜单提供相应操作与复制路径；已显示 Git 状态颜色与 `_test.go` 专用图标；工具栏可定位当前文件、全部收起。 | 尚无扩展所选和独立 Structure 工具窗口；外部文件变动仍主要依赖手动刷新。 |
| Go 编辑 | 补全、诊断、格式化、意图操作、检查等。 [官方快速入门](https://www.jetbrains.com/help/go/quick-start-guide-goland.html) | [gopls 桥接](../src/lib/lsp/client.ts)提供补全、悬停、诊断、语义高亮、定义与当前文件格式化。 | 缺 Find Usages、符号重命名、Quick Fix／意图操作和 GoLand 的检查配置。 |
| 跳转定义 | 实机可跳至项目与模块缓存源码。 | ⌘B、F12、⌘点击定义链接可打开工作区文件及受允许的 Go SDK／模块源码只读标签；后退／前进保留光标与滚动位置，支持 ⌘⌥←／→ 和 ⌘[／]。 | 缺用法视图及任意外部文件工作流。 |
| 单方法测试 | 实机 `_test.go` 标签有绿色运行角标，`package` 行双三角、Test 方法行单三角；结果窗口有测试树、通过数、耗时和控制台。[官方运行测试说明](https://www.jetbrains.com/help/go/performing-tests.html) | `_test.go` 图标、包与方法 gutter、文件／包／目录／项目测试、结果树和控制台已实现；⌃R 在测试编辑器中按光标上下文运行；结果树支持重跑单项；方法 gutter 反映通过／失败状态。「带覆盖率运行」收集 `go test -cover` 数据并在编辑器高亮覆盖／未覆盖代码（代码实现）。 | gutter 多动作菜单与自动重跑未覆盖；覆盖率细节视图待实机验证。 |
| 快速生成测试 | GoLand 可从函数或文件创建测试。 | Go 源文件在项目树右键可生成测试桩；编辑器右键可对单个方法或整文件生成，写入同目录的 `_test.go` 并跳过已有同名测试。 | 生成的是待填写的测试桩，尚无测试用例内容推导。 |
| Benchmark／Fuzz | 可从 gutter 选择运行；支持测试配置参数。[官方运行测试说明](https://www.jetbrains.com/help/go/performing-tests.html) | Benchmark 使用 `-bench` 选择、Fuzz 种子用例可通过 `-run` 执行；代码在 [go_tasks.rs](../src-tauri/src/go_tasks.rs)。 | Fuzz 持续模糊测试、停止条件、失败语料定位和高级 Benchmark 参数 UI 尚无。 |
| 运行配置 | 可保存临时配置，指定参数／环境，运行、调试并重跑。[官方运行配置说明](https://www.jetbrains.com/help/go/run-debug-configuration.html) | 顶部可切换运行、测试、编译及当前选择的目标；任务可停止。 | 缺持久配置、程序参数／环境变量、并行配置和任务前后动作。 |
| Git | 实机项目树已修改文件名变蓝；官方支持文件及局部改动暂存、changelist 与提交。[官方提交说明](https://www.jetbrains.com/help/go/commit-and-push-changes.html) | [项目树、编辑器标签与 Git 侧栏](../src/App.tsx)显示 Git 状态；支持查看差异、整文件暂存／取消、提交、分支、近期历史与文件历史；编辑器右键可按行查看 Git Blame（代码实现）。 | 缺行／块级暂存、changelist、merge／rebase 图形界面。 |
| 终端 | 可运行项目目录命令。 | xterm.js + 本机 PTY，支持输入、缩放和重启会话。 | 多会话与深度 Shell 集成尚无。 |
| 调试 | 断点、单步、变量、调用栈和 goroutine 视图。[官方调试说明](https://www.jetbrains.com/help/go/debugging-code.html) | 代码实现内置 Delve（DAP）：源文件 gutter 点击或 F9 切换断点，⌃D 调试当前上下文（测试方法／测试文件／包）；Debug 工具窗口提供调用栈（可切换栈帧）、变量、调试控制台与停止。开发包已目视验证断点与面板状态，但 Dev 模式曾出现 Delve 启动超时，安装包行为待复核。 | 条件断点、单步按钮区、goroutine 视图、core dump 与远程调试未覆盖。 |

## 下一轮优先级

1. **P1：测试反馈闭环。** 覆盖率与 Delve 调试已实现；剩余自动重跑、覆盖率细节视图，并在安装包中复核 Delve 启动。
2. **P1：Go 语义操作。** 基于 gopls 增加 Find Usages、Rename Symbol、Code Action；这些比继续堆外观更能改善日常开发。
3. **P2：项目与 Git 细节。** 外部文件变化通知、项目树扩展所选与局部暂存。
4. **长期架构选择：插件。** 如必须使用 JetBrains 原版插件，应评估转向 IntelliJ Platform；保留当前架构则继续发展 GoMavo 自有扩展 API，不能把 Marketplace 下载当作兼容实现。

本轮使用隔离的临时 Go 项目验证 GoMavo 桌面包：方法 gutter 和光标 ⌃R 均只运行 `TestFast`，结果面板刷新仍只运行 `TestFast`；文件上下文运行同时显示 `TestFast` 通过与故意失败的 `TestSlow`，点失败项重跑后只出现 `TestSlow`；`BenchmarkAdd` 单独运行并显示通过。更新后的桌面包还验证了 package 行双 ▶ 运行当前包、Test gutter 的通过／失败图标、点击结果图标重跑单项、项目树全部收起后定位当前文件，以及已修改文件在项目树和编辑器标签中的颜色。测试运行未更改用户项目。

本次继续用隔离项目验证 File → New → Project 创建 `go.mod`、顶部入口打开另一项目时启动独立窗口，并确认新窗口加载目标项目。新增的空白窗口入口在 macOS 调试包中验证：顶部项目菜单与 ⌘N 都打开项目选择页；「新建项目」进入创建表单，「打开已有项目」会在当前空白窗口加载选定目录。右键菜单可在项目根、文件夹和文件上打开；新建、复制路径反馈、F2 重命名、Shift+F10 菜单和文件夹展开已在桌面包中验证。原生删除确认的「取消」保留了文件；有未保存内容时，确认框显示警告，取消后编辑内容仍在。未保存标签关闭的取消操作也保留了内容。`.editorconfig` 的缩进更新、CRLF、尾随空白和末尾换行规则经过编辑器操作和磁盘字节检查。Dock 菜单的 AppKit 桥接已编译链接，但自动化工具无法访问 macOS Dock，因此 Dock 右键入口仍需人工目视验证。

实机对照时，GoLand 对现有项目的 `TestNewLowercaseIDGenerator` 执行过一次：1/1 通过、628 ms、退出码 0；未编辑源码或配置。后续执行验证使用上述隔离的临时 Go 项目。
