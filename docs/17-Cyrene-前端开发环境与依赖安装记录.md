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

### Node 版本错误

症状：`engineStrict`、predev 或 pretest 拒绝启动。

处理：

```powershell
fnm use 22.23.0
pnpm check:node
```

### Electron 二进制缺失

```powershell
pnpm -F @cyrene/desktop ensure:electron
```

随后重跑原命令。CI 会缓存 Electron 下载目录，本机不应把下载产物提交进仓库。

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
