# Cyrene 前端开发环境与依赖安装记录

**文档状态：** 维护中
**最后核验：** 2026-08-29
**适用阶段：** 全阶段开发与联调；阶段 8 发布基线尚未建立
**权威范围：** Windows/Linux 本地环境、依赖安装、前端启动、真实后端连接和机器能力检查

---

## 1. 基线与边界

当前主要开发和真实 Electron 联调环境是 Windows x64；Ubuntu/Linux 同时作为开发、CI 和后端运行环境。阶段 8 尚未进入，因此本文不承诺最终安装包支持的最低操作系统版本。

版本以仓库文件为单一来源：

| 项 | 当前锁定值 | 来源 |
|---|---|---|
| Node.js | 22.23.0，且只接受 22.x 范围 | [`.nvmrc`](../.nvmrc)、根 [`package.json`](../package.json) |
| pnpm | 11.20.0 | 根 [`package.json`](../package.json) |
| Electron | 43.3.0 | [desktop package.json](../apps/desktop/package.json) |
| Vue | 3.5.x | [desktop package.json](../apps/desktop/package.json) |
| Playwright | 1.62.x | [desktop package.json](../apps/desktop/package.json) |

不要把某台机器当前安装的 Node、pnpm、GitHub 凭据或 MCP 连接状态写成项目基线。

## 2. Windows 环境搭建

以下命令在 PowerShell 中执行。若机器尚未安装 fnm，先按团队认可的方式安装 fnm，并重新打开终端。

```powershell
fnm install 22.23.0
fnm use 22.23.0
node --version

npm install -g pnpm@11.20.0
pnpm --version

pnpm install --frozen-lockfile
pnpm check:node
```

期望：

- `node --version` 为 `v22.23.0`；
- `pnpm --version` 为 `11.20.0`；
- `pnpm check:node` 以 0 退出；
- 不使用系统中可能残留的 Node 24 或其他主版本运行工程。

启动前端：

```powershell
fnm use 22.23.0
pnpm dev
```

等价的 workspace 直启方式：

```powershell
pnpm -F @cyrene/desktop exec electron-vite dev
```

正常开发和人工联调不要传固定远程调试端口。安全门会拒绝 `--remote-debugging-port=9223`、`--remoteDebuggingPort 9223` 等固定端口。需要自动化时使用现有 Playwright Electron harness；测试专用放行只允许项目定义的随机端口或 pipe 语义。

## 3. Linux 环境搭建

仓库命令在 PowerShell 与 POSIX shell 中保持一致：

```bash
fnm install 22.23.0
fnm use 22.23.0
npm install -g pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm check:node
pnpm dev
```

Electron 所需系统库因发行版而异，不在仓库文档中复制一份易失效的 `apt` 清单。CI 的 [integration job](../.github/workflows/ci.yml) 使用 Playwright `install --with-deps chromium` 和 `xvfb-run`，是当前 Linux 无头验证参考。

## 3.1 Live2D 模型装配（首次启动后必做）

**模型不随仓库分发。** 仓库只含 Cubism 运行时与 shader（`apps/desktop/src/renderer/public/live2d/`，14 个 tracked 文件），模型本身因授权原因不纳入版本控制（`EXT-01`，见 [doc 16 §4.1](16-Cyrene-前端实施任务清单与进度跟踪.md)）。

因此**全新环境首次启动时，角色面板会显示「模型不可用」——这是预期现象，不是故障**。装配自有模型：

```powershell
pnpm live2d:install --model-dir <模型目录> --id <slug> --display-name "<显示名>"
```

参数与约束：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--model-dir` | 是 | 原始模型目录。须含 `model3.json`、`.moc3`、至少一张贴图 |
| `--id` | 是 | 安装目录名，须匹配 `^[A-Za-z0-9._-]+$` 且非 `.` / `..` |
| `--display-name` | 是 | 界面显示名 |
| `--license-note` | 否 | 注入为 `LICENSE.txt` 的许可说明文件 |
| `--force` | 否 | 覆盖已存在的同 id 安装 |

脚本做的事（`apps/desktop/scripts/live2d-install.mjs`）：校验模型结构 → 非 symlink 拷贝 → 注入 `LICENSE.txt` → 生成 `preview.png`（源目录有 `icon.png` 时）→ 写 `manifest.json` → 计算 `integrity.json`（逐文件 SHA-256）→ 输出文件数与哈希数报告。

安装位置为 userData 下的 `models/`：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\Cyrene\models\<id>\` |
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/Cyrene/models/<id>/` |
| macOS | `~/Library/Application Support/Cyrene/models/<id>/` |

