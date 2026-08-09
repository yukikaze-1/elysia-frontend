import { app } from 'electron'
import { normalizeAppMode, resolveAppConfig, shouldUseViteDevServer } from './env'
import type { AppConfig } from './env'

// __APP_MODE__ 全局声明在 src/main/env.d.ts（tsconfig.node.json 的 src/main/**/* 覆盖），此处不再重复 declare

export { shouldUseViteDevServer } // 主装配/主窗口共用「有无 Vite dev server」谓词

export function getAppConfig(): AppConfig {
  // 不信任 process.env.NODE_ENV：缺失/未知 __APP_MODE__ 一律归 production（fail-safe）
  const raw = typeof __APP_MODE__ !== 'undefined' ? __APP_MODE__ : 'production'
  return resolveAppConfig(normalizeAppMode(raw), app.isPackaged, process.env)
}
