# Cyrene 前端仓库

Cyrene —— Electron 桌面 AI 助手客户端(Windows + Ubuntu)的前端工程。包含 Live2D 角色、流式 AI 回复、语音输入,以及桌面工具/授权系统。

> **当前状态:设计文档阶段(v0.2)。** 本仓库目前只有 `docs/` 设计文档与 `ref/` 的 UI 原型,**还没有应用代码**(无 `package.json`)。搭建工程脚手架属于实施阶段 0 的工作。

## 文档入口

- **[docs/00-Cyrene-前端文档索引与阅读顺序.md](docs/00-Cyrene-前端文档索引与阅读顺序.md)** —— 一切从这里开始,含按角色的阅读路线与文档优先级
- 核心文档:`01` 总体架构 / `02` 前后端通信协议 / `07` 安全设计 / `12` 启动清单与分阶段计划 / `13` 交叉 Review 统一口径
- **`ref/cyrene-ui-preview-v5.html`** —— UI 原型(静态稿,含完整设计变量 token,是 Vue 界面的直接参考)

## 技术栈(已定案,版本锁定见下)

Electron + Vue 3 + TypeScript + Vite · Electron Forge · **pnpm** · Vitest · Playwright

## 环境信息

| 项 | 值 |
|---|---|
| 系统 | Ubuntu 22.04.5 LTS x86_64 |
| Node 版本管理器 | **fnm 1.39.0**(钩子已写入 `~/.bashrc`,路径 `~/.local/share/fnm`) |
| Node.js | **v22.23.0**(经 fnm 管理,`.nvmrc` 固定) |
| pnpm | **11.20.0**(全局,`~/.local/bin/pnpm`) |
| npm | 10.9.8(Node 自带) |
| Electron 系统依赖(libnss3 / libatk / libgtk-3 / libasound) | 均已存在 |

### 环境搭建(新机器/新环境)

```bash
# 1. 安装 fnm(Node 版本管理,装完重开终端或 source ~/.bashrc)
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc

# 2. 按仓库固定版本安装 Node(自动读取 .nvmrc)
fnm install && fnm default 22.23.0

# 3. 安装 pnpm
npm install -g pnpm
```

### 版本固定机制

- `.nvmrc` —— 固定 Node 版本,`fnm install` 自动读取
- `.npmrc` —— `node-linker=hoisted`(保证 Electron Forge 与原生模块兼容)、`engine-strict=true`
- 依赖锁文件 —— `pnpm-lock.yaml` 必须提交进仓库(工程初始化后生成)
- Node 版本以 **22 系 LTS** 为准;升级需同步更新 `.nvmrc`、`.npmrc` 校验与 CI

## 目录结构

```text
docs/                设计文档(18 份,中文,工程契约)
ref/                 UI 原型与预览图
apps/desktop/        (规划中)Electron 工程 —— main / preload / renderer / shared
tests/               (规划中)unit / integration / e2e
```

`apps/desktop/` 下的推荐目录结构见 [docs/01 §5](docs/01-Cyrene-Electron-前端总体架构设计-v0.2.md)。

## 开发命令

> 命令语义由 [docs/09 §5](docs/09-Cyrene-前端构建打包与发布设计-v0.2.md) 定义;**工程尚未初始化,以下脚本尚不存在**,待阶段 0 脚手架落地。

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动开发环境(Electron + Vite) |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 静态检查 |
| `pnpm test` | 单元测试(Vitest) |
| `pnpm test:integration` | 集成测试 |
| `pnpm test:e2e` | 端到端测试(Playwright) |
| `pnpm package` / `pnpm make` | 打包 / 生成安装产物 |
| `pnpm verify:artifact` | 校验产物内容与安全配置 |

## 协作约定

- **Git push 由开发者手动执行。** 本环境(Claude 沙箱)无 GitHub 凭据,HTTPS 推送会失败;在 VS Code 集成终端里推送可复用 VS Code 的 GitHub 登录,免输入凭据。
- 文档修改保持**中文**,与 `docs/` 一致。
- 文档冲突时的优先级见 [docs/00 §5](docs/00-Cyrene-前端文档索引与阅读顺序.md)。

## 当前状态与下一步

- 设计文档 v0.2(2026-08-04 交叉 Review 完成),尚未达到"开工"基线
- 待外部输入:真实后端测试环境与认证、完整流式回复事件样例、协议对齐表(见 [docs/12](docs/12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md) 的 P0 清单)
- **下一步:阶段 0** —— 在 `apps/desktop/` 初始化工程、移植原型 UI、建立 `BackendAdapter` 骨架与 Mock Backend、搭建类型检查与测试命令
