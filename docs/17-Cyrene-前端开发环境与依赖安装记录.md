# Cyrene 前端开发环境与依赖安装记录

- 版本/状态：v0.1 · 记录日期 2026-08-08
- 适用范围：本地开发机（Linux x64）环境搭建、依赖排查；对应 main 分支"阶段 0 工程基线"之后的实际状态
- 性质说明：本文是开发机**实际操作记录**，不是设计契约。构建/打包、测试验收的设计口径仍以 [09](09-Cyrene-前端构建打包与发布设计-v0.2.md)、[08](08-Cyrene-前端测试与Demo验收方案-v0.2.md)、[12](12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md) 为准。

---

## 1. 环境基线（版本一览）

| 工具 | 版本 | 指定来源 |
|---|---|---|
| Node.js | 22.23.0 | [.nvmrc](../../.nvmrc)，`engines.node >= 22.0.0` |
| pnpm | 11.20.0 | 根 `package.json` 的 `packageManager`；CI 用 `pnpm/action-setup` 锁同一版本 |
| npm | 10.9.8 | Node 自带，仅备用，不用于本项目 |

工程主要依赖（`node_modules` 实测版本，与 `pnpm-lock.yaml` 一致）：

| 依赖 | 版本 | 用途 |
|---|---|---|
| electron | 43.3.0 | 桌面壳 |
| vue | 3.5.41 | 渲染层 |
| vite | 8.2.1 | 构建内核 |
| electron-vite | 5.0.0 | Electron 构建编排 |
| typescript | 5.9.3 | 类型 |
| vue-tsc | 3.0.0 | Vue 类型检查 |
| vitest | 4.1.10 | 单元/集成测试 |
| pinia | 4.0.2 | 状态管理 |
| zod | 4.4.3 | 运行时 schema 校验 |
| @vitejs/plugin-vue | 6.0.8 | Vue SFC 编译 |
| eslint / typescript-eslint / eslint-plugin-vue | 9 / 8 / 10 | 静态检查 |

> 版本锁定的唯一权威位置是仓库内的 `package.json` / `pnpm-lock.yaml`，不在文档里写死。

---

## 2. 依赖安装流程

前置：Node ≥ 22（按 `.nvmrc`），pnpm 11 可用（corepack 或独立安装）。

```bash
# 1. 仓库根执行，按 workspace 布局一次性装全部子包
pnpm install

# 2. electron 的 postinstall 会下载对应平台二进制
#    （见 §4 验证）

# 3. 验证安装完整性
pnpm typecheck   # typecheck:node + typecheck:web
pnpm lint
pnpm test
```

CI 中（`.github/workflows/ci.yml`）等价安装命令为 `pnpm install --frozen-lockfile`，并复用 `actions/setup-node@v4` 的 pnpm 缓存。

---

## 3. pnpm 11 关键配置（`pnpm-workspace.yaml`）

仓库根 `pnpm-workspace.yaml` 承载 pnpm 11 的**全部非认证设置**：

```yaml
packages:
  - 'apps/*'

allowBuilds:
  electron: true
  esbuild: true
  vue-demi: true

nodeLinker: hoisted
engineStrict: true
```

- `allowBuilds`：pnpm 11 控制依赖构建脚本白名单（v10 的 `onlyBuiltDependencies` 已在 v11 移除，迁移时 allow 列表对应 `true`）。Electron 需 postinstall 下载二进制，esbuild / vue-demi 需构建脚本，必须显式放行，否则 `electron` 装完没有可执行二进制。
- `nodeLinker: hoisted`：Electron Forge / 原生模块在 pnpm 默认严格布局下易出问题，使用扁平布局。
- `engineStrict: true`：严格校验 Node 版本，与 `.nvmrc` 一致。

**坑（P-1）**：这些设置写在 `.npmrc` 会被 pnpm 11 静默忽略，必须放 `pnpm-workspace.yaml`（`.npmrc` 内目前只留了注释说明，见后文 §10）。

---

## 4. Electron 二进制

- 二进制路径：`node_modules/electron/dist/electron`（由 postinstall 下载，下载内容记在 `node_modules/electron/path.txt` 指向的路径）。
- 真实版本看 `node_modules/electron/package.json` 的 `version`（当前 43.3.0）。

