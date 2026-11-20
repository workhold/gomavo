# GoMavo 宣传方案(渠道 + 文案)

> 目标仓库:https://github.com/workhold/gomavo (v0.2.6,MIT)
> 以下文案为推广草稿，发布前核对版本、功能和平台状态。

## 0. 核心卖点(所有文案的基础)

1. **秒开、轻量**:无 JVM、原生窗口;对比 GoLand 冷启动数十秒、GB 级内存
2. **官方工具链**:gopls(补全/hover/诊断/语义高亮/跳转/格式化)+ Delve(调试)+ go CLI(运行/测试),语言服务与 VS Code Go 插件同引擎
3. **本地优先**:无账号、无遥测、无云,MIT 开源
4. **GoLand 式工作流 + macOS 原生键位**:双 ⇧ 搜索、⌘⇧O、⌘E、gutter 测试/断点、⌃R/⌃D,可在设置中重定义
5. **一体化**:测试结果树 + 单 case 重跑 + 覆盖率高亮、Git 工具窗(暂存/对比/历史/blame)、真 PTY 终端、书签、本地历史、Go 多版本选择
6. **一窗口一项目**,多窗口多项目,中英双语 UI
7. **原生插件系统** `.gomavo-plugin`,插件跑在独立 Web Worker

**目标用户**:在 Mac 上写 Go、被 GoLand 启动/内存困扰的开发者;不想在 VS Code 里拼插件的人;本地优先/开源爱好者。

## 1. 渠道清单

### 国内

