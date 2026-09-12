// vitest.integration.config.visible.mts
// 集成套件的**可视化调试模式**（`pnpm test:integration:visible`）。
//
// 与默认集成套件逐字相同，唯一差异是窗口呈现模式：默认是 silent（窗口不显示、不抢焦点、不进任务栏），
// 本模式切到 visible —— Electron 窗口真的显示在桌面上，便于人工观察窗口/焦点/任务栏/DevTools 行为。
// 判据解析见 src/main/config/runtime-environment.ts；测试侧注入点见 tests/integration/helpers/app.ts
// 的 `suiteWindowMode()`（本文件的 test.env → worker 的 process.env → Electron 子进程 env）。
//
// 刻意用独立配置文件而不是 shell 环境变量前缀：本仓跨 Windows/Linux，`FOO=1 cmd` 只在 bash 下工作，
// 而为一个变量引入 cross-env 依赖不值当（依赖清单本身是受文档与门禁管辖的面）。
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.integration.config.mts'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { CYRENE_WINDOW_MODE: 'visible' },
    },
  })
)
