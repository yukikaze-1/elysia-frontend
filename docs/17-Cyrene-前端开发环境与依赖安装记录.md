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

- 二进制路径：`node_modules/electron/dist/electron`（下载内容记在 `node_modules/electron/path.txt` 指向的路径）。
- 真实版本看 `node_modules/electron/package.json` 的 `version`（当前 43.3.0）。
- **electron 43 起没有 postinstall**：包内 `package.json` 不再声明 scripts，二进制改为 **`require('electron')` 时懒下载**（`electron/index.js` 检测 `dist/` 缺失 → 调 `install.js`），`pnpm install` 不再自动拉取。显式触发：`pnpm --filter @cyrene/desktop ensure:electron`（= `node -e "require('electron')"`，Node 沿目录向上解析 electron 包，任何 node_modules 布局都成立；幂等，已装即秒退；CI 在 install 后固定执行 + `~/.cache/electron` 缓存，见 §10 P-12/P-14）。

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
| P-12 | CI `test:integration` 全部 launch Electron 用例 `spawn .../electron/dist/electron ENOENT`，本地却正常 | electron 43 无 postinstall，二进制懒下载；集成测试 helper 硬编码 `node_modules/electron/dist/electron` 路径不走 `require('electron')`，本地二进制/子包 symlink 是历史遗留，CI 全新环境缺失 | CI install 后显式 `pnpm --filter @cyrene/desktop ensure:electron`（`node -e "require('electron')"`，按 require 链定位到根 hoisted 区）+ `actions/cache` 缓存 `~/.cache/electron`；**helper 的 electronPath 也要用 `require.resolve('electron')` 定位**——硬编码 `join(ROOT,'node_modules/electron/dist/…')` 在干净布局下 `apps/desktop/node_modules` 整个不存在，ensure 成功也没用 |
| P-13 | 本地集成测试 `window.desktopApi` undefined，contextBridge 未暴露 | `sandbox: true` 的 preload 只能 require 有限模块；electron-vite `externalizeDepsPlugin` 把 `dependencies`（zod）外部化 → 产物 `require("zod")` 在沙箱抛错 → contextBridge 中断。2C 引入 chat schema 后首次暴露（集成测试当时未跑） | preload 构建 `externalizeDepsPlugin({ exclude: ['zod'] })`，让 zod bundle 进 preload 产物（`out/preload/index.js` 只应剩 `require("electron")`） |
| P-14 | CI `ensure:electron` 的 `node node_modules/electron/install.js` 报 `MODULE_NOT_FOUND`（`apps/desktop/node_modules/electron/install.js` 不存在） | pnpm **hoisted 干净 install 不创建 workspace 子包的 `node_modules`**（依赖全扁平在根 `node_modules`，子包目录无它）；本地 `apps/desktop/node_modules` 是历史残留，本地能跑是假象 | `ensure:electron` 改用 `node -e "require('electron')"`（Node 沿目录向上解析到根 `node_modules/electron`，任何布局都成立）；排查先 `node -e "console.log(require.resolve('electron'))"` |

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

- **默认只做静态检查**：out/ 三产物（main/preload/renderer index.html）存在、index.html 保留 CSP meta 且无 `unsafe-eval`（dev http 兜底，prod 由响应头 AND 收紧）、`.env`/`AGENT_ACCESS_TOKEN` 赋值/`Bearer ` 长 token 模式扫描（best-effort，非完整扫描器）、package.json version 可读；**阶段 7 批次 A 追加产物二进制 Fuses 读回断言**（三项 DISABLE，失败 exit 1——见 §17）；
- **`--smoke` 追加启动冒烟**（Playwright `_electron`）：优先启动未分发包（Linux→`dist/linux-unpacked/`，按 productName 候选名 `Cyrene`/`cyrene` 挑选真实二进制；win/darwin 同理），缺失回退 out/ 未打包直启；断言协议 `cyrene:`、`cyrene://` 响应头严格 CSP（`frame-src 'none'`/无 `unsafe-eval`/`unsafe-inline`）、Vue `#app` 挂载 + `.cy-app` grid 样式（防 CSP 拦样式假绿）、`getAppInfo`、普通浏览器 `desktopApi` undefined（信任边界）、打包调试门负路径（`--remote-debugging-port=9222` → failStart 退出）；Linux 需 `DISPLAY` 或 `WAYLAND_DISPLAY`，否则判失败不假绿；
- **冒烟 env**：`delete ELECTRON_RUN_AS_NODE/ELECTRON_ENABLE_LOGGING/ELECTRON_RENDERER_URL/NODE_OPTIONS`（残留 dev env 会把回退冒烟劫持到 http）+ `CYRENE_TEST_HARNESS=1`（调试门放行 `=0` 控制通道，见 P-10）；
- 无 `--smoke` 时输出 `（仅静态检查：未传 --smoke…）`；任一检查失败退出码 1。

