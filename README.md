# Cyrene 前端仓库

Cyrene 是基于 Electron、Vue 3 和 TypeScript 的桌面 AI 助手前端，包含流式对话、语音、Live2D、桌面工具与授权系统，面向 Windows 与 Ubuntu 桌面环境。

> 项目当前状态的唯一事实源是 [doc 16：实施任务清单与进度跟踪](docs/16-Cyrene-前端实施任务清单与进度跟踪.md)。README 不再复制批次状态和测试计数。

## 快速开始

仓库固定使用 Node.js **22.23.0** 和 pnpm **11.20.0**（版本来源：`.nvmrc`、`package.json` 的 `engines` 与 `packageManager`）。用其他主版本会由 `check:node` 直接拒绝，不会静默跑偏。

### 首次准备（每条命令各跑一次）

```powershell
# 1) Node 版本管理器（若已装 fnm 可跳过；Windows 推荐 winget）
winget install Schniz.fnm
#    装完重开一个终端，让 fnm 进入 PATH

# 2) 固定 Node 版本（.nvmrc 也是 22.23.0）
fnm install 22.23.0
fnm use 22.23.0
node --version          # 期望 v22.23.0

# 3) pnpm
npm install -g pnpm@11.20.0
pnpm --version          # 期望 11.20.0

# 4) 依赖（首次会下载 Electron 二进制，约 215MB，耗时取决于网络；不是卡住）
pnpm install --frozen-lockfile

# 5) 自检
pnpm check:node         # 期望 exit 0
```

### 每次启动

```powershell
fnm use 22.23.0         # 新开的终端需要重新激活 Node 版本
pnpm dev
```

`pnpm dev` 会构建主进程/preload 并在 **`http://127.0.0.1:5373`** 起 Renderer，然后拉起 Electron 窗口（标题 `Cyrene`）。开发态 CI 之外的启动只需这一条命令。

端口是**固定**的（`strictPort`）：5373 被占用时 Vite 直接报错退出，不会静默换到 5174。同机并行开发多个 Electron 项目时按 [doc 19](docs/19-Cyrene-前端开发环境隔离与资源登记.md) 的项目号段取号。

开发态的 userData 是 `%APPDATA%\Cyrene-Dev`，与打包产物的 `%APPDATA%\Cyrene` 分仓——`pnpm dev` 不会写入正式版的凭据、设置、会话或模型目录。

Linux 把 `winget install Schniz.fnm` 换成 `curl -fsSL https://fnm.vercel.app/install | bash`，其余命令相同。

> **一键脚本**：Windows 可用 `scripts\setup-windows.ps1`（检查 Node/pnpm 版本、按需安装依赖、可选启动）。它只是把上面几步串起来，不替代理解——脚本做的事就是这几条命令。

### 启动后还需一步：Live2D 模型

**仓库不分发 Live2D 模型**（只含 Cubism 运行时与 shader，见 `apps/desktop/src/renderer/public/live2d/`）。没有模型时角色面板会显示「模型不可用」，这是预期现象而非故障。装配自己的模型：

```powershell
pnpm live2d:install --model-dir <模型目录> --id <slug> --display-name "<显示名>"
```

模型目录需含 `model3.json`、`.moc3` 与至少一张贴图（可选 `icon.png` 作为预览图；可选 `--license-note <file>` 注入许可说明）。脚本会计算 SHA-256 完整性清单并安装到 userData 的 `models/`（Windows 开发态：`%APPDATA%\Cyrene-Dev\models`；加 `--user-data default` 则装到打包产物目录 `%APPDATA%\Cyrene\models`）。详见 [doc 17 §3.1](docs/17-Cyrene-前端开发环境与依赖安装记录.md) 与 [doc 19 §6](docs/19-Cyrene-前端开发环境隔离与资源登记.md)。

模型授权见 `EXT-01`（doc 16 §4.1）：**只装配来源与授权明确的模型**。

### 常见坑

- **`pnpm start` 报 `ERR_PNPM_NO_SCRIPT_OR_SERVER`**：旧版仓库根目录没有 `start` 别名，现已补上；请更新到最新 `main`。
- **`node --version` 不是 v22.23.0**：`fnm use 22.23.0` 后仍不对，说明终端没重开或 PATH 里有另一个 Node 抢先。
- **换了终端就必须重跑 `fnm use`**：fnm 是 per-shell 的。

应用默认使用真实后端。仅在显式需要 Mock 演示时设置 `CYRENE_BACKEND=mock`：

```powershell
$env:CYRENE_BACKEND = 'mock'
pnpm dev
Remove-Item Env:CYRENE_BACKEND
```

