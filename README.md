# Cyrene 前端仓库

Cyrene 是基于 Electron、Vue 3 和 TypeScript 的桌面 AI 助手前端，包含流式对话、语音、Live2D、桌面工具与授权系统，面向 Windows 与 Ubuntu 桌面环境。

> 项目当前状态的唯一事实源是 [doc 16：实施任务清单与进度跟踪](docs/16-Cyrene-前端实施任务清单与进度跟踪.md)。README 不再复制批次状态和测试计数。

## 快速开始

仓库固定使用 Node.js 22.23.0 和 pnpm 11.20.0。完整的 Windows、Linux 与真实后端联调说明见 [doc 17：开发环境与依赖安装记录](docs/17-Cyrene-前端开发环境与依赖安装记录.md)。

Windows PowerShell：

```powershell
fnm install 22.23.0
fnm use 22.23.0
npm install -g pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm dev
```

等价的前端直启命令：

```powershell
pnpm -F @cyrene/desktop exec electron-vite dev
```

Linux shell：

```bash
fnm install 22.23.0
fnm use 22.23.0
npm install -g pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm dev
```

应用默认使用真实后端。仅在显式需要 Mock 演示时设置 `CYRENE_BACKEND=mock`：

```powershell
$env:CYRENE_BACKEND = 'mock'
pnpm dev
Remove-Item Env:CYRENE_BACKEND
```

固定远程调试端口不属于正常启动参数；当前安全策略会拒绝 `--remote-debugging-port=9223` 等固定端口。自动化调试应使用项目测试 harness 或 Playwright Electron 启动方式。

## 完整同源运行（Live2D / 媒体 / 真实联调）

`pnpm dev` 的 Renderer 运行在 `http://localhost`，适合界面与逻辑开发；Live2D 和媒体资源走 `cyrene://` 且安全策略禁止跨源，因此这类验证必须使用同源运行形态：

```powershell
pnpm build
pnpm --filter @cyrene/desktop start
```

等价方式：`cd apps\desktop` 后直接运行 `..\..\node_modules\electron\dist\electron.exe .`。

`electron-vite preview` / 产物直启加载的是 `cyrene://renderer/index.html`，与 Live2D、媒体代理同源。需要自动化调试通道时使用项目测试 harness，或显式传随机端口 `--remote-debugging-port=0`（固定端口仍被安全门拒绝）。

## 文档入口

- [doc 00：文档索引与阅读顺序](docs/00-Cyrene-前端文档索引与阅读顺序.md)——文档地图、职责和维护规则。
- [doc 16：当前实施状态](docs/16-Cyrene-前端实施任务清单与进度跟踪.md)——当前阶段、阻塞项、最近验证和下一步。
- [doc 17：环境基线](docs/17-Cyrene-前端开发环境与依赖安装记录.md)——Windows/Linux 安装、启动与联调环境。
- [Review 与验收索引](docs/review/README.md)——按日期检索决策、整改、联调和验收证据。
- [Spec、Plan 与 Final Report 索引](docs/superpowers/README.md)——历史设计和实施计划。
- [UI 原型](ref/cyrene-ui-preview-v5.html)——界面设计参考。

## 技术基线

Electron + Vue 3 + TypeScript + electron-vite + pnpm + Vitest + Playwright。

版本来源以仓库文件为准：

- [.nvmrc](.nvmrc)：Node.js 精确版本。
- [package.json](package.json)：Node 范围、pnpm 版本和根命令。
- [apps/desktop/package.json](apps/desktop/package.json)：Electron、Vue、测试和构建依赖。
- [pnpm-lock.yaml](pnpm-lock.yaml)：依赖锁定结果。

## 目录结构

```text
apps/desktop/        Electron 应用
  src/main/          主进程、后端适配、受信服务
  src/preload/       窄 IPC 桥
  src/renderer/      Vue 界面与状态管理
  src/shared/        跨进程领域契约和运行时 Schema
  tests/             单元与 Electron 集成测试
docs/                核心设计、状态与需求文档
  review/             决策、整改、联调与验收证据
  superpowers/        specs、plans 与 final reports
ref/                 UI 原型
third_party/         经审计的第三方资源
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 启动 Electron 开发环境 |
| `pnpm build` | 构建应用 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint |
| `pnpm test` | 单元测试 |
| `pnpm test:integration` | Electron 集成测试 |
| `pnpm package` | 生成当前平台的未分发目录产物 |
| `pnpm verify:artifact` | 检查产物内容与 Electron Fuses |
| `pnpm docs:check` | 检查核心文档元数据、索引和链接 |
| `pnpm docs:index` | 重新生成 review/superpowers 目录索引 |
| `pnpm -F @cyrene/desktop check:contract` | 后端契约在本机可用时执行跨仓检查 |
| `pnpm -F @cyrene/desktop verify:sensitive` | 扫描已跟踪文件中的敏感信息 |
| `pnpm test:e2e` / `pnpm make` | 阶段 8 前仍为防假绿占位命令，会以非零状态退出 |

## 真实模式联调

未打包开发态和打包产物默认均使用 Real Adapter；Mock 必须显式启用。Endpoint 和 Token 在应用连接面板中设置：

1. 设置后端 Endpoint。HTTPS 可使用远程地址；HTTP 只允许回环地址。
2. 设置 Token。Token 与 Endpoint origin 绑定，切换 origin 会清除旧 Token。
3. 点击连接。Renderer 不直接持有 Token，也不能向 Main 传入任意连接 URL。
4. 验收记录必须写明前端 SHA、后端 SHA、运行模式、平台和证据。

团队当前联调后端的位置和操作边界记录在 [doc 17](docs/17-Cyrene-前端开发环境与依赖安装记录.md)。后端进程默认由联调操作者手动启停，前端仓库文档不假设它始终在线。

## 协作约定

- 文档使用中文；历史验收记录保持不可变，只通过新记录补充或取代。
- 当前状态只更新 doc 16，README 和 CLAUDE.md 只提供链接。
- 行为变化按 [doc 00](docs/00-Cyrene-前端文档索引与阅读顺序.md) 的职责表同步设计文档。
- 不假设当前机器已有 GitHub 凭据；需要推送前运行 `gh auth status`，且只有明确要求时才执行 push。
- 不假设某个 MCP、浏览器或视觉工具必然可用；每次会话按实际工具能力选择验证方式。