## 14. 阶段 1 块 C 集成测试经验（2026-08-10 追加）

**运行方式：** `pnpm --filter @cyrene/desktop test:integration`（自动 `electron-vite build --mode test` + `vitest run --config vitest.integration.config.mts`；out/ 恒为 test 产物）。Linux 无显示器用 `xvfb-run -a`。

**经验教训：**
- **tsc 同名遮蔽**：目录内 `index.d.ts` 与 `index.ts` 同名时声明文件被静默丢弃——`src/preload/index.d.ts` 在 tsconfig.node 程序加载不到。集成测试用非冲突基名 `desktop-api.d.ts` 提供 `Window.desktopApi` 类型（与 preload 类型逐字段一致，node/web 程序各用各的）。
- **`net.fetch('cyrene://…')` 主进程可取自定义协议**（`supportFetchAPI` + `protocol.handle`），用于 F1 恶意请求实测；但**空 host `cyrene://` 在 URL loader 层抛 `Invalid URL`**（不进 handler）——用例需 try/catch 兼容。
- **`_electron.launch` userData 隔离**：`XDG_CONFIG_HOME`（Linux）/`APPDATA`（Windows）/`HOME`（macOS）env 重定向即可，零代码改动；本机启动 ~2.2s。
- **chromium 沙箱**：AppArmor userns 限制下 `chromium.launch` 需 `args: ['--no-sandbox']`（仅测试实例，不涉应用沙箱）；CI 用 `playwright install --with-deps chromium` 补系统库。
- **vitest 集成超时**：Electron 冷启动 8–20s，`testTimeout` 与 `hookTimeout` 都须 ≥60s（`hookTimeout` 管 beforeAll 里的 launchApp）；`fileParallelism: false` 防多 Electron 并发争抢。
- **`shell.openExternal` 可写**（Electron 43 主进程模块属性），monkeypatch 须返回 `Promise.resolve()`——`will-navigate` 分支对 `openExternal(url).catch(...)`。
- **`expect.poll` 优于固定 `waitForTimeout`**：openExternal 同步 push，poll 断言更稳。

## 15. 阶段 2 块 A 经验（2026-08-11 追加）