| 渠道 | 方式 | 注意 |
| --- | --- | --- |
| V2EX [分享创造](https://www.v2ex.com/go/create) | 个人开源项目发一帖,正文即 §2.2 文案 | 纯营销会被移到「推广」节点;只发一次,别刷楼,重点收集反馈 |
| [HelloGitHub](https://hellogithub.com/periodical) | 官网「自荐/推荐」入口,或在 [521xueweihan/HelloGitHub](https://github.com/521xueweihan/HelloGitHub) 提 issue;每月 28 日发刊 | 文案用 §2.6 短段;附好截图 |
| 阮一峰[科技爱好者周刊](https://github.com/ruanyf/weekly) | 在 ruanyf/weekly 仓库提 issue 投稿,每周五发布 | 同上,一个 issue 一项目 |
| 掘金 juejin.cn | 发「我做了一个开源 Go IDE」经历+技术长文(§2.5) | Go 标签流量好;贴 GIF 和架构图 |
| 知乎 | 回答「GoLand 替代品」「Go 用什么 IDE」类问题 + 专栏长文 | 别只贴链接,认真回答问题本身 |
| 少数派 sspai.com | 社区投稿,Mac 效率工具视角(§2.7) | 面向 Mac 用户,少讲代码多讲体验 |
| 开源中国 OSChina | 「发现」频道提交收录 + 软件资讯 | 可同时被收录进软件库 |
| 小众软件 appinn.com | 「发现」频道自荐 | 同少数派视角 |
| 即刻 | 「独立开发者」圈子,发 demo GIF + 短文案 | 口语化,可直接和用户互动 |
| Bilibili | 3-5 分钟 demo 视频 + Go 工具链/插件开发过程 | 可拆成系列:接 gopls、接 Delve |
| GoCN (gocn.vip) | GoCN 每日新闻投稿 + 社区发帖 | 技术向 |

### 国际

| 渠道 | 方式 | 注意 |
| --- | --- | --- |
| Show HN (news.ycombinator.com) | 标题 `Show HN: GoMavo – Native Go IDE for macOS (gopls + Delve, no JVM)`,正文用 §2.3 | 周二至周四美东上午发;作者全程认真回帖是成败关键 |
| Reddit [r/golang](https://www.reddit.com/r/golang) | 直接发分享帖(§2.4),也可投 r/macapps、r/SideProject | r/golang 对自己的项目分享友好,标题别标题党 |
| Lobsters (lobste.rs) | Go tag 分享,链接帖 | 高质量技术社区,认真参与评论 |
| Go Forum (forum.golangbridge.org) | community 栏目发帖 | 英语帖 |
| Gophers Slack | show-your-work 类频道发一次 | 别私发/刷屏 |
| dev.to / Hashnode | 英文长文 "I built a Go IDE with Tauri, gopls and Delve" | 中文长文翻改即可 |
| Product Hunt | Launch 桌面应用类目(§2.9),备好截图/宣传图 | 需要提前准备:tagline、画廊图、 maker comment |
| X/Twitter | #golang + demo GIF(§2.8) | 找 Go 社区大V转发效果最好 |
| [jaywcjlove/awesome-mac](https://github.com/jaywcjlove/awesome-mac) | 提 PR 收录到开发者工具分区 | 认真写一行简介,截图链接 |
| GitHub 本身 | Releases 写好 release notes;开启 Discussions 收反馈 | 每次发版都是一波小曝光 |

### 发布节奏建议

- **第一波(发布周)**:Show HN + r/golang + V2EX 分享创造,同一周内错开;准备好当天盯评论。
- **第二波(+1~2 周)**:HelloGitHub、阮一峰周刊投稿;掘金/知乎/少数派长文;即刻、GoCN。
- **第三波(+1 月)**:Product Hunt launch;B 站/YouTube demo 视频;awesome-mac 等 PR。
- **持续**:每次 release 同步发 release notes 到 X/即刻;所有渠道留 GitHub issue 作为唯一反馈入口。

### 合规与风险提示

- **GoLand 是 JetBrains 商标**:不要用「开源免费版 GoLand」这类说法。用「受 GoLand 工作流启发的独立开源 IDE」,并保留 README 已有的免责声明(与 JetBrains 无关、未获其认可)。
- **当前 DMG 未签名/未公证**:宣传帖里提前说明 macOS 可能弹「移到废纸篓」警告,需在系统设置里放行,避免差评。
- 各平台自荐帖发布后请真人回复评论,刷帖、多号互动会被识别并拉黑。

## 2. 宣传文案

### 2.1 通用一句话与短简介

**英文 tagline**
> GoMavo — A focused, native Go IDE for macOS. gopls + Delve built in. No JVM, no accounts, no telemetry.

**中文 tagline**
> GoMavo — 为 Mac 而生的专注型 Go IDE:官方工具链 gopls + Delve,秒级启动,本地优先。

**中文短简介(约 100 字)**
> GoMavo 是一款为 macOS 打造的开源 Go IDE:无 JVM、秒级启动,内置官方 gopls 语言服务与 Delve 调试器,补全、跳转、断点调试、测试树与覆盖率、Git、PTY 终端一站式完成,键位贴合 macOS 原生体验。本地优先,无账号、无遥测,MIT 开源。

**英文短简介**
> An open-source Go IDE for macOS: seconds to launch, no JVM, official gopls language services and a bundled Delve debugger. Breakpoints, test tree with coverage, Git tool window, PTY terminal — all local, MIT licensed.

### 2.2 V2EX · 分享创造

**标题**
> 自己写了个 macOS 原生 Go IDE:GoMavo,gopls + Delve,MIT 开源

**正文**

> 各位好,分享一个我做了挺久的项目。
>
> 起因是在 Mac 上写 Go,GoLand 越来越重(JVM 冷启动、内存占用),VS Code + Go 插件又觉得太「拼装」,索性自己写了一个专注型的 Go IDE:GoMavo。
>
> 特性:
> - 语言服务全部走官方 gopls:补全、hover、诊断、语义高亮、跳转定义、格式化
> - 内置 Delve 调试器:gutter 点断点 / F9,⌃D 直接调试光标上下文(测试函数/文件/包),调用栈、变量、调试控制台齐全
> - 测试:gutter 快捷运行 ⌃R,`go test -json` 结果树、单 case 重跑、`go test -cover` 覆盖率高亮
> - Git 工具窗:分支切换、暂存/对比(统一/双栏)、提交、历史、行级 blame
> - 真 PTY 终端、书签、本地历史、.editorconfig、窗口级 Go 多版本选择
> - 键位按 GoLand macOS 默认键位实现:双 Shift 搜索、⌘⇧O、⌘E……设置里可自定义
> - 一个窗口一个项目,支持多窗口多项目;中英双语 UI
> - 原生插件系统(.gomavo-plugin),插件跑在独立 Web Worker
>
> 技术栈:Tauri 2 + React 19 + Monaco,gopls 和 dlv 打包进 app,装好就能用,本机只需有 Go 工具链。本地优先:无账号、无遥测、无云,MIT 开源:
>
> https://github.com/workhold/gomavo
>
> 已知短板(README 有诚实清单):还没有重命名重构、条件断点、goroutine 视图;Windows 安装包尚需更充分的验证。
>
> 欢迎体验拍砖,尤其想听两点:1) 如果让你从 GoLand / VS Code 迁过来,哪个缺失功能最痛;2) 有 bug 直接提 issue。

### 2.3 Show HN

**标题**
> Show HN: GoMavo – Native Go IDE for macOS (gopls + Delve, no JVM)

**正文**

> Hi HN! I built GoMavo (https://github.com/workhold/gomavo), an open-source Go IDE for macOS.
>
> I've written Go on a Mac for years and kept paying for GoLand with RAM and startup time. VS Code with the Go extension is great but felt like a toolkit rather than an IDE — I wanted something between the two: one focused window per project, IDE workflows with macOS-native shortcuts, and the official toolchain underneath.
>
> GoMavo runs gopls for language services (completion, hover, diagnostics, semantic highlighting, go-to-definition, formatting), bundles Delve for debugging (gutter breakpoints, call stack, variables, debug console), and runs/tests code with the go CLI — `go test -json` rendered as a per-case results tree with rerun, plus coverage highlighting. There's a Git tool window (staging, diffs, history, blame), a real PTY terminal, bookmarks, local history, and a native plugin system where each plugin runs in its own Web Worker. UI in English and Simplified Chinese.
>
> Technically it's Tauri 2 + React 19 + Monaco, packaged as a native macOS app; the build compiles gopls and dlv and bundles them, so users only need a Go toolchain installed. Everything runs locally — no accounts, no telemetry, no cloud.
>
> Happy to answer questions about the architecture, integrating LSP/DAP, or the inevitable trade-offs of not running a JVM.

**常见回帖预案**(提前想好,直接回复)
- *Why not VS Code + Go extension?* → 一体化工作流与键位、测试树/覆盖率/Git 窗口开箱即用,不用拼插件;两者语言引擎相同(gopls),差异在 IDE 层。
- *Cross-platform?* → 目前专注 macOS;Tauri 本身跨平台,架构上没有硬性 Windows/Linux 障碍,但先把 Mac 版做扎实。
- *Refactoring?* → 尚无 rename/extract,gopls 已提供这些能力,是路线图上的下一批功能(诚实指出,README 有清单)。
- *Notarization/signing?* → 预览版未签名,README 与 release notes 均有说明放行步骤。

### 2.4 Reddit r/golang

**标题**
> I built GoMavo, an open-source native Go IDE for macOS (gopls + Delve bundled, no JVM) — feedback welcome

**正文**

> Repo: https://github.com/workhold/gomavo (MIT)
>
> I'm an independent dev who writes Go on a Mac. I wanted a lighter alternative to GoLand without assembling an IDE out of VS Code extensions, so I built one:
>
> - gopls for completion, hover, diagnostics, semantic highlighting, go-to-definition, format
> - Delve bundled: gutter breakpoints (F9), debug under cursor (⌃D), call stack / variables / debug console
> - `go test -json` results tree with per-case rerun, coverage highlighting from `go test -cover`
> - Git tool window: branch switching, staging, unified/side-by-side diffs, history, line blame
> - Real PTY terminal, GoLand-style macOS keymap (Double-Shift, ⌘⇧O, ⌘E), English + 简体中文 UI
> - One project per window, local-first: no accounts, no telemetry
>
> Tauri 2 + React 19 + Monaco; the app bundles gopls and dlv, so you just need `go` installed.
>
> Known gaps (honest table in the README): no rename refactoring yet, no conditional breakpoints or goroutine view; the Windows build needs more validation.
>
> What would make you actually switch from GoLand or VS Code — which missing feature hurts most?

### 2.5 掘金 / 知乎长文

**标题候选**
- 《我给自己写了个 Go IDE:Tauri 2 + gopls + Delve 的完整实践(GoMavo 开源)》
- 《不想再等 GoLand 冷启动,我用 Tauri 写了个 macOS 原生 Go IDE》

**大纲**
1. 为什么自己写:GoLand 的重量 vs VS Code 的拼装感(用数据:启动时间、内存对比截图)
2. 总体架构:Tauri 2 + React 19 + Monaco,为什么要选系统 WebView 而不是 Electron/JVM
3. 接入 gopls:LSP 客户端、增量同步、语义高亮与跳转(配 GIF)
4. 内置 Delve:DAP 协议、断点/调用栈/调试控制台、⌃D 上下文调试
5. 测试体验:`go test -json` 解析成结果树、单 case 重跑、覆盖率高亮
6. 难点:中文输入法与编辑器事件、多窗口状态恢复、把 gopls/dlv 打包进 app
7. 插件系统设计:.gomavo-plugin 清单 + Web Worker 沙箱边界(诚实说明不是安全沙箱)
8. 下载地址 + 已知短板 + 求反馈

**开头两段(可直接用)**

> 作为 Mac 上的 Gopher,我的一天经常这样开始:打开 GoLand,泡杯咖啡,等 JVM。它很好,也越来越重;VS Code + Go 插件轻快,但要凑齐测试、调试、Git、终端,总感觉是在「组装」一个 IDE,而不是「打开」一个 IDE。
>
> 于是我花了大半年,用 Tauri 2 + React 19 + Monaco 写了一个专注型的 Go IDE——GoMavo:语言服务走官方 gopls,调试内置 Delve,运行测试交给 go CLI,键位按 GoLand 的 macOS 默认键位实现。现在它 MIT 开源,分享给同样被这个问题困扰的人。

### 2.6 HelloGitHub / 阮一峰周刊 投稿 issue 短段

> GoMavo:macOS 原生 Go IDE(Tauri 2 + React 19 + Monaco)。内置官方 gopls 语言服务与 Delve 调试器,支持补全/跳转/语义高亮、gutter 断点调试、go test 结果树与单 case 重跑、覆盖率高亮、Git 工具窗、PTY 终端、本地历史与原生插件系统。无 JVM、秒级启动,本地优先(无账号、无遥测),MIT 开源,支持中英文界面。GitHub:https://github.com/workhold/gomavo

### 2.7 少数派 / 小众软件(Mac 用户视角)

> 如果你在 Mac 上写 Go,大概率在两件事之间纠结:GoLand 功能全但启动慢、吃内存;VS Code 轻快但插件要自己拼。GoMavo 想要的正是中间那个位置——一个为 macOS 原生打造的专注型 Go IDE。
>
> 它把日常 Go 开发要用的东西一次装齐:补全、跳转、诊断由官方 gopls 提供;点一下侧边栏就能打断点,F9 切换、⌃D 直接调试当前测试,调用栈和变量面板都在;测试文件里就有运行按钮,结果按 case 展示成树,还能单测重跑和覆盖率高亮。Git 提交、diff、blame 和一个真终端也都在一个窗口里。
>
> 快捷键对 GoLand 用户几乎零成本:双 Shift 全局搜索、⌘⇧O 找文件、⌘E 最近文件。没有账号、没有遥测、不上传任何东西,MIT 开源免费。macOS 与 Windows 安装包可在 GitHub Releases 下载，Windows 版本仍需充分验证。

### 2.8 X/Twitter

**英文 1(项目向)**
> I built GoMavo — an open-source, native Go IDE for macOS.
>
> gopls + Delve bundled, GoLand-style macOS keymap, test tree with coverage, Git tool window, real PTY terminal. One project per window.
>
> No JVM. No accounts. No telemetry. MIT.
>
> https://github.com/workhold/gomavo #golang #opensource

**英文 2(构建故事向)**
> Why I built my own Go IDE: GoLand costs GBs of RAM and a JVM cold start; VS Code is a toolkit, not an IDE. So: Tauri 2 + React 19 + Monaco, official gopls, Delve bundled, ~seconds to launch. Honest gap list in the README. Feedback welcome: https://github.com/workhold/gomavo

**中文(即刻/朋友圈通用)**
> 写 Go 的朋友看过来:我开源了一个 macOS 原生 Go IDE——GoMavo。官方 gopls 补全跳转、内置 Delve 断点调试、测试树+覆盖率、Git 工具窗、真终端,键位就是 GoLand 的 macOS 键位,GoLand 用户无缝切。无 JVM 秒开,无账号无遥测,MIT 开源免费。求体验求提 issue:https://github.com/workhold/gomavo

### 2.9 Product Hunt

**Tagline(60 字符内)**
> A focused, native Go IDE for macOS — gopls + Delve, no JVM

**Description**
> GoMavo is an open-source Go IDE built natively for macOS. Official toolchain underneath: gopls for completion and navigation, Delve for debugging, go CLI for running and testing — with a per-case test tree, coverage highlighting, a Git tool window, and a real PTY terminal. GoLand-style shortcuts, English + Chinese UI. Local-first: no accounts, no telemetry, no cloud. MIT licensed.

**Maker comment(发布当天用)**
> Hi PH! I'm the solo dev behind GoMavo. I write Go on a Mac and wanted something lighter than a JVM IDE but more integrated than a text editor. v0.2.6 covers editing, debugging, testing, Git and terminal — with an honest feature-gap list in the README. Try the DMG from GitHub Releases (unsigned preview build — macOS may ask you to approve it manually) and tell me what's missing. Everything is MIT-licensed and runs 100% locally.

## 3. 发布前检查清单

- [ ] README 首屏有无 30 秒 GIF(动图比截图转化高很多)
- [ ] Releases 页挂最新 DMG + 截图;release notes 写清「未签名」提示
- [ ] 开启 GitHub Discussions 或明确 issue 模板,各渠道统一引导到一处
- [ ] 文案中的版本号、下载链接与当前 release 一致
- [ ] 商标免责声明保留(与 JetBrains 无关)
