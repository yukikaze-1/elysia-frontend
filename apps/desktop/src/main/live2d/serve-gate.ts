// apps/desktop/src/main/live2d/serve-gate.ts
// Live2D 模型文件「供给闸门」——协议通道（cyrene://，打包/preview 形态）与 IPC 通道（dev 形态）共用同一份判定。
//
// 为什么需要两条通道（2026-09-10）：
//   dev 形态（`pnpm dev`）页面由 Vite dev server 供给，origin 是 `http://localhost:<port>`；而模型文件只在
//   `cyrene://renderer/__cyrene-live2d/…` 上。scheme 恒 `corsEnabled:false`（阶段 5 D-4 安全结论：放开后
//   非受信 origin 也能读 `cyrene://` 资源），因此跨源 fetch 被 Chromium 直接拒绝，页面只拿到原生
//   `TypeError: Failed to fetch`——界面显示「模型加载失败 / 原因：Failed to fetch」，而模型清单 IPC 一切正常
//   （清单是 invoke 通道，不受跨源限制）。该现象自阶段 5 起即在验收记录中记为已知限制（F-后续-2）。
//
// 为什么闸门必须只有一份：
//   两条通道各自写一遍「verifyIntegrity → registered/available → containment 白名单」，
//   二者迟早分叉；而分叉的那一侧就是绕过入口。故此处抽为 electron-free 单一实现，
//   protocol/handler.ts 的 createLive2dResolver 与 ipc/live2d-handlers.ts 的读取通道共同调用。
//
// electron-free 是硬约束（与 config/dev-csp.ts 同款纪律）：本模块不 import 'electron'，以便单测直接驱动。

/**
 * resolveLive2d 组合闭包所需的最小 registry 面（Live2DModelRegistry 满足结构；测试注入 Fake registry）。
 * 结构判定（M-3 协调注记）：resolveModelFile 只做 failed 熔断，不进 registered/available 门禁——闸门在调它之前
 * 先 verifyIntegrity（fail-closed，首个命中 await 全量 hash）+ listInstalledModels 的 registered/available 判定。
 */
export interface Live2dResolverRegistry {
  /** fail-closed 全量 SHA-256 复核（同模型 pending 共享；失败 → false 并熔断） */
  verifyIntegrity(modelId: string): Promise<boolean>
  /** 装配摘要（registered 判定：manifest 合法列出 + available 门禁） */
  listInstalledModels(): Promise<ReadonlyArray<{ id: string; available: boolean }>>
  /** containment + integrity 白名单 + 尺寸一致 → 绝对路径；未命中返回 null */
  resolveModelFile(modelId: string, relPath: string): Promise<string | null>
}

/**
 * 闸门判定结果。`kind` 与 HTTP 语义一一对应，由各通道自行映射为 Response / IPC 状态码：
 *   ok → 200 + absPath（**绝对路径不得离开 Main**，IPC 通道只回字节）
 *   not_found → 404（未注册 / available=false / 完整性复核失败）
 *   forbidden → 403（containment 拒绝、白名单未命中、非普通文件）
 *   bad_gateway → 502（registry 实现异常，理论上不抛，仍封口）
 */
export type Live2dGateResult =
  | { kind: 'ok'; absPath: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'bad_gateway' }

/**
 * 模型文件供给闸门。顺序即安全性，不得调换：
 *   ① verifyIntegrity 先于一切——fail-closed 时序：首个命中请求 await 全量 hash，完成前不响应该模型任何文件；
 *   ② registered/available 门禁先于 resolveModelFile——未注册模型/available=false 回 404 而非 403，防用状态码遍历目录；
 *   ③ resolveModelFile 内部再做 realpath containment + integrity 条目白名单 + 尺寸一致 + lstat 普通文件。
 */
export async function gateLive2dFile(
  registry: Live2dResolverRegistry,
  modelId: string,
  relPath: string
): Promise<Live2dGateResult> {
  try {
    // ① fail-closed 时序：首个命中请求 await 全量 hash
    const ok = await registry.verifyIntegrity(modelId)
    if (!ok) return { kind: 'not_found' }
    // ② M-3：resolveModelFile 不做 registered/available 门禁——这里先判定（防 403 遍历）
    const summaries = await registry.listInstalledModels()
    const active = summaries.find((s) => s.id === modelId)
    if (!active || !active.available) return { kind: 'not_found' }
    // ③ containment + 白名单 + 尺寸
    const absPath = await registry.resolveModelFile(modelId, relPath)
    if (!absPath) return { kind: 'forbidden' }
    return { kind: 'ok', absPath }
  } catch {
    // 注册表实现异常（verifyIntegrity/list/resolve 理论上不抛，仍封口）→ 502 transient
    return { kind: 'bad_gateway' }
  }
}

/** 闸门失败结果 → HTTP 状态码/文本（协议通道与 IPC 通道共用同一映射，避免两处各写一份数字与文案） */
export function gateHttpFailure(kind: Exclude<Live2dGateResult['kind'], 'ok'>): { status: number; text: string } {
  switch (kind) {
    case 'not_found': return { status: 404, text: 'Not Found' }
    case 'forbidden': return { status: 403, text: 'Forbidden' }
    case 'bad_gateway': return { status: 502, text: 'Bad Gateway' }
  }
}
