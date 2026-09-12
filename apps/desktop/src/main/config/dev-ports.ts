// apps/desktop/src/main/config/dev-ports.ts
//
// 开发环境端口与本地服务地址的**唯一配置来源**（single source of truth）。
//
// 为什么要有这个模块（2026-09-12，开发环境隔离审计）：
//   本机同时开发多个 Electron 项目，每个都经 `pnpm dev` 启动。此前本项目的 Vite 端口是裸默认值
//   （5173，且 `strictPort` 未开），与同机另一套 Electron 项目的 `vite`（同样 5173）争抢：谁先启动谁占，
//   后启动者被 Vite 静默换到 5174，而主进程拿到的 `ELECTRON_RENDERER_URL` 也跟着变成 5174。共享端口段 +
//   静默漂移 = 不可预测的调试现场（面板/CSP/探针看到的 origin 与文档不一致）。
//
// 本项目的端口段：**53xx**（Renderer 5373 / Backend 5380 / WebSocket 5381 / MCP 5382）。
//   - Renderer 用 5373 而不是 5173/5273：那两个是 Electron 脚手架与常见 Vite 工程的裸默认值，
//     正是最容易撞车的号段；53xx 与项目内其它服务同段，便于一眼识别归属。
//   - Backend/WebSocket/MCP 三个号位在本项目**当前无对应服务**（见 docs/19 登记表：Backend 是外部
//     后端、WS 复用后端 origin、无 MCP/Sidecar）。号位保留不发号，避免将来新增本地服务时再回头改号段。
//
// 作用域纪律：本模块只放「开发期本地地址常量 + 纯校验函数」，不 import electron / node 内建模块，
// 因此 electron.vite.config.ts（构建期，Node 侧）与 main 进程（运行期）可以共用同一份数值。
// 注意 Vite 的 `server.port` 是**构建期**读取：`process.env` 的 `VITE_*` 注入发生在 renderer server
// 启动之后，无法反向影响端口，故这里用常量而不是 env 间接层。
import { isLoopbackHostname } from './trusted-renderer-origin'

/** 开发期 Vite dev server 端口（renderer 与 HMR WebSocket 共用此端口） */
export const DEV_SERVER_PORT = 5373

/**
 * 开发期 dev server 绑定地址：显式回环 IPv4。
 * 不用 `localhost`：Windows 上它可能先解析到 `::1`，在没有 IPv4 回环监听时 `http://localhost:<port>`
 * 会连不上（Node 17+ 不再重排 DNS 结果）；也不绑 `0.0.0.0`（会暴露到局域网并触发防火墙提示）。
 */
export const DEV_SERVER_HOST = '127.0.0.1'

