// tests/integration/protocol-media-handler.spec.ts
// Task 17:协议 handler 媒体分支实测（spec §4.4/D1）——launchApp + main 进程 net.fetch 直接命中真实 protocol.handle。
// P2-7：本文件改真集成（不再与 Task 8 media-service.spec 单测重复）——断言的 403/404 决策（host/parseMediaPath/
// MediaService 白名单）都经真实 handler 媒体分支执行；MediaService.stream 的 Range/重签/206 细节由 Task 8 单测覆盖。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { if (launched) await closeApp(launched) })

const fetchStatus = (url: string): Promise<number> =>
  launched.app.evaluate(async ({ net }, u) => {
    try { return (await net.fetch(u)).status } catch { return -1 }
  }, url)
const fetchStatusWithHeaders = (url: string, headers: Record<string, string>): Promise<number> =>
  launched.app.evaluate(async ({ net }, arg) => {
    try { return (await net.fetch(arg.url, { headers: arg.headers })).status } catch { return -1 }
  }, { url, headers })

describe('protocol.handle 媒体分支（spec §4.4/D1）', () => {
  it('非 renderer host 的媒体前缀仍 404（host 校验先于媒体路由）', async () => {
    expect(await fetchStatus('cyrene://evil/__cyrene-media/attachment/att_1')).toBe(404)
  })
  it('畸形媒体路径 → 403（parseMediaPath 拒，不落到文件服务）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/att_1/x')).toBe(403)
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/bogus/att_1')).toBe(403)
  })
  it('attachment 分支经 MediaService 决策（非法 attachmentId → 403，非文件服务 404）', async () => {
    // 若媒体分支未接线，该路径会按渲染根文件 404；403 证明 resolveMedia→MediaService.stream 已执行
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/evil')).toBe(403)
  })
  it('sticker id 白名单外 → 403（MediaService.sticker 白名单经 handler 生效）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/sticker/ST_1')).toBe(403)
  })
  it('§4.3 补断言：Sec-Fetch-Dest document 的媒体请求 → 403（isDocumentRequest 拒绝——顶层导航语义不进媒体面）', async () => {
    // 既有分支（handler.ts:122）缺集成断言面——「阅读器/框架式导航」不得经媒体代理触发文档加载
    expect(await fetchStatusWithHeaders('cyrene://renderer/__cyrene-media/attachment/att_1', { 'Sec-Fetch-Dest': 'document' })).toBe(403)
    expect(await fetchStatusWithHeaders('cyrene://renderer/__cyrene-media/sticker/ST_1', { 'Sec-Fetch-Dest': 'document' })).toBe(403)
  })
  it('§4.3 补断言：合法格式但不存在的 attachmentId → 签名流式分支执行（base 未配置→500 resolve fail / 上游不可达→502 瞬态——绝无文件服务 200/404 泄漏）', async () => {
    // 判别面：id 格式合法（att_ 前缀）→ 进入 MediaService.stream → resolveSignedUrl：
    // 本套件未设后端 endpoint → base 未配置 → SignedUrlResolveError 500（P0-01 fail-closed）；
    // 配了 base 后（真实会话）→ createSignedUrl → 上游失败 502 瞬态——两条均属「签名流式层已接线且失败收敛」，
    // 若走错分支（文件服务/静态兜底）会得到 200/404——此断言即负向哨兵。
    const status = await fetchStatus('cyrene://renderer/__cyrene-media/attachment/att_deadbeef')
    expect([500, 502, 401, 403, 410]).toContain(status)   // 签名失败族——永不 200/404 文件泄漏
  })
})
