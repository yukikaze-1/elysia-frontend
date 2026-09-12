# windows — 主窗口管理

阶段 1 填充：`main-window.ts`（createMainWindow：webPreferences 安全基线 sandbox/contextIsolation/nodeIntegration、window-open 拦截、cyrene:// 协议加载），从 index.ts 迁出并加固。加载形态：dev（ELECTRON_RENDERER_URL 存在）= Vite http；构建/打包/无 dev server = `cyrene://renderer/index.html`。

## `window-presentation.ts` — 统一窗口呈现边界（2026-09-12）

Main 进程里**唯一**允许直接调用窗口呈现类 API（`new BrowserWindow` / show / hide / focus / restore /
moveTop / setAlwaysOnTop / setSkipTaskbar / setFocusable / DevTools 窗口）的地方，负责
**Silent Test Window Mode**：自动化测试运行期间窗口不显示、不抢焦点、不置顶、不进任务栏，
而 renderer / preload / IPC / Playwright 自动化语义逐字不变。

- 判据来自 `config/runtime-environment.ts`（`CYRENE_WINDOW_MODE`，harness 下默认 `silent`）；
- `createAppWindow()` 在**创建前**改写选项（`show:false` / `alwaysOnTop:false` / `skipTaskbar:true`），
  其余配置逐字保留；建完立即启动**出帧保活**——隐藏窗口默认被 Chromium 压到约 1 帧/秒，订阅
  `webContents.beginFrameSubscription` 后恢复满速（实测 0 → 134 次 rAF 回调/600ms）且窗口始终不映射；
  该 API 不可用（平台差异）或预算内无帧时回退为「映射但不可见」（不透明度 0 + 鼠标穿透 +
  `showInactive()`，不激活、不抢焦点）；
- `showWindow()` / `focusWindow()` / `setWindowAlwaysOnTop()` / `setWindowSkipTaskbar()` /
  `toggleWindowDevTools()` / `openWindowDevTools()` 是其余代码唯一的呈现入口，silent 下全部短路；
- `lastWindowPresentation()` 留痕实际生效的选项与保活形态（`skipTaskbar` 在 Electron 无 getter，
  集成断言与 harness 探针依赖它）；
- 纪律由 `tests/unit/window-presentation-guard.spec.ts` 源码扫描钉住：新增任何越过本模块的
  建窗/呈现/原生对话框调用点都会使单测变红。