- **zod 4.4.3 单参 `z.record` 已废弃**：单参 `z.record(valueSchema)` 推断 `Record<number, unknown>`（TS2554/2322），必须双参 `z.record(keySchema, valueSchema)`。本块 schema（领域 + raw）全部 `z.record(z.string(), …)`。与既有记录互补：schema 断言仍用 `z.record(z.string(), z.number()…)` 形式。
- **SDD `task-brief` 对代码 fence 配对敏感**：plan 中 ` ``` ` 数量若为奇数（如 Task 4 实现块漏闭合 fence），awk 的 infence 状态错乱会导致后续任务 brief 提取把后续全部内容合并进来（Task 4 brief 曾含 Task 4-6 全部）。写 plan 后跑 `grep -c '^```' plan.md` 确认偶数是低成本保险。
- **主模型/沙箱分类器间歇不可用**：`claude-opus-4-8[1M] is temporarily unavailable` 会拦截 `Agent`/`Bash` 派发（只读 `Read` 不受影响）。表现是间歇性窗口：窗口内可连续执行多个工具调用，窗口外全部被拦。处置：窗口内批量推进（一次 Bash 合并多条命令）、窗口外做只读核验；换模型（`/model`）可触发分类器重新初始化。
- **`AssistantSegment.text?: string` 可选**：对 `s.text.length`/`s.text.includes` 断言需 `(s.text ?? '')` 收窄，否则严格 typecheck TS18048。

## 16. 阶段 2 CI 首次跑暴露的问题（2026-08-11 追加）

阶段 2 收尾后第一次 push 到 CI，`xvfb-run pnpm test:integration` 全红。根因是独立的（本地均正常，因二进制/布局为历史遗留 + 集成测试没在本地重跑），见 §10 P-12/P-13/P-14：

1. **electron 二进制缺失**：electron 43 无 postinstall，`pnpm install` 不拉二进制；集成测试 helper（`tests/integration/helpers/app.ts`）直接拼 `node_modules/electron/dist/electron` 路径给 `_electron.launch`，从不 `require('electron')`，懒下载永不触发 → CI ENOENT。修复：`ensure:electron` + CI 步骤。
2. **preload 沙箱 require zod 失败**：`sandbox: true` 下 preload 只能 require 有限模块；electron-vite 默认把 `dependencies`（zod）外部化 → 产物 `require("zod")` 运行时抛错，`contextBridge` 中断 → `window.desktopApi` undefined。修复：`externalizeDepsPlugin({ exclude: ['zod'] })`。
3. **ensure 脚本相对路径失效**：第一版 `ensure:electron` 用 `node node_modules/electron/install.js`，本地能跑但 CI 报 `MODULE_NOT_FOUND`——pnpm hoisted 干净 install 不创建 workspace 子包 `node_modules`（见 P-14）。修复：改用 `node -e "require('electron')"`。
4. **helper 硬编码 electron 子目录路径**：ensure 用对路径后（`require('electron')` 解析到根 hoisted 区并下载成功），launch 仍 ENOENT——测试 helper（`tests/integration/helpers/app.ts`）写死 `join(ROOT,'node_modules/electron/dist/electron')`，而干净布局下 `apps/desktop/node_modules` 整个不存在（根因 3 的同源问题，ensure 成功也不改变这一点）。修复：helper 用 `createRequire(import.meta.url).resolve('electron')` + `dirname` 定位包目录，再拼 `dist/<exe>`。

**CI 工作流拆分（同一批次）**：原单 job 顺序跑 typecheck→lint→install playwright→integration→unit，改为 3 个独立 job——`check`（typecheck+lint，纯 node）/ `unit`（vitest 单测）/ `integration`（electron+playwright+xvfb，含 `~/.cache/electron` 的 `actions/cache`，缓存 key 锚定 `pnpm-lock.yaml`）。失败各自定位、可并行，integration 不再阻塞静态检查。

**排查要点（可复用）**：
- 本地能跑 ≠ CI 能跑：`node_modules` 里的二进制/布局是累积态，全新环境才暴露"install 后缺什么"；
- **模拟 CI 布局验证**：`mv apps/desktop/node_modules node_modules.bak` 移除历史残留的子包目录后再跑集成测试，即复现 hoisted 干净布局——本地"全绿"与 CI 全绿的最后一层差异常在这里；
- `sandbox: true` 的 preload 产物应只剩 `require("electron")`——任何第三方 `require(...)` 都要检查是否被外部化；
- 用 `grep -o 'require("[^"]*")' out/preload/index.js` 快速核验 preload 外部化列表；
- 定位 electron 包不要用 `node_modules/<pkg>` 相对路径，先 `node -e "console.log(require.resolve('electron'))"` 看实际解析位置；测试 helper 同理。

## 17. 敏感信息扫描 verify:sensitive 与 Fuses 产物验证（2026-08-22 追加）

**`pnpm -F @cyrene/desktop verify:sensitive`**（阶段 7 批次 A，2026-08-22 起可用；node 入口、零额外依赖；根无 shim，与 `check:contract` 同款 `-F` 形式）= `node apps/desktop/scripts/verify-sensitive.mjs`：

- 扫描对象：`git ls-files` 全部跟踪文件（`out/`/`dist/`/`.playwright-mcp/` 未跟踪，天然不扫）；
- 黑名单 8 规则：Bearer token / JWT（二段 `{20,}`）/ `sk-` API key / `AKIA` AWS key / `AGENT_ACCESS_TOKEN=` / `ACCOUNT_TOKEN=` 赋值形态 / `-----BEGIN ... PRIVATE KEY-----` / **40+ 长 base64**（复用 redact RULES 四条第 4 条原文）；任意命中 exit 1；
- 排除目录：`third_party/`（CubismSdkForWeb-5-r.5——291 个跟踪文件含 228KB asm.js base64 必然误报且非本仓代码）+ `apps/desktop/src/renderer/public/live2d/` + `apps/desktop/src/renderer/src/live2d/framework/`（vendored live2d 两树，与 eslint.config.mjs 同款 vendor 忽略）；**扫描器自身三文件自排除**（`verify-sensitive.mjs`/`verify-sensitive-core.mjs`/`verify-sensitive.spec.ts`——黑名单字面量与触发器必然命中且非秘密；自排除为恒定盲区，任何变更须过 review，已注释）；
- 行级 allowlist：「路径 → 锚定段 → 理由（「已人工核对无真实秘密」）」三重 fail-loud——path 不在跟踪清单/落在排除段/锚定段零命中均报错（防行号漂移使 allowlist 静默失效）；类别级条目（规则 8 的 `base64-long-string` 文件级 40+ 长串放行）**限规则域**——仅豁免该规则，规则 1-7 不被通用条目弱化（MED-1 收口）；
- 实测基线（提交树）：黑名单 8 规则、574 扫 / 368 排除 / 1609 放行，exit 0；**纪律：改 allowlist/触发器后必须「git add 后复跑 exit 0 再 commit」**（Task 7 HIGH-1 教训——未提交时自扫描命中扫描器自身与单测触发器）；
- 注意：规则 1（`Bearer\s+…`）对散文「Bearer + 词」天然高误报（`+` 在字符类内）——新内容命中会 fail（fail-loud 是特性不是缺陷；精修新条目时务必核对真实内容）。

**Fuses 产物验证（verify:artifact 扩展，同批）：** `pnpm verify:artifact` 静态阶段对打包产物二进制执行 `getCurrentFuseWire` 读回——`RunAsNode`/`EnableNodeOptionsEnvironmentVariable`/`EnableNodeCliInspectArguments` 三项必须 = DISABLE（48 字节枚举），任何一项未关闭 exit 1（fail-closed）。配置在 electron-builder.yml `electronFuses`（pack 时由 electron-builder 26.15.3 内置 `@electron/fuses@^1.8.0` 翻转写 wire；读回脚本经 `await import('@electron/fuses')`（2.1.3，ESM-only——`require` 会 ERR_REQUIRE_ESM）——写/读双版本并存为已知且已实测兼容（V1 sentinel 同源）；`getCurrentFuseWire` 对不支持的二进制抛错 → 本检查直接 fail，不静默跳过。**`--smoke` 与 Fuses 的冲突（已知定案）**：Playwright `_electron.launch` 硬依赖 `--inspect=0` 的「Debugger listening on」行，三项关闭下直接启动 flipped 产物必挂→smoke 前先复制包含 `resources/` 的整目录临时副本并 `flipFuses` 三项回 true（产物本体保持 flipped，读回断言证明最终态）；**smoke 失败的原因若是点开负路径（flipExe 对 fused 产物触发 Playwright 崩溃）则属预期保护路径**（负路径的捕获型拒绝由应用层门——`rejectForbiddenDebugSwitches`——守，fuse 层证明由读回断言守）。

**mock 断线模拟 env 桥（阶段 7 批次 B，2026-08-25 追加）：** **`CYRENE_MOCK_DISCONNECT_AFTER_MS`**——Mock Backend 断线模拟 env，值 = 启动后 N 毫秒触发断线（`disconnectAfterMs` 选项；`parseMockDisconnectAfterMsEnv` 解析，经 **useMock 门控**传入 MockBackend——`useMock ? { disconnectAfterMs } : undefined`，real-backend 忽略）。配合 **error→connected 恢复**（断线后 mock 置 error → 再恢复 connected）建模「空闲断连 + 重连恢复」回归；供集成/单测（`mock-disconnect.spec.ts`）钉住「断线浏览历史/草稿断线自动保存/replay 恢复」语义，与 `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS`/`CYRENE_MOCK_EMIT_DELAY_MS`/`CYRENE_MOCK_DIRECTIVE` 同属 mock env 桥族（renderer 不直接读 env，经 getRuntimeInfo 水合；**Mock 驱动、已开发、未联调**）。

**mock 多分段种子 env 桥（阶段 7 批次 C，2026-08-26 追加）：** **`CYRENE_MOCK_MULTI_SEGMENT`**——Mock Backend 多分段回复种子 env，值 = 回复分段数 N（`multiSegmentCount` 选项；`parseMockMultiSegmentEnv` 解析——正整数→原值、0/负数/NaN/空串→undefined（不允许空 seed），经 **useMock 门控**传入 MockBackend——`useMock ? { multiSegmentCount } : undefined`，real-backend 忽略）。设置时 `MockBackend.generateMultiSegmentEvents` 生成含 N 个 `public_reply` 分段的回复（`segmentIndex` 0..N-1 有序、每段 `deltaSequence` 从 0 累计、`generation.completed` 居末；**取代而非追加**——替换夹具既有 seg-pr-1/seg-pr-2 段，防 renderer 标 completing 非 completed）。生成文本为可读确定性「模拟命中文本 N」（避 base64-long-string 黑名单）。配合 `CYRENE_MOCK_HISTORY_LARGE`（历史查看器 500 项/长会话 200 条）对靶「100 多分段回复/500 项/200 条」性能场景；回放耗时 `index * emitDelayMs`（测试用最小 `CYRENE_MOCK_EMIT_DELAY_MS` 控制，不拉长常驻门禁）。供集成/单测（`mock-multi-segment.spec.ts` + `perf-gate.spec.ts`）；与 `CYRENE_MOCK_REPLY_FIXTURE`（「正文覆盖」非「分段数」，语义不漂移）正交；**Mock 驱动、已开发、未联调**。
