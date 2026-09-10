// tests/integration/diagnostics-ipc.spec.ts（阶段 7 批次 A，Task 8）
// spec §6.2/§9：开发与诊断设置页的 IPC 全链 wire 断言——
// ① state（displayDir 脱敏形态——绝对路径不上行，安全复核 M-2）
// ② dev-mode-set（§9 明列：app.evaluate 读 BrowserWindow webContents.isDevToolsOpened() 轮询 true→false——
//    符合性 M-4：恢复断言而非静默降级；detach 窗口 xvfb 可创建）+ 审计 dev:mode-changed
// ③ clear-logs（state.lastCleanup 回显 + 审计 diagnostics:logs-cleared——计划 review MED-3 后半布线要求）
// ④ export（harness 落 dirs.temp 固定名 + manifest F-C1 五字段（exportedAt / appName / appVersion /
//    packaged / mode）+ 黑名单核心 0 命中（复用 verify:sensitive 黑名单核心——第 8 条类别级规则排除，结构哈希非秘密命中面）
//    + truncated 标志 + 段级 sha 与顶层同值 + 审计 diagnostics:exported）
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'
import { SECRET_BLACKLIST } from '../../scripts/verify-sensitive-core.mjs'

let app: ElectronApplication
let page: Page
let userData = ''
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })

/** 审计 JSONL 路径（audit-lifecycle.spec 同款日期文件名） */
const auditFile = (): string => {
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return join(userData, 'Cyrene', 'audit', `audit-${key}.jsonl`)
}
const readAudit = (): string => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }

/** main 侧 isDevToolsOpened 观测（主窗口 = URL 以 cyrene://renderer 开头者——DevTools detach 窗口非主窗口） */
const isDevToolsOpened = (): Promise<boolean> =>
  app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('cyrene://renderer'))
    return w ? w.webContents.isDevToolsOpened() : false
  })

/** harness 导出文件路径（CYRENE_TEST_HARNESS=1 → dirs.temp 固定名，spec D7A-10） */
const exportFile = (): string => join(userData, 'Cyrene', 'temp', 'cyrene-diagnose-test.json')

/** 黑名单核心（D7A-14 七条=verify:sensitive 前七条；类别级 base64-long-string 排除——brief 明列
 *  「黑名单核心或简单正则」口径）。
 *
 *  2026-09-10 审查更正：原注记称「导出含 sha256/logHash 结构哈希必然类别命中」，该理由在
 *  `verify-sensitive-core.mjs` 于 2026-09-10 收窄 base64-long-string 规则（`isSecretLikeBase64` 要求
 *  同时含大写+小写+数字）之后**已不成立**——导出里的 sha256 是小写十六进制（本文件下文断言 /^[0-9a-f]{64}$/），
 *  不再匹配该规则。排除保留为**冗余保险**（规则将来再放宽时仍不误报），而非必要项。
 *  注：这里只取 `r.re`，丢掉了规则的 `accept` 谓词，因此这七条不完全等同于扫描器实际执行的规则。 */
const EXPORT_SECRET_RULES = SECRET_BLACKLIST.map((r) => r.re).slice(0, 7)