固定远程调试端口不属于正常启动参数；当前安全策略会拒绝 `--remote-debugging-port=9223` 等固定端口。自动化调试应使用项目测试 harness 或 Playwright Electron 启动方式。

## 打包产物运行与 Live2D/媒体协议验证

`pnpm dev` 下 Renderer 由 Vite dev server 供给（`http://localhost:<port>`），而打包产物加载 `cyrene://renderer/index.html`。**Live2D 与媒体在两种形态下都可用**，但 Live2D 模型文件的传输方式按是否同源分支（2026-09-10 修复）：

- dev 形态：页面与 `cyrene://` **跨源**，而 `cyrene` scheme 恒为 `corsEnabled:false`（安全设计），原生 `fetch` 会被 Chromium 拒绝 → 模型文件改走 IPC `live2d:read-model-file`。
- 打包形态：页面自身即 `cyrene://renderer`（同源）→ 原生 `fetch`。

若你在 `pnpm dev` 下看到「模型加载失败 / 原因：Failed to fetch」**同时**「已发现 N 个模型，其中可用 N 个」——那是修复前的旧形态（这两句并不矛盾：清单走 invoke 通道不受跨源限制）。详见 [doc 17 §4.1](docs/17-Cyrene-前端开发环境与依赖安装记录.md)。

因此下面这一步**不是跑 Live2D 的前置条件**，而是用来验证与发布形态一致的行为（自定义协议、产物 CSP、打包资源解析）：

```powershell
pnpm build
pnpm start
```

等价方式：`cd apps\desktop` 后运行 `..\..\node_modules\electron\dist\electron.exe .`。

需要自动化调试通道时使用项目测试 harness，或显式传随机端口 `--remote-debugging-port=0`（固定端口仍被安全门拒绝）。

## 文档入口

- [doc 00：文档索引与阅读顺序](docs/00-Cyrene-前端文档索引与阅读顺序.md)——文档地图、职责和维护规则。
- [doc 16：当前实施状态](docs/16-Cyrene-前端实施任务清单与进度跟踪.md)——当前阶段、阻塞项、最近验证和下一步。
- [doc 17：环境基线](docs/17-Cyrene-前端开发环境与依赖安装记录.md)——Windows/Linux 安装、启动与联调环境。
- [doc 19：开发环境隔离与资源登记](docs/19-Cyrene-前端开发环境隔离与资源登记.md)——开发端口段、应用身份、userData 与本地数据隔离，多项目并行开发规则。
- [doc 20：前端架构现状总览](docs/20-Cyrene-前端架构现状总览.md)——代码现状（as-built）：进程与信任边界、模块地图、启动与退出次序、关键数据流、契约面与门禁归属。
- [Review 与验收索引](docs/review/README.md)——按日期检索决策、整改、联调和验收证据。
- [Spec、Plan 与 Final Report 索引](docs/superpowers/README.md)——历史设计和实施计划。
- [UI 精修整改清单](docs/2026-08-29-UI精修整改清单.md)——阶段 8 前 UI/布局/风格改动的规则与限制。
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
| `pnpm start` | 以打包产物形态运行（`cyrene://`，发布形态验证） |
| `pnpm live2d:install` | 装配 Live2D 模型到 userData（首次启动后必做，见上） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint |
| `pnpm test` | 单元测试 |
| `pnpm test:integration` | Electron 集成测试（默认 **Silent Test Window Mode**：窗口不显示、不抢焦点、不进任务栏） |
| `pnpm test:integration:visible` | 同一个集成套件的**可视化调试模式**：Electron 窗口真的显示，便于人工观察窗口/焦点/任务栏行为 |
| `pnpm verify` | 一次跑完静态 + 单测 + 集成 + 构建（集成部分同为静默模式） |
| `pnpm package` | 生成当前平台的未分发目录产物 |
| `pnpm verify:artifact` | 检查产物内容与 Electron Fuses |
| `pnpm docs:check` | 检查核心文档元数据、索引和链接 |
| `pnpm docs:index` | 重新生成 review/superpowers 目录索引 |
| `pnpm -F @cyrene/desktop check:contract` | 后端契约在本机可用时执行跨仓检查 |
| `pnpm -F @cyrene/desktop verify:sensitive` | 扫描已跟踪文件中的敏感信息 |
| `pnpm test:e2e` / `pnpm make` | 阶段 8 前仍为防假绿占位命令，会以非零状态退出（`test:e2e` 的提示会指向 `pnpm test:integration`） |

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
