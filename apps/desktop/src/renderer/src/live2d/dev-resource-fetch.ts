// apps/desktop/src/renderer/src/live2d/dev-resource-fetch.ts
//
// dev 形态（`pnpm dev`）Live2D 模型文件供给——把适配器的 fetch 换成走 IPC 的等价实现。
//
// 背景（2026-09-10，实测定位）：
//   `pnpm dev` 下页面由 Vite dev server 供给，origin 是 `http://localhost:<port>`；而模型文件只在
//   `cyrene://renderer/__cyrene-live2d/…` 上。scheme 恒注册为 `corsEnabled:false`（阶段 5 D-4 安全结论：
//   放开后非受信 origin 也能读 `cyrene://` 资源），跨源 fetch 因此在 Chromium 的网络层就被拒绝，抛原生
//   `TypeError: Failed to fetch`——界面显示「模型加载失败 / 原因：Failed to fetch」，而模型清单走的是
//   invoke 通道，不受跨源限制，于是同时显示「已发现 3 个模型，其中可用 3 个」。两者并列看似矛盾，实为同一原因。
//
//   该限制自阶段 5 起记录在案（2026-08-19 验收 D-4 / 2026-08-27 验收环境注记 / F-后续-2「dev 模式 Live2D
//   不可用」），当时留的修法方向正是「dev 下改用同源代理或安全 CORS 方案」。
//
// 本修法为什么选 IPC 而不是放开 CORS 或起本地 HTTP：
//   ① 不放开 `corsEnabled`——它是 scheme 级全局开关，与既有安全结论直接冲突，且无法只对 dev 生效而不
//      改变 scheme 的全局语义；
//   ② 不起本地 HTTP 代理——那会在 Electron 进程边界之外新开一条读模型文件的路径，且需要复制路径解析；
//   ③ IPC 走的是既有 preload 信任边界（具名、窄接口、双向 schema 校验），门禁（verifyIntegrity →
//      registered/available → containment 白名单）与协议通道**共用 serve-gate.ts 同一实现**，不可能分叉。
//   能力上也不新增：打包形态下 Renderer 本就能同源 fetch 同一批字节。
//
// 打包/preview 形态页面自身即 `cyrene://renderer`（同源），仍走原生 fetch，与本模块无关。

import type { Live2dModelFileResult } from '@shared/contracts'
import { LIVE2D_PATH_PREFIX } from '@shared/contracts'

/** 模型文件读取器（真实实现 = preload `readLive2dModelFile`；单测注入确定性 fake） */
export type Live2dModelFileReader = (modelId: string, relPath: string) => Promise<Live2dModelFileResult>

/**
 * 判定当前是否必须走 IPC 供给。
 *
 * 判据是**页面与 `cyrene://` 是否同源**——同源则原生 fetch 不受 CORS 限制，跨源则必被拒。
 * 叠加 `MODE === 'development'` 使单测（happy-dom 下 location.protocol 恒为 `http:`）不会误入此路径：
 * 那里没有真实 dev server，也不该去碰 IPC。
 */
export function needsIpcResourceSupply(): boolean {
  return (
    import.meta.env.MODE === 'development' &&
    typeof location !== 'undefined' &&
    location.protocol !== 'cyrene:'
  )
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * 构造 dev 形态的 fetch 替身：接收与原生 fetch 相同的 URL（仍是 `cyrene://renderer/__cyrene-live2d/…`），
 * 但把字节读取搬到 IPC。
 *
 * 为什么保留 cyrene:// URL 而不是换一套路径：适配器只依赖「URL → Response」这一层；
 * 保持 URL 形态不变，使打包形态的请求串、单测断言与日志口径完全一致，dev/prod 的差异被限制在本模块内。
 *
 * 只解码到 (modelId, relPath) 即交给 Main——**判定权全在 Main**（本模块的解析只是传输参数组装，
 * 不含任何安全判断；Malformed 输入由 Main 侧 schema 与闸门拒绝并回状态码）。
 */
export function createDevLive2dFetch(read: Live2dModelFileReader): typeof fetch {
  const devFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(urlOf(input))
    if (!url.pathname.startsWith(LIVE2D_PATH_PREFIX)) {
      // 非模型资源（如着色器）不走本通道——那些由 Vite dev server 同源供给，本就不该经 IPC。
      throw new TypeError(`dev Live2D 供给仅覆盖 ${LIVE2D_PATH_PREFIX}：${url.pathname}`)
    }
    const segs = url.pathname.slice(LIVE2D_PATH_PREFIX.length).split('/')
    const modelId = segs[0] ?? ''
    const relPath = segs.slice(1).map((s) => decodeURIComponent(s)).join('/')
    const res = await read(modelId, relPath)
    // 失败只映射状态码：适配器据 res.ok/res.status 抛带 HTTP 状态的可读错误，与打包形态一致
    if (!res.ok) return new Response(null, { status: res.status })
    // new Uint8Array(view) 而非直接传 res.bytes：lib.dom 的 BodyInit 联合对 Uint8Array<ArrayBufferLike>
    // 解析不佳（TS 已知问题），构造一次得到确切的 Uint8Array<ArrayBuffer>。dev 形态下每文件一次、量级 MB，
    // 该拷贝无实际代价；换来的是不写类型断言。
    return new Response(new Uint8Array(res.bytes), { status: 200, headers: { 'Content-Type': res.mime } })
  }
  return devFetch
}
