// tests/integration/markdown-xss.spec.ts（阶段 7 批次 A，Task 8）
// 安全门禁层（spec §3.4「两层划分」）：真实 Chromium 渲染面 + DOMPurify 消毒链的判别断言——
// 单元层（happy-dom）仅行为记录，安全门禁全归本文件（spec 10.1 happy-dom 非可信消毒 oracle）。
// 机制（三层）：①DOMPurify ALLOWED_URI_REGEXP（外层 C0/空格吞 + 内层负向断言再吞）+ 库内 ATTR_WHITESPACE
// 先剥后测（TAB/NBSP/换行内嵌变体全部收敛为 javascript:/data: 后拦截）②CyMarkdown 点击层
// （preventDefault + 仅 http(s)）③主进程 will-navigate/setWindowOpenHandler 拒绝 + CSP script-src 'self'
// （js URL 属内联脚本被 CSP 拦截）。
//
// 载荷注入（spec §10.8/可行 MED）：CYRENE_MOCK_REPLY_FIXTURE env 指向夹具文件——MockBackend options.replyFixtureText
// 覆盖回复正文（首个 public_reply delta 全量、其后置空）；renderer 不读 env（既有 CYRENE_MOCK_* 纪律）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

// —— 【载荷集】真实浏览器语义下的判别面（spec §3.4/§10.10 变体）——
//   onerror 哨兵（script 执行检测） / javascript: href（含前导空白/TAB/NBSP/换行实体变体） /
//   data: href（含前导空白） / svg onload / style 标签 / iframe srcdoc / style 属性 /
//   裸 HTML 锚（经 marked raw HTML passthrough 路径——DOMPurify 是唯一净化层）。
//   实体编解码注记：href 内 &#x09;(TAB)/&#x0A;(换行)/&#xA0;(NBSP) 经 DOMPurify DOM 解析先解码，
//   ATTR_WHITESPACE 剥离后收敛为 javascript: 再测 URI 正则——净化语义验证（非 CSP 层）。
const FIXTURE_PAYLOADS = `XSSFIX-START《关注载荷集》

一、img onerror 哨兵（window.__xssFired 执行检测）
<img src=x onerror="window.__xssFired=1">

二、危险链接：javascript: 基础 / 前导空间 data: / TAB 实体 / 换行实体 / NBSP 实体 / 大小写混合
[x1](javascript:alert(1))
[x2]( data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg)
[x4](java&#x09;script:alert(1))
[x5](java&#x0A;script:alert(1))
[x6](java&#xA0;script:alert(1))
[x7](JaVaScRiPt:alert(1))

三、裸 HTML 锚（marked raw HTML passthrough 路径——前导空白/TAB 内嵌同判别面）
<a href=" data:text/html,<script>alert(1)</script>">x3</a>
<a href="java&#x09;script:alert(1)">x8</a>

四、元素级载荷：svg onload / style 标签 / iframe srcdoc / style 属性
<svg onload="window.__xssFired=2"><circle/></svg>
<style>body{display:none}</style>
<iframe srcdoc="<script>window.__xssFired=3</script>"></iframe>
<div style="background:url(javascript:alert(1))">styled-div</div>

五、安全正方向哨兵（同段渲染健全性：缺它说明整段没渲染出来——断言集体空过是无意放水）
[safe](https://example.com/)
XSSFIX-END`

/** 载荷加载：夹具文件写至临时目录（主进程 readFileSync 读取——路径缺失/权限属装配错误 fail-start） */
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cy-xss-'))
  const file = join(dir, 'reply.md')
  writeFileSync(file, FIXTURE_PAYLOADS, 'utf8')
  return file
}

/** 「连接 + 激活首个会话 + UI 发送」——对齐 electron-live2d.spec 的 connectAndActivateFirst/sendChat 先例 */
async function connectAndSend(page: Page, text: string): Promise<void> {
  // UII-QQ：连接钮收进连接入口 popover——先点徽标（REAL/MOCK）展开，再点连接（能力不删，入口变更）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), { timeout: 8000, interval: 200 })
    .toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), { timeout: 8000, interval: 200 }).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true)), { timeout: 8000, interval: 200 })
    .toBe(false)
  await page.locator('textarea[aria-label="消息输入框"]').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