**坑（P-2）**：在本仓库的开发沙箱里，shell 被注入了 `ELECTRON_RUN_AS_NODE=1`（执行 `env | grep ELECTRON` 可见）。此时直接运行 `electron --version` 得到的是其**内置 Node 版本**（如 v24.18.1），不是 Electron 版本——Electron 在 `ELECTRON_RUN_AS_NODE` 模式下以纯 Node 身份运行。判断 Electron 是否装好，请用 `node_modules/electron/package.json` 的 version 字段，或用不注入该变量的干净终端跑 `electron --version`。

---

## 5. Playwright 与 Chromium

现状：Playwright CLI **1.62.1** 可用，但**尚未声明为项目 devDependency**（阶段 0 只铺了 vitest，E2E 留待阶段 3 正式配置；`apps/desktop` 的 `test:e2e` 目前是占位脚本）。浏览器二进制已下载在用户级缓存：

```
~/.cache/ms-playwright/
├── chromium-1228/                 # Chrome for Testing 149.0.7827.55
├── chromium_headless_shell-1228/  # headless shell
└── ffmpeg-1011/
```

- 每个目录内应有空标记文件 `INSTALLATION_COMPLETE` 与 `DEPENDENCIES_VALIDATED`，二者都在 = 下载完整。
- **revision（目录名 1228）必须与 Playwright 版本匹配**——不同版本号要求不同 revision；版本不符时启动浏览器会报 "Executable doesn't exist"。
- 未装全时的补救命令：

```bash
npx playwright install chromium          # 只装 chromium 系（含 headless shell）
npx playwright install-deps chromium     # 补系统依赖（需 sudo，Ubuntu 常见缺 libnss3 等）
```

**坑（P-5）**：只要 `~/.cache/ms-playwright/` 存在且带完成标记，就是装好了，不必重复 `install`。项目脚手架落地前，Playwright 靠 `npx` 临时解析（不在项目依赖里）；阶段 3 接入 E2E 时应把它正式加进 devDependencies，再确认 `npx playwright --version` 指向项目本地实例。

---

## 6. Playwright MCP（IDE 内浏览器自动化）

`plugin-playwright` 提供 `browser_navigate` / `browser_take_screenshot` / `browser_resize` 等工具。

- **输出目录限制（P-3）**：截图等产物只能写到**项目根**或 `项目根/.playwright-mcp/`，传绝对路径（如 `/tmp/xxx.png`）会被拒：`File access denied ... outside allowed roots`。
- `.playwright-mcp/` 已加入 `.gitignore`，产物不入库。
- 典型工作流：

```
1. 本地起静态服务器（§8）或 dev server
2. browser_navigate → http://127.0.0.1:<port>/...
3. 可选 browser_resize 到目标视口（如 ~1200px 文档窗口基准）
4. browser_take_screenshot filename=.playwright-mcp/xxx.png
5. 交给视觉 MCP（§7）分析或对比
```

---

## 7. 视觉 MCP（mimo-vision，MiMo-V2.5）

提供两个工具，均已在本机验证可用：

| 工具 | 用途 |
|---|---|
| `analyze_image` | 读一张本地截图，返回视觉分析（布局 / 元素 / 配色 / 文字） |
| `compare_images` | 对比两张截图（改前 / 改后、实现 vs 参考），列出差异 |

用途：UI 阶段用截图 + 视觉分析做低成本回归，替代一部分人工目检；`compare_images` 适合做"实现 vs 原型参考"的对照。

---

## 8. 本地静态预览服务器

`ref/` 下的静态原型（如 `cyrene-ui-preview-v5.html`）用 Python 内置服务器即可：

```bash
cd /home/yomu/elysia-frontend/ref
python3 -m http.server 8899 --bind 127.0.0.1
# 浏览器/Playwright 访问 http://127.0.0.1:8899/cyrene-ui-preview-v5.html
```

- 只绑 `127.0.0.1`，不暴露到局域网。
- 用完停掉：直接查 pid 再 kill。

**坑（P-4）**：`pkill -f "http.server 8899"` 会**匹配到包含同样字符串的自身 shell 命令行**，把发起命令的 shell 一起杀掉（退出码 144），场面混乱。改用精确查 pid：