> **路径口径以本表为准**：[doc 05 §4](05-Cyrene-Live2D前端接入设计-v0.2.md) 里写的 `assets/live2d/<model-id>/` 是早期设计的目录示意，**实际运行时读取的是上表的 userData `models/`**，且模型目录必须由本脚本生成（含 `manifest.json` + `integrity.json`），手工摆放的目录会因缺 manifest 或完整性清单不匹配而被注册表跳过或在列表中标记 `available=false`。

授权红线：只装配来源与授权明确的模型。`EXT-01` 未解除前，不得把任何模型纳入仓库或对外分发。

## 4. Real 与 Mock 启动

未打包开发态默认 Real，打包产物恒为 Real。只有显式设置 `CYRENE_BACKEND=mock` 才进入 Mock。

PowerShell：

```powershell
# Real
Remove-Item Env:CYRENE_BACKEND -ErrorAction SilentlyContinue
pnpm dev

# Mock
$env:CYRENE_BACKEND = 'mock'
pnpm dev
Remove-Item Env:CYRENE_BACKEND
```

POSIX shell：

```bash
# Real
unset CYRENE_BACKEND
pnpm dev

# Mock
CYRENE_BACKEND=mock pnpm dev
```

Real 模式启动后，在连接面板设置 Endpoint 和 Token，再发起连接。Token 与 Endpoint origin 绑定；修改 origin 会清除旧 Token。

### 4.1 打包产物运行（发布形态验证）

`pnpm dev` 的 Renderer 由 Vite dev server 供给（`http://localhost:<port>`），打包产物加载 `cyrene://renderer/index.html`。

两种形态下 Live2D 模型文件都只在 `cyrene://renderer/__cyrene-live2d/{modelId}/{relPath}` 上供给，但**传输方式按是否同源分支**（2026-09-10 修复，见 `docs/review/2026-09-10-dev形态Live2D资源跨源失败修复-决策记录.md`）：

| 形态 | 页面 origin | 模型文件传输 |
|---|---|---|
| `pnpm dev` | `http://localhost:<port>` | IPC `live2d:read-model-file` |
| `pnpm build` + `pnpm start`（或产物直启） | `cyrene://renderer` | 原生 `fetch`（同源） |

原因是 `cyrene` scheme 恒注册为 `corsEnabled:false`（阶段 5 D-4 安全结论：放开后非受信 origin 也能读 `cyrene://` 资源）。dev 页面与 `cyrene://` 跨源，原生 `fetch` 会被 Chromium 直接拒绝并抛 `TypeError: Failed to fetch`；而模型清单走 invoke 通道不受影响，于是界面会**同时**显示「模型加载失败 / 原因：Failed to fetch」和「已发现 N 个模型，其中可用 N 个」——这两句并不矛盾，是同一原因的两面。dev 形态因此改由 Main 经 IPC 回字节，闸门与协议通道共用 `src/main/live2d/serve-gate.ts`，不放开 `corsEnabled`。

所以**两种形态都能跑 Live2D**。本节仍值得单独跑，因为它验证的是与发布形态一致的行为：自定义协议供给、产物 CSP、打包后资源解析：

```powershell
pnpm build
pnpm start
```

`electron-vite preview` 加载 `cyrene://renderer/index.html`。产物直启的等价方式：`cd apps\desktop` 后运行 `..\..\node_modules\electron\dist\electron.exe .`。

自动化调试需要 CDP 时使用项目测试 harness，或显式传 `--remote-debugging-port=0`（随机端口；固定端口仍被安全门拒绝），实际端口从 `%APPDATA%\Cyrene\DevToolsActivePort` 读取。

