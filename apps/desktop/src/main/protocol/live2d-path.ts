// apps/desktop/src/main/protocol/live2d-path.ts
// 阶段 5 批次 A（A4，spec §3.4/D5A-08）：cyrene:// live2d 供给分支路径解析——镜像 media-service parse 纪律。
// 'cyrene://renderer/__cyrene-live2d/{modelId}/{relPath}'；modelId 为 ASCII slug 不编码（正则 + 非 '.'/'..'）；
// relPath 按 '/' 分段 percent-decode 逐段拒：空段、'.'、'..'、解码后含 '/'、'\'、NUL 的段。
// 与 '__cyrene-media' 互斥：live2d 分支在 handler 内位于 media 分支之后（media 在前），且 parse 前缀本身即区分。
//
// 2026-09-10：前缀改由 shared/contracts/live2d.ts 单一提供——Renderer 侧 adapter.ts 与 dev 形态 IPC
// 供给通道消费同一常量，不再各写一份字面量靠注释对齐。

import { LIVE2D_PATH_PREFIX } from '@shared/contracts'

export { LIVE2D_PATH_PREFIX }

const MODEL_ID_RE = /^[A-Za-z0-9._-]+$/

/**
 * 解析 live2d 供给路径；非法 → null（handler 据此回 403）。
 * modelId 段不做 decodeURIComponent（Task 5 适配器按 ASCII slug 原样组装，装饰编码会被正则拒绝 → fail-closed）。
 * relPath 各段逐个 decodeURIComponent；编码走私（%2F 解码成 '/'、%5C 成 '\'、%00 NUL、%2e%2e 成 '..'）逐段拒。
 */
export function parseLive2dPath(pathname: string): { modelId: string; relPath: string } | null {
  if (!pathname.startsWith(LIVE2D_PATH_PREFIX)) return null
  const rest = pathname.slice(LIVE2D_PATH_PREFIX.length)
  const segs = rest.split('/')
  const [modelId, ...relSegs] = segs
  if (!modelId || modelId === '.' || modelId === '..') return null
  if (!MODEL_ID_RE.test(modelId)) return null
  if (relSegs.length === 0) return null // 仅 modelId 根路径不是文件供给目标（renderer-root 的目录映射不适用于 live2d）
  const relParts: string[] = []
  for (const seg of relSegs) {
    if (seg.length === 0) return null // 空段（连续 '/' 或尾斜杠）
    let dec: string
    try {
      dec = decodeURIComponent(seg)
    } catch {
      return null // 孤立/畸形 % 编码
    }
    if (dec === '' || dec === '.' || dec === '..') return null
    if (dec.includes('/') || dec.includes('\\') || dec.includes('\0')) return null
    relParts.push(dec)
  }
  return { modelId, relPath: relParts.join('/') }
}