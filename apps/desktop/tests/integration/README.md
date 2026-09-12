# 集成测试（Playwright `_electron`）

覆盖 Main 侧安全关键路径的真实 Electron 行为：协议 handler（F1）403/404/逃逸/200+CSP、IPC API 面/非法参数/超大输入/来源校验、外部链接受控、普通浏览器信任边界。与单元测试（`vitest run`）不同，这里用 Playwright 启动**真实 Electron 进程**，验证的是构建产物 + preload + IPC 的端到端边界。

## 运行方式

```bash
# 仓库根：一次跑全套（自动 electron-vite build --mode test + vitest run）
pnpm --filter @cyrene/desktop test:integration

# 或 cd apps/desktop 后
pnpm test:integration

# 可视化调试模式：同一个套件，但 Electron 窗口真的显示（人工观察窗口/焦点/任务栏行为）
pnpm test:integration:visible
```

`test:integration` 脚本 = `electron-vite build --mode test`（产出 `apps/desktop/out/` 测试构建）+ `vitest run --config vitest.integration.config.mts`（`tests/integration/**/*.spec.ts`）。集成配置 `testTimeout`/`hookTimeout` 60s（Electron 冷启动 8–20s）、`fileParallelism: false`。

## Silent Test Window Mode（默认）

自动化运行**不得干扰宿主桌面**：套件默认以静默窗口模式启动 Electron（窗口不显示、不抢焦点、
不置顶、不进任务栏、不弹原生对话框与通知），而 renderer / preload / IPC / 持久化 / Playwright
自动化能力与可见运行时逐字一致。判据、边界模块与实测数据见
[决策记录](../../../../docs/review/2026-09-12-测试静默窗口模式-决策记录.md)：

- `launchApp(..., { windowMode })` 可单次指定；缺省取套件 env（`test:integration:visible` 经
  `vitest.integration.config.visible.mts` 注入 `CYRENE_WINDOW_MODE=visible`），再缺省为 `silent`；
- 窗口行为本身由 `silent-window-mode.spec.ts` 断言（不可见/未聚焦/未置顶/窗口数 1/隐藏窗口下
  `document.hidden === false`、rAF 未被压到后台档、键盘输入与 DOM 焦点正常）；
- 新增越过统一边界的建窗或呈现调用会被单测门禁 `tests/unit/window-presentation-guard.spec.ts` 拦下。

## 平台差异

| 平台 | userData 隔离 | 说明 |
|---|---|---|
| Windows | `CYRENE_TEST_APP_DATA` → Main 显式 `app.setPath('appData')` | Electron 43 不保证 `APPDATA` env 改写 Known Folder；test+harness+未打包三重门，启动后再读回 appData/userData |
| Linux / macOS | `CYRENE_TEST_APP_DATA` → Main 显式 `app.setPath('appData')` | 与 Windows 共用同一权威隔离路径；平台环境变量只留给独立 CLI 测试，不作为 Electron 安全边界 |
| **CI** | 仅 Linux | `xvfb-run -a pnpm test:integration` |

`launchApp()` 恒以 `--mode test` 构建产物启动，设置 `CYRENE_TEST_HARNESS=1` + `CYRENE_TEST_APP_DATA=<临时目录>`；Main 在 `installAppIdentity()` 前显式覆写并读回，助手启动后再核对 `appData=<临时目录>`、`userData=<临时目录>/Cyrene`。任一不一致均 fail-closed，不继续运行用例。

## 失败排障

1. **`out/` 未构建或产物过期**：先跑 `pnpm build` / `pnpm test:integration` 会重跑 `--mode test` 构建；`out/` 缺失时 Electron 无入口，报模块找不到。
2. **Linux 无显示器 / DISPLAY 未设置**：Electron 启动失败，`Unable to open X display`。用 `xvfb-run -a pnpm test:integration`（CI 同款），或确认 `DISPLAY` 指向可用的 X/Wayland 会话。
3. **Playwright 浏览器二进制缺失**：`playwright install --with-deps chromium`（`--with-deps` 顺带装系统库）。Electron 测试用的是 `node_modules/electron/dist`，若 `electron` 依赖重装过需重新 `pnpm install`。
4. **单个用例超时**：冷启动 8–20s，配置已放宽到 60s；若仍超时先确认无残留 Electron 进程（`pgrep -f electron`）。

## 涉及文件

- `helpers/app.ts`：`launchApp`/`closeApp`/`serveRenderer`（临时 userData、harness 标记、静态渲染源，供信任边界测试）+ 进程退出兜底（用例忘记 `closeApp` 时应用不活过测试进程）
- `helpers/app.spec.ts`：启动助手自检
- `helpers/orphan-apps.ts`：遗留测试应用（孤儿 Electron 进程）识别与回收判据；由 `global-setup.ts` 在套件启动时调用一次。**所有者门**（`--cyrene-test-owner-pid=`）：所有者进程仍存活的应用一律跳过——自建 runner 上多个 job 共用一台机器的进程表，缺了它后启动的 job 会杀掉先启动 job 正在跑的应用（2026-09-12 实测）
- `global-setup.ts`：vitest `globalSetup`——回收上次中断运行留下的测试应用（避免跨运行争抢 CPU/GPU 造成偶发超时）；顺序固定为先进程后目录
- `Window.desktopApi` 类型：唯一一份声明在 `src/preload/window.d.ts`（渲染侧与集成侧共用；此前集成测试内的独立副本已删除）
- `protocol-handler.spec.ts` / `ipc-security.spec.ts` / `navigation.spec.ts` / `trust-boundary.spec.ts`：四组套件