/** DOM 结构性判别面采集（page.evaluate 序列化函数——闭包不可引模块作用域，全部内联） */
function collectDomFacts(): {
  __xssFired: unknown
  anchorsDangerous: Array<{ label: string; href: string }>
  onattr: string[]
  styleAttrCount: number
  badTags: Record<string, number>
  imgDataSvg: number
  url: string
  markdownRendered: boolean
} {
  // 归一化判别（对齐 DOMPurify ATTR_WHITESPACE 类集合）：剥前导字符再测 scheme——
  // 与 a[href^="javascript:"] 选择器互辅：选择器只测「无前导空白」原型，归一化扫描才是变体判别面（安全复核 R2-MED-1）。
  const schemeRe = /^[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]*(?:javascript|data|vbscript):/i
  const scope = '.cy-assistant-row'
  const container = document.querySelector(scope)
  const w = window as unknown as Record<string, unknown>
  const onattr: string[] = []
  const badTags: Record<string, number> = {}
  for (const tag of ['iframe', 'object', 'embed', 'svg', 'style']) badTags[tag] = document.querySelectorAll(`${scope} ${tag}`).length
  const dangerous: Array<{ label: string; href: string }> = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${scope} a[href], ${scope} object[data], ${scope} embed[src]`))) {
    const href = el.getAttribute('href') ?? el.getAttribute('data') ?? el.getAttribute('src') ?? ''
    if (href && schemeRe.test(href)) dangerous.push({ label: el.tagName.toLowerCase(), href })
  }
  const scanEls = [container, ...Array.from(document.querySelectorAll(`${scope} *`))]
  for (const el of scanEls) {
    if (!el) continue
    for (const attr of el.attributes) {
      if (/^on[a-z]/i.test(attr.name)) onattr.push(`${attr.name}=${attr.value.slice(0, 40)}`)
    }
  }
  return {
    __xssFired: w.__xssFired,
    anchorsDangerous: dangerous,
    onattr,
    styleAttrCount: document.querySelectorAll(`${scope} [style]`).length,
    badTags,
    imgDataSvg: document.querySelectorAll(`${scope} img[src^="data:image/svg"]`).length,
    url: location.href,
    // UII-QQ：assistant 行内首个 markdown 恒为内心独白——任一命中才算 fixture 已渲染
    markdownRendered: [...document.querySelectorAll(`${scope} .cy-markdown`)].some((m) => (m.textContent ?? '').includes('XSSFIX-START')),
  }
}

let app: ElectronApplication
let page: Page
let userData = ''
let fixtureFile = ''
beforeAll(async () => {
  fixtureFile = writeFixture()
  const launched = await launchApp(undefined, { env: { CYRENE_MOCK_REPLY_FIXTURE: fixtureFile } })
  app = launched.app
  page = launched.page
  userData = launched.userData
}, 60_000)
afterAll(async () => {
  try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
  try { rmSync(dirname(fixtureFile), { recursive: true, force: true }) } catch { /* 尽力 */ }
})

describe('Markdown XSS（真实 Chromium 安全门禁层——spec §3.4）', () => {
  it('XSS 载荷集渲染后：哨兵未触发 + DOM 结构性断言全 0（含前导空白/TAB/换行/NBSP 变体 + data:svg）', async () => {
    // 对话框自动处理（安全链接点击后的 confirm——dismiss 不开外部浏览器）
    page.on('dialog', (d) => { void d.dismiss().catch(() => {}) })
    // 发送消息 → mock replyFixtureText 覆盖回复正文（真实 UI 流式渲染路径）
    await connectAndSend(page, 'xss-fixture')
    // UII-QQ：无通道包装层后 assistant 行内有「内心独白 + 公开回复」两处 markdown——
    // 标记检查必须是「任一 markdown 命中」（querySelector 首个匹配恒为内心独白，不含 fixture 标记）
    await expect.poll(
      () => page.evaluate(() => [...document.querySelectorAll('.cy-assistant-row .cy-markdown')]
        .some((m) => (m.textContent ?? '').includes('XSSFIX-START'))),
      { timeout: 15_000, interval: 200 },
    ).toBe(true)
    const facts = await page.evaluate(collectDomFacts)
    // 0. 渲染健全性哨兵（防「整段没渲染 → 断言全 0 为空放水」）
    expect(facts.markdownRendered).toBe(true)
    // 1. script 执行哨兵未置位（onerror 未触发——DOMPurify 剥 on* + CSP script-src 'self'）
    expect(facts.__xssFired).toBeUndefined()
    // 2. 危险 scheme 锚（a/object/embed 归一化扫描——含前导空白/TAB/换行/NBSP 变体）0
    expect(facts.anchorsDangerous).toEqual([])
    // 3. 无 on* 属性残留 + 无 style= 属性（style 属性注入判别面）
    expect(facts.onattr).toEqual([])
    expect(facts.styleAttrCount).toBe(0)
    // 4. 无 iframe/object/embed/svg/style 元素（srcdoc 注入/元素级载荷判别面）
    expect(facts.badTags).toEqual({ iframe: 0, object: 0, embed: 0, svg: 0, style: 0 })
    // 5. img[src^="data:image/svg"] 0（计划 N-4 补项——数据 URI 进 img 的判别面期望）
    expect(facts.imgDataSvg).toBe(0)
    // 6. 页面 URL 恒在 cyrene:// 应用（本测试不导航）
    expect(facts.url).toMatch(/^cyrene:\/\//)
    // 7. 点击已渲染锚（首个 a[href]——安全链接 confirm 被 dismiss）→ URL 不变（CyMarkdown 点击层 + will-navigate 双保险）
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>('.cy-assistant-row a[href]')
      if (a) a.click()
    })
    await expect.poll(() => page.url(), { timeout: 5000, interval: 200 }).toMatch(/^cyrene:\/\//)
    // 8. 选择器原型面（无前导空白变体——变体判别已由 2 归一化面覆盖）
    const rawSelectors = await page.evaluate(() => ({
      js: document.querySelectorAll('.cy-assistant-row a[href^="javascript:"]').length,
      data: document.querySelectorAll('.cy-assistant-row a[href^="data:"]').length,
    }))
    expect(rawSelectors).toEqual({ js: 0, data: 0 })
  })

  it('§4.3 导航/窗口/CSP 负方向断言（补断言无实现变更预期——既有实现已覆盖拒绝路径）', async () => {
    // —— will-navigate 对 javascript:/data: deny：location 赋值 → 页面 URL 不变 + JS 不执行 ——
    //   javascript: URL 属内联脚本，被 CSP script-src 'self' 拦截；data: 顶层导航被 will-navigate deny——
    //   「URL 不变 + 哨兵未置位」为判别面（保护层哪一层命中均可，恒为拒绝态）。
    const probe = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>
      const before = location.href
      try { location.href = 'javascript:window.__xssNav="fired-js"' } catch { /* 拒绝路径】 */ }
      await new Promise((r) => setTimeout(r, 250))
      const afterJs = location.href
      const jsFired = w.__xssNav
      try { location.href = 'data:text/html,<script>window.__xssNav="fired-data"</script>' } catch { /* 拒绝路径 */ }
      await new Promise((r) => setTimeout(r, 250))
      return { afterJs, jsFired, afterData: location.href, before, nav: w.__xssNav }
    })
    expect(probe.afterJs).toBe(probe.before)
    expect(probe.jsFired).toBeUndefined()
    expect(probe.afterData).toBe(probe.before)
    expect(probe.nav).toBeUndefined()
    // —— setWindowOpenHandler 非 http(s) 拒绝：window.open javascript:/data: → 不新建窗 + JS 不执行 ——
    const winsBefore = app.windows().length
    const openProbe = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>
      window.open('javascript:window.__xssNav="fired-open-js"')
      window.open('data:text/html,<script>window.__xssNav="fired-open-data"</script>')
      await new Promise((r) => setTimeout(r, 300))
      return { nav: w.__xssNav }
    })
    expect(openProbe.nav).toBeUndefined()
    expect(app.windows().length).toBe(winsBefore)
    // —— CSP 一致性对照断言（spec §4.3）：prod 响应头（cyrene:// handler RENDERER_CSP）与 dev meta 关键指令 ——
    const headerCsp = await app.evaluate(async ({ net }) => {
      try { return (await net.fetch('cyrene://renderer/index.html')).headers.get('Content-Security-Policy') ?? '' } catch { return '' }
    })
    expect(headerCsp).toContain("script-src 'self'")
    expect(headerCsp).toContain("object-src 'none'")
    expect(headerCsp).toContain("frame-src 'none'")
    expect(headerCsp).toContain("form-action 'none'")
    expect(headerCsp).toContain("frame-ancestors 'none'")
    expect(headerCsp).toContain("default-src 'none'")   // prod：default-src 'none'（非指令面显式拒绝）
    expect(headerCsp).not.toContain('unsafe-eval')
    expect(headerCsp).not.toContain('unsafe-inline')     // prod 头 style-src 'self'（无 unsafe-inline——更严）
    const metaCsp = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '')
    expect(metaCsp).toContain("script-src 'self'")
    expect(metaCsp).toContain("frame-src 'none'")
    expect(metaCsp).toContain("form-action 'none'")
    expect(metaCsp).toContain("object-src 'none'")
    expect(metaCsp).not.toContain('unsafe-eval')
    // 对照语义：dev meta 保留 style-src 'unsafe-inline'（Vite 注记——prod 头部 style-src 'self' 更严，交拦截取严不冲突；
    // 关键指令（script/frame/object/form-action）双面同值——断言面即「每条安全关键指令在两层均存在且拒绝面一致」）
  })
})