describe('诊断设置 IPC（spec §6.2/§9）', () => {
  it('state：displayDir 为脱敏展示形态（非绝对路径、不含原始 userData）', async () => {
    const st = await page.evaluate(() => window.desktopApi.diagnosticsState())
    expect(typeof st.devMode).toBe('boolean')
    // displayDir = createSanitizePublicMessage(dirs.logs) 后形态（home→~、userData→<userData>、其他绝对路径→<path>）
    expect(st.displayDir).not.toMatch(/^\//)                 // 非绝对路径（Linux）
    expect(st.displayDir).not.toMatch(/^[A-Za-z]:[\\/]/)     // 非绝对路径（Windows 盘符）
    expect(st.displayDir).toContain('<')                     // 脱敏标志（<userData>/<path> 或 ~ 前缀）
    expect(st.displayDir).not.toContain(userData)            // 原始 userData 路径不上行（安全复核 M-2）
    expect(typeof st.logSizeBytes).toBe('number')
    // app.log 由运行日志 writer 异步批量落盘（5s flushInterval——append 仅入内存缓冲 + fd 按 flush 打开）：
    // 轮询至文件在盘（启动日志 app:user-data-ready 等首轮 flush 后可见——防 5s 内读态竞态）
    await expect.poll(
      async () => (await page.evaluate(() => window.desktopApi.diagnosticsState())).logFiles.some((f) => f.name === 'app.log'),
      { timeout: 10_000, interval: 300 },
    ).toBe(true)
    expect(st.retentionDays).toBeGreaterThan(0)
    expect(st.auditRetentionDays).toBeGreaterThan(0)
    expect(typeof st.eventDropped).toBe('number')
  })

  it('dev-mode-set：webContents.isDevToolsOpened() 轮询 true → false（spec §9 明列）+ 审计 dev:mode-changed', async () => {
    // 开启：二次确认在 pane 层（UI 防误触）——wire 层唯一开启路径为 Main `diagnostics:dev-mode-set`
    await page.evaluate(() => window.desktopApi.diagnosticsDevModeSet(true))
    // 轮询（openDevTools detach 为异步窗口创建——xvfb 下可创建）
    await expect.poll(isDevToolsOpened, { timeout: 10_000, interval: 200 }).toBe(true)
    const stOn = await page.evaluate(() => window.desktopApi.diagnosticsState())
    expect(stOn.devMode).toBe(true)
    // 关闭（幂等集回 false——窗口关闭 + 会话态复位）
    await page.evaluate(() => window.desktopApi.diagnosticsDevModeSet(false))
    await expect.poll(isDevToolsOpened, { timeout: 10_000, interval: 200 }).toBe(false)
    const stOff = await page.evaluate(() => window.desktopApi.diagnosticsState())
    expect(stOff.devMode).toBe(false)
    // 审计（audit writer sync 写——直读 poll）
    await expect.poll(() => readAudit(), { timeout: 5000, interval: 200 }).toContain('"type":"dev:mode-changed"')
  })

  it('clear-logs：state.lastCleanup 回显（removedFiles/freedBytes）+ 审计 diagnostics:logs-cleared', async () => {
    await page.evaluate(() => window.desktopApi.diagnosticsClearLogs())
    // 清空结果经 state 刷新回显（spec §6.2：清空结果经 state 附带，不造第二响应形状）
    await expect.poll(async () => page.evaluate(() => window.desktopApi.diagnosticsState()), { timeout: 5000, interval: 200 })
      .toMatchObject({ lastCleanup: { removedFiles: expect.any(Number), freedBytes: expect.any(Number) } })
    const st = await page.evaluate(() => window.desktopApi.diagnosticsState())
    expect(st.lastCleanup!.removedFiles).toBeGreaterThanOrEqual(0)
    expect(st.lastCleanup!.freedBytes).toBeGreaterThanOrEqual(0)
    expect(st.logSizeBytes).toBeLessThanOrEqual(16 * 1024) // 清理后走 0 附近（后续启动日志重积小量——宽阈值防 flake）
    await expect.poll(() => readAudit(), { timeout: 5000, interval: 200 }).toContain('"type":"diagnostics:logs-cleared"')
  })

  it('export：harness 落 temp 固定名 + manifest F-C1 五字段 + 黑名单核心 0 命中 + truncated 标志 + 审计', async () => {
    // 注：app.log 可能已被 clear 用例清空且其后无新日志（清后无 append——批量 writer 不重开文件），
    // 导出收集对缺失/空文件优雅降级（logFiles 允许空段）；审计段为 sync 写必在（dev-mode/logs-cleared 事件行）。
    const res = await page.evaluate(() => window.desktopApi.diagnosticsExport())
    expect(res).toMatchObject({ cancelled: false })
    if (!res.cancelled) {
      expect(res.displayPath).toBe(exportFile())
      expect(res.sizeBytes).toBeGreaterThan(0)
      expect(res.truncatedLog).toBe(false) // 早启动小日志：既无超 5MiB 尾读也无 >3 文件
      expect(res.truncatedAudit).toBe(false)
      const raw = readFileSync(res.displayPath, 'utf8')
      const doc = JSON.parse(raw) as {
        schemaVersion: number
        manifest: {
          schemaVersion: number
          truncated: boolean
          truncatedLog: boolean
          truncatedAudit: boolean
          droppedLines: number
          logSha256: string
          auditSha256: string
          exportedAt: string
          appName: string
          appVersion: string
          packaged: boolean
          mode: string
        }
        summary: Record<string, unknown>
        logFiles: Array<{ name: string; lines: string[] }>
        audit: string[]
        logSha256: string
        auditSha256: string
      }
      // manifest 字段（D7A-08 + F-C1 五字段钉住——brief 验收面）
      expect(doc.schemaVersion).toBe(1)
      expect(doc.manifest.schemaVersion).toBe(1)
      expect(doc.manifest.appName).toBe('Cyrene')
      expect(typeof doc.manifest.appVersion).toBe('string')
      expect(doc.manifest.appVersion.length).toBeGreaterThan(0)
      expect(doc.manifest.exportedAt).toMatch(/T\d\d:\d\d/)        // ISO 时间形态
      expect(doc.manifest.packaged).toBe(false)                     // 集成跑 --mode test 产物（非打包）
      expect(doc.manifest.mode).toBe('test')                        // __APP_MODE__ 构建模式（非后端装配 mock）
      expect(doc.manifest.truncatedLog).toBe(false)
      expect(doc.manifest.truncatedAudit).toBe(false)
      expect(doc.manifest.truncated).toBe(false)
      expect(typeof doc.manifest.droppedLines).toBe('number')
      expect(doc.manifest.logSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(doc.manifest.auditSha256).toMatch(/^[0-9a-f]{64}$/)
      // 段内容健全：logFiles 为文件数组（可能为 0 空——清日志后无新 append 属预期）+ audit 段为行数组
      expect(Array.isArray(doc.logFiles)).toBe(true)
      for (const f of doc.logFiles) { expect(typeof f.name).toBe('string'); expect(Array.isArray(f.lines)).toBe(true) }
      expect(Array.isArray(doc.audit)).toBe(true)
      expect(doc.audit.length).toBeGreaterThan(0)
      // 段级 sha 与 manifest 同值（§6.5：sha 双读面兼容）
      expect(doc.logSha256).toBe(doc.manifest.logSha256)
      expect(doc.auditSha256).toBe(doc.manifest.auditSha256)
      // —— 黑名单核心 0 命中（D7A-14 七条；导出即二次脱敏后形态——兑现 doc 11 §8.1「导出前二次脱敏」）——
      for (const re of EXPORT_SECRET_RULES) {
        const hit = raw.match(re)
        expect(hit).toBeNull()
      }
      // sanitize 性：原始绝对路径（userData 根）不得出现在导出内容（displayPath 回显仅 IPC 面）
      expect(raw).not.toContain(userData)
    }
    // 审计 diagnostics:exported（sizeBytes/truncated——summary 无路径，F-5 同纪律）
    await expect.poll(() => readAudit(), { timeout: 5000, interval: 200 }).toContain('"type":"diagnostics:exported"')
  })
})