```bash
ss -tlnp | grep 8899        # 找到 pid
kill <pid>                  # 精确终止
```

---

## 9. 快速验证清单

新环境/换机后按序自检：

```bash
node -v                        # 期望 22.x（.nvmrc）
pnpm -v                        # 期望 11.20.0
pnpm typecheck                 # 类型检查全绿
pnpm lint                      # eslint 0 warning
pnpm test                      # vitest 单元测试
npx playwright --version       # 期望 1.62.x
ls ~/.cache/ms-playwright/*/INSTALLATION_COMPLETE   # 浏览器装全
# 浏览器端到端冒烟（Playwright MCP）：起 §8 服务器 → navigate → screenshot → analyze_image
```

---

## 10. 踩坑汇总

| # | 现象 | 根因 | 规避 |
|---|---|---|---|
| P-1 | pnpm 11 设置写在 `.npmrc` 不生效 | v11 把非认证设置迁移到 `pnpm-workspace.yaml`，`.npmrc` 静默忽略 | 设置放 workspace yaml；`.npmrc` 只留注释指引 |
| P-2 | `electron --version` 显示 v24.18.1 | 沙箱注入 `ELECTRON_RUN_AS_NODE=1`，electron 以 Node 模式运行，输出内置 Node 版本 | 真实版本看 `node_modules/electron/package.json`；干净终端再验证 |
| P-3 | Playwright MCP 截图写 `/tmp` 报 `File access denied` | 输出根限制在项目目录与 `.playwright-mcp/` | 用相对路径 `.playwright-mcp/xxx.png` |
| P-4 | `pkill -f "http.server 8899"` 退出码 144、shell 被杀 | `-f` 全命令行匹配到了自身 | `ss -tlnp \| grep 8899` 找 pid 再 `kill` |
| P-5 | 误以为 Chromium 没装 | 浏览器在 `~/.cache/ms-playwright/` 已有且带完成标记 | 查 `INSTALLATION_COMPLETE` / `DEPENDENCIES_VALIDATED`；revision 与 Playwright 版本需匹配 |
| P-6 | 本环境 `git push` 失败 | HTTPS remote，环境无 GitHub 凭据 | 本地提交，用户在 VS Code 终端手动 push |
| P-7 | `xwd`/ffmpeg x11grab 抓屏全黑，找不到 Electron 窗口 | Electron 跑在 **Wayland**（GPU 进程 `--ozone-platform=wayland`），窗口在合成器下不在 X11 | 用 Playwright `_electron` 截图；或 `WINIT_UNIX_BACKEND=x11`/`--ozone-platform=x11` 强制 X11 |
| P-8 | `pnpm dev -- -- --remote-debugging-port=9222` 端口不监听 | 参数经 pnpm→electron-vite→electron 多层转发丢失，未成为 Chromium switch | 用 Playwright `_electron.launch`（内部处理 CDP）；E2E 阶段 3 再正式接线 |
| P-9 | `pnpm package` 首次运行 electron-builder 需联网拉取 app-builder-bin/fuses | `--dir` 打包依赖在线解析构建器 | 首次打包前确认网络；本地受阻时退化为 `pnpm build` 只出 `out/`（不产未分发包），阶段 8 正式配置再处理 |
| P-10 | 打包冒烟启动需 Playwright 注入 `--remote-debugging-port=0`/`--inspect=0` 控制通道，但生产默认拒绝 | 调试门连 `=0` 也拒（doc 07「任何构建都不得开放远程调试端口」）；Playwright `_electron` 用随机端口 CDP | 冒烟脚本显式设 `CYRENE_TEST_HARNESS=1` 放行 `=0`；不带该标记启动打包产物会被调试门 failStart 退出 |
| P-11 | `verify:artifact` 冒烟在无显示环境直接判失败 | `--smoke` 需 Linux `DISPLAY` 或 `WAYLAND_DISPLAY`，否则无法启动 Electron 窗口 | 桌面会话/`xvfb-run` 下执行；无显示时脚本明确 `fail`，不会假绿 |

---

## 11. 环境备注

