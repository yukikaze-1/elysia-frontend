import { describe, expect, it } from 'vitest'
import { buildRendererCsp } from '../../src/main/protocol/csp'

describe('buildRendererCsp', () => {
  const csp = buildRendererCsp()
  it('含 frame-src 无来源（收口 iframe G-6）', () => {
    expect(csp).toContain("frame-src 'none'")
  })
  it('不含 unsafe-eval / unsafe-inline', () => {
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
  })
  it('脚本仅 self', () => {
    expect(csp).toContain("script-src 'self'")
  })
  it('default-src none + object-src none', () => {
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
  })
  it('connect-src 仅 self（renderer 不直连后端）', () => {
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('ws:')
  })
  it('font-src 含 data:（Vite 内联字体放行）', () => {
    expect(csp).toContain("font-src 'self' data:")
  })
  it('prod 有效策略锚定（meta ∩ 响应头 AND）：meta 的 blob:/ws:/unsafe-inline 在严格头中被剔除', () => {
    // 响应头与保留的宽松 meta 取交集 = 严格头（blob:/ws:/unsafe-inline 均被剔除）。
    // 阶段 3 若需 blob: 图片预览，须在此显式放行（改响应头 + 本测试），勿静默。
    expect(csp).not.toContain('blob:')
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('unsafe-inline')
  })
  it('prod 含 media-src self（视频/音频经同源 cyrene:// 放行，spec D1）', () => {
    expect(csp).toContain("media-src 'self'")
  })
  it('prod img-src 不含裸 host / 不加任意 host（同源 \'self\' 即放行）', () => {
    expect(csp).not.toContain('cyrene:')
    expect(csp).not.toContain('http://')
  })
})