/** dev server 对外 origin（主进程断言与 electron-vite 注入的 ELECTRON_RENDERER_URL 比对基准） */
export const DEV_SERVER_ORIGIN = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`

/**
 * 开发默认后端 Endpoint（本机 elysia-agent 真实后端 8765；由后端侧 config.yaml `server.port` 决定，
 * **不是本项目号段的端口**，改动须与后端侧同步）。仅未打包 + 真实模式 + 会话内未配置时注入。
 */
export const DEV_DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:8765'

/** 覆盖开发默认后端地址的环境变量（同名 env 优先；仍受 ConnectionConfig 的「http 仅回环」校验收口） */
export const DEV_BACKEND_ORIGIN_ENV = 'CYRENE_DEV_BACKEND_ORIGIN'

export interface DevServerConfig {
  readonly port: number
  readonly host: typeof DEV_SERVER_HOST
  readonly strictPort: true
}

const MIN_PORT = 1024
const MAX_PORT = 65535

/** 端口取值校验：任何漂移都在构建/启动期明确报错，不静默换号 */
export function assertValidDevServerPort(port: number = DEV_SERVER_PORT): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`[cyrene] 开发端口非法：${String(port)}（应为 ${MIN_PORT}~${MAX_PORT} 的整数）`)
  }
  return port
}

/** Vite renderer server 配置片段（唯一来源；electron.vite.config.ts 直接展开） */
export function devServerConfig(port: number = DEV_SERVER_PORT): DevServerConfig {
  return { port: assertValidDevServerPort(port), host: DEV_SERVER_HOST, strictPort: true }
}

/**
 * 主进程启动断言（dev 形态专用）：electron-vite 注入的 dev server origin 必须与本模块常量一致。
 *
 * electron-vite 的 dev server 端口来自 `server.port`（构建期已由本模块钉死），运行时再回读注入值并比对，
 * 使「配置文件与实际运行端口漂移」这件事在启动期就炸掉，而不是变成难查的调试现场。
 * 端口被占时 Vite（严格端口）会直接启动失败，故此处只兜配置漂移。
 *
 * 唯一放行例外：**测试 harness**（`allowAnyLoopbackPort`）——集成套件用 `port: 0` 让内核分配空闲端口，
 * 以免测试进程与开发者正在跑的 `pnpm dev` 抢 5373（tests/integration/helpers/renderer-dev-server.ts）。
 * 该例外**只**放宽「必须是我们规划的那个端口」，回环约束不放宽：harness 下依然只接受回环 host，
 * 因为本断言与启动门禁（evaluateDevRendererUrl）互补——后者才管「能不能连」，且它在 harness 下同样生效。
 */
export function assertDevServerOrigin(
  runtimeUrl: string | undefined,
  options: { allowAnyLoopbackPort?: boolean } = {}
): { ok: true } | { ok: false; reason: string } {
  if (runtimeUrl === undefined || runtimeUrl.trim() === '') {
    return { ok: false, reason: 'ELECTRON_RENDERER_URL 缺失（dev 形态应有 electron-vite 注入）' }
  }
  let url: URL
  try { url = new URL(runtimeUrl) } catch { return { ok: false, reason: `ELECTRON_RENDERER_URL 无法解析：${runtimeUrl}` } }
  if (url.protocol !== 'http:') return { ok: false, reason: `dev server 协议应为 http:（收到 ${url.protocol}）` }
  if (options.allowAnyLoopbackPort === true) {
    // harness 例外：任意端口，但 host 仍须回环（非回环地址由 evaluateDevRendererUrl 白名单单独裁决）
    if (!isLoopbackHostname(url.hostname)) {
      return { ok: false, reason: `harness 放行仅限回环 host（收到 ${url.hostname}）` }
    }
    return { ok: true }
  }
  if (url.hostname !== DEV_SERVER_HOST) {
    return { ok: false, reason: `dev server host 应为 ${DEV_SERVER_HOST}（收到 ${url.hostname}）` }
  }
  if (url.port !== String(DEV_SERVER_PORT)) {
    return {
      ok: false,
      reason: `dev server 端口应为 ${DEV_SERVER_PORT}（收到 ${url.port === '' ? '默认 80' : url.port}）——配置漂移或端口被其它项目占用后未按 strictPort 报错`
    }
  }
  return { ok: true }
}

/**
 * 开发默认后端地址解析：env 覆盖优先，否则用固定常量。
 * 返回 undefined 表示「不注入开发默认」（env 显式置空串 = 关闭）。
 * 校验与 ConnectionConfig.normalizeEndpoint 同口径（https 任意 host / http 仅回环），非法即抛，
 * 不静默回落到默认值——误配的地址不该被悄悄替换成另一个地址。
 */
export function resolveDevDefaultBackendOrigin(env: Record<string, string | undefined>): string | undefined {
  const raw = env[DEV_BACKEND_ORIGIN_ENV]
  if (raw === '' && env[DEV_BACKEND_ORIGIN_ENV] !== undefined) return undefined
  const candidate = raw === undefined ? DEV_DEFAULT_BACKEND_ORIGIN : raw.trim()
  if (candidate === '') return undefined
  if (!isAllowedEndpoint(candidate)) {
    throw new Error(`[cyrene] ${DEV_BACKEND_ORIGIN_ENV} 非法：${candidate}（https 任意 host，或回环 http）`)
  }
  return candidate
}

/** 与 connection-config.ts 的 isLoopbackHost 同口径（此处独立实现以避免 config→connection 反向依赖） */
function isAllowedEndpoint(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.username || u.password || u.search || u.hash) return false
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  const h = u.hostname
  if (h === 'localhost' || h === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}