## 5. 团队当前真实后端环境

> 这是带核验日期的团队联调记录，不是通用产品配置。

| 项 | 记录 |
|---|---|
| SSH 主机 | `192.168.1.18` |
| 后端仓库 | `~/elysia-agent` |
| 操作边界 | 后端由联调操作者手动启动、停止；前端任务默认不远程管理后端进程 |
| 连接方式 | 前端连接面板填写实际 Endpoint 与 Token；需要隧道时由操作者建立 SSH 端口转发 |
| 证据要求 | 每次真实联调记录后端 SHA、版本、前端 SHA、平台、Endpoint 形态和验收结果 |

只读检查后端仓库时可使用：

```powershell
ssh 192.168.1.18
```

进入远端后再切换到 `~/elysia-agent`。不要把 Token、私钥或其他凭据写入命令示例、文档或提交记录。

若需要本地转发，使用实际后端端口替换占位符：

```powershell
ssh -L <本地端口>:127.0.0.1:<后端端口> 192.168.1.18
```

## 6. 安装与运行验证

文档修改：

```powershell
pnpm docs:check
```

常规代码批次：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

按任务范围追加：

```powershell
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop verify:sensitive
pnpm package
pnpm verify:artifact
```

`test:e2e` 与 `make` 仍是阶段 8 前的非零占位命令，不应加入“全绿”命令链。

## 7. 常见问题

### 一键脚本（Windows）

上面 §2 的步骤可交给 `scripts\setup-windows.ps1`（检查 Node/pnpm 版本 → 按需安装依赖 → 可选启动）。脚本刻意**不**代装 fnm/Node/pnpm——那些会改系统 PATH 或全局包，静默代劳会让新用户不知道机器被改过什么；脚本只把「装什么、装哪个版本」讲清楚并在失败时给出下一步命令。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1        # 检查 + 装依赖
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Run   # 再启动 pnpm dev
```

### 角色面板显示「模型不可用」

**预期现象**：Live2D 模型不随仓库分发，未装配前必然如此。按 §3.1 用 `pnpm live2d:install` 装配模型。这不是故障，也无需改代码。

### `pnpm start` 报 `ERR_PNPM_NO_SCRIPT_OR_SERVER`

根目录缺少 `start` 别名所致，已在 `package.json` 补上。请更新到最新 `main`；临时可用 `pnpm -F @cyrene/desktop start`。

### Node 版本错误

症状：`predev` / `prebuild` / `pretest` 拒绝启动，或 `pnpm check:node` 非零退出。

处理：

```powershell
fnm use 22.23.0
pnpm check:node
```

注意 fnm 是 **per-shell** 的：每开一个新终端都要重新 `fnm use`。若 `fnm use` 后版本仍不对，检查 PATH 里是否有另一个 Node 抢先。

### 首次 `pnpm install` 很慢

正常：需要下载 Electron 二进制（约 215MB）。不是卡住。CI 会缓存该下载目录，本机不应把下载产物提交进仓库。

### Electron 二进制缺失

```powershell
pnpm -F @cyrene/desktop ensure:electron
```

随后重跑原命令。

### Real 模式无法连接

依次确认：

1. 后端进程由操作者启动并可达；
2. SSH 隧道仍存活；
3. Endpoint 的协议、host、端口和 path 正确；
4. Token 与当前 Endpoint origin 匹配；
5. 后端 SHA 与前端契约基线一致；
6. 使用 `check:contract` 或真实 raw frame 定位契约漂移。

### 自动化工具不可用

浏览器、视觉分析、MCP 和 GitHub 登录都是当前会话能力，不属于仓库保证。开始任务时按实际情况检测：

```powershell
gh auth status
```

视觉工具不可用时使用 Playwright 截图、DOM 断言和人工验收记录，不要在文档中声称某个命名 MCP 已连接。

## 8. 历史环境记录

治理前的 Linux 单机安装、Playwright/MCP 操作和阶段性踩坑记录已完整归档：

- [doc 17 环境记录历史归档](review/2026-08-29-doc17环境记录历史归档.md)

该归档只用于追溯，不再作为安装指导或当前工具可用性声明。
