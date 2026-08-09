import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol/constants' // 纯常量，与 scheme.ts 同源，杜绝字面量双处漂移

export type AppMode = 'development' | 'test' | 'production'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

export interface AppConfig {
  mode: AppMode
  logLevel: LogLevel
  devToolsAllowed: boolean
  protocolName: typeof PROTOCOL_SCHEME
  rendererHost: typeof RENDERER_HOST
}

export function normalizeAppMode(raw: string | undefined): AppMode {
  return raw === 'development' || raw === 'test' ? raw : 'production'
}

export function resolveAppConfig(
  mode: AppMode,
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): AppConfig {
  // 安全不变量：打包即生产安全默认——与构建 mode / env 无关
  const devToolsAllowed = !isPackaged
  const rawLevel = env['CYRENE_LOG_LEVEL']
  const defaultLevel: LogLevel = mode === 'production' ? 'info' : 'debug'
  const logLevel: LogLevel =
    isPackaged ? 'info' : rawLevel && (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : defaultLevel
  return { mode, logLevel, devToolsAllowed, protocolName: PROTOCOL_SCHEME, rendererHost: RENDERER_HOST } // 用常量，非字面量
}

// 加载/协议注册统一谓词：纯「有无合法 Vite dev server」= 未打包 && ELECTRON_RENDERER_URL 是可解析的 http(s) URL。
// 打包恒 false——残留 dev env 不能把打包产物劫持到 http（跳过 cyrene handler + 严格 CSP）。
// 畸形/非 http 残留 env → false（走 cyrene://，不白窗）；electron-vite dev（含 --mode test）恒设合法 URL → true。
export function shouldUseViteDevServer(
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): boolean {
  const u = env['ELECTRON_RENDERER_URL']
  if (!u || isPackaged) return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