- **CI**：`.github/workflows/ci.yml` 在 push/PR 时跑 `pnpm install --frozen-lockfile` → typecheck → lint → test（当前不跑 E2E，阶段 3 补充）。
- **版本一致性**：Node 版本由 `.nvmrc` 统一（本地 + `actions/setup-node` 的 `node-version-file`）；pnpm 版本由 `packageManager` + `pnpm/action-setup` 双保险。
- **README** 根目录有当前工程说明；本文与之配套，README 变更时同步检查 §1 版本表。

---

## 12. Electron GUI 冒烟（Playwright `_electron` + vision MCP）

2026-08-09 首次自动化冒烟成功，方法可复用（对应 doc 16 阶段 1 验收门槛「Ubuntu 启动一次」）。

**流程：**

```bash
# 1. 构建产物（冒烟对象 = out/）
cd /home/yomu/elysia-frontend/apps/desktop && pnpm build

# 2. 跑冒烟脚本（已存在 .playwright-mcp/smoke-electron.cjs，gitignored）
cd /home/yomu/elysia-frontend && DISPLAY=:0 node .playwright-mcp/smoke-electron.cjs
# → SMOKE_RESULT {"appInfo":{"name":"Cyrene","version":"0.1.0","platform":"linux"},"title":"Cyrene"}
# → 写 .playwright-mcp/cyrene-electron-built.png
```

**脚本要点（`smoke-electron.cjs`）：**

- `_electron.launch` 需显式 `executablePath`（`node_modules/.pnpm/electron@43.../dist/electron`）+ **`args: [cwd]`（应用目录）而非 `out/main/index.js`**——传文件会让 `app.getVersion()` 找不到 package.json 回退 `0.0`；
- 必须 `delete env.ELECTRON_RUN_AS_NODE`（沙箱注入，P-2）；
- playwright 从 npx 缓存 require（`~/.npm/_npx/*/node_modules/playwright`），不是项目依赖；
- `firstWindow` → `waitForFunction(window.desktopApi)` → `evaluate(getAppInfo)`。

**验证项：** 主进程无错启动、`~/.config/Cyrene` 七目录 0700、`getAppInfo` 真实 IPC 往返、窗口标题、UI 渲染（截图 + vision MCP `analyze_image` 确认四栏布局/流式演示/Live2D 占位）、普通浏览器 `desktopApi` undefined（信任边界）。

---

## 13. 产物检查 verify:artifact（2026-08-09 起可用）

`pnpm verify:artifact` = `node apps/desktop/scripts/verify-artifact.cjs`（根 package 转发到子包；阶段 1 块 A 落地，对应 doc 16 §4 任务 ④ 与 doc 09 §5 命令语义）。

- **默认只做静态检查**：out/ 三产物（main/preload/renderer index.html）存在、index.html 保留 CSP meta 且无 `unsafe-eval`（dev http 兜底，prod 由响应头 AND 收紧）、`.env`/`AGENT_ACCESS_TOKEN` 赋值/`Bearer ` 长 token 模式扫描（best-effort，非完整扫描器）、package.json version 可读；
- **`--smoke` 追加启动冒烟**（Playwright `_electron`）：优先启动未分发包（Linux→`dist/linux-unpacked/`，按 productName 候选名 `Cyrene`/`cyrene` 挑选真实二进制；win/darwin 同理），缺失回退 out/ 未打包直启；断言协议 `cyrene:`、`cyrene://` 响应头严格 CSP（`frame-src 'none'`/无 `unsafe-eval`/`unsafe-inline`）、Vue `#app` 挂载 + `.cy-app` grid 样式（防 CSP 拦样式假绿）、`getAppInfo`、普通浏览器 `desktopApi` undefined（信任边界）、打包调试门负路径（`--remote-debugging-port=9222` → failStart 退出）；Linux 需 `DISPLAY` 或 `WAYLAND_DISPLAY`，否则判失败不假绿；
- **冒烟 env**：`delete ELECTRON_RUN_AS_NODE/ELECTRON_ENABLE_LOGGING/ELECTRON_RENDERER_URL/NODE_OPTIONS`（残留 dev env 会把回退冒烟劫持到 http）+ `CYRENE_TEST_HARNESS=1`（调试门放行 `=0` 控制通道，见 P-10）；
- 无 `--smoke` 时输出 `（仅静态检查：未传 --smoke…）`；任一检查失败退出码 1。
