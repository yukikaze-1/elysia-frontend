# 集成测试（Playwright `_electron`）

覆盖 Main 侧安全关键路径的真实 Electron 行为：协议 handler（F1）403/404/逃逸/200+CSP、IPC API 面/非法参数/超大输入/来源校验、外部链接受控、普通浏览器信任边界。与单元测试（`vitest run`）不同，这里用 Playwright 启动**真实 Electron 进程**，验证的是构建产物 + preload + IPC 的端到端边界。

## 运行方式

```bash
# 仓库根：一次跑全套（自动 electron-vite build --mode test + vitest run）
pnpm --filter @cyrene/desktop test:integration

# 或 cd apps/desktop 后
pnpm test:integration
```

`test:integration` 脚本 = `electron-vite build --mode test`（产出 `apps/desktop/out/` 测试构建）+ `vitest run --config vitest.integration.config.mts`（`tests/integration/**/*.spec.ts`）。集成配置 `testTimeout`/`hookTimeout` 60s（Electron 冷启动 8–20s）、`fileParallelism: false`。

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

- `helpers/app.ts`：`launchApp`/`closeApp`/`serveRenderer`（临时 userData、harness 标记、静态渲染源，供信任边界测试）
- `helpers/app.spec.ts`：启动助手自检
- `helpers/desktop-api.d.ts`：集成测试用 `Window.desktopApi` 类型（非冲突基名，绕开 tsc 同名遮蔽）
- `protocol-handler.spec.ts` / `ipc-security.spec.ts` / `navigation.spec.ts` / `trust-boundary.spec.ts`：四组套件
