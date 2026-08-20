// src/main/tools/env-bridge.ts
// 阶段 6 批次 B（Task 6）：工具数据面 env 桥（对齐 parseMock*Env 先例——非法 JSON/形状 → undefined，不注入）。
// 仅 mock 模式集成测试使用；生产不设 env 走缺省（不注入 → 真实数据面）。

/** 1×1 PNG data URL（R9/H11）：mock 模式 capture 数据面占位——缩略图/预览不调真实 desktopCapturer
 *  （集成测试确定性；bytes 用固定 PNG 头供上传断言）。 */
export const MOCK_THUMBNAIL_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** CYRENE_MOCK_TOOL_ALLOW_ROOT env → string[]：黑名单放行根目录 JSON 数组。
 *  undefined/空串/非法 JSON/非全 string 数组 → undefined（不注入）；空数组合法（无放行根）。 */
export function parseMockToolAllowRootEnv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    const v: unknown = JSON.parse(value)
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return undefined
    return v as string[]
  } catch { return undefined }
}

/** CYRENE_MOCK_CAPTURE_SOURCES env → {sourceId, sourceName}[]：屏幕捕获源枚举 JSON 数组
 *  （缺 thumbnailDataUrl——装配时经 MOCK_THUMBNAIL_DATA_URL 补齐，R9）。
 *  undefined/空串/非法 JSON/非 {sourceId,sourceName} 形状 → undefined（不注入）。 */
export function parseMockCaptureSourcesEnv(value: string | undefined): Array<{ sourceId: string; sourceName: string }> | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    const v: unknown = JSON.parse(value)
    if (!Array.isArray(v)) return undefined
    const out: Array<{ sourceId: string; sourceName: string }> = []
    for (const item of v) {
      if (typeof item !== 'object' || item === null) return undefined
      const o = item as { sourceId?: unknown; sourceName?: unknown }
      if (typeof o.sourceId !== 'string' || typeof o.sourceName !== 'string') return undefined
      out.push({ sourceId: o.sourceId, sourceName: o.sourceName })
    }
    return out
  } catch { return undefined }
}

/** CYRENE_MOCK_GRANT_DIRECTORY env → string：mock 模式授权目录（批次 C F-9——单个 JSON 字符串路径，
 *  非 JSON 数组；undefined/空串/非法 JSON/非非空字符串 → undefined（不注入）。
 *  仅 mock 模式集成测试使用（装配侧 useMock 门控 M-2——真实模式误设不注入）。 */
export function parseMockGrantDirectoryEnv(value: string | undefined): string | undefined {
  if (!value) return undefined
  try { const p = JSON.parse(value); return typeof p === 'string' && p.length > 0 ? p : undefined } catch { return undefined }
}
