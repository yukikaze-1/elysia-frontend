// tests/integration/renderer-error-diagnostics.spec.ts
// P1-12 / M-01（2026-09-11）：renderer 侧 JS 错误必须**真的落进诊断日志**。
//
// 这是本项的收敛证据。单测已钉住 sink 的过滤/限流/截断，但证明不了「真实 Electron 里
// renderer 的 console.error 会经 console-message 到达 Main 的 logger 并落盘」——
// 而这恰好是本项的原始诉求（诊断包里能看到 renderer 侧故障）。
//
// 为什么必须有这条 e2e（本轮实测教训）：`WebContents.on('console-message')` 在 Electron 43 里
// 参数在**事件对象自身**上、level 是**字符串**；若照 d.ts 的废弃位置参数写，`(e, details)` 会把
// details 推成 number，且 `'error' >= 3` 恒 false ⇒ **一条都不会转发**。单元测试用假 details 可以全绿，
// 只有真机才能证伪。故此处直接读 Main 的日志文件。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
let page: Page

/** 读取 userData 下全部日志文本（logs 目录，JSONL） */
function readLogs(userData: string): string {
  const logsDir = join(userData, 'Cyrene', 'logs')
  if (!existsSync(logsDir)) return ''
  return readdirSync(logsDir)
    .filter((name) => name.endsWith('.log') || name.endsWith('.jsonl'))
    .map((name) => { try { return readFileSync(join(logsDir, name), 'utf8') } catch { return '' } })
    .join('\n')
}

/** 局部轮询（expect.poll 不能在 beforeAll 用；此处也在 test 内使用以便读文件） */
async function waitForLog(userData: string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readLogs(userData).includes(needle)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

beforeAll(async () => {
  launched = await launchApp()
  page = launched.page
  // 连接 + 激活首个会话（对齐套件既有先例）
  await page.getByRole('button', { name: /REAL|MOCK/ }).first().click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.waitForFunction(() => (document.querySelector('.cy-status-text')?.textContent ?? '').includes('已连接'), null, { timeout: 20_000 })
}, 120_000)

afterAll(async () => { if (launched) await closeApp(launched) })

describe('renderer 错误进诊断日志（P1-12 / M-01）', () => {
  it('renderer 的 console.error 经 console-message 落进 Main 日志（修复前：完全不在诊断包里）', async () => {
    const marker = 'CY_RENDERER_PROBE_MARKER'
    await page.evaluate((m) => { console.error(m) }, marker)

    const found = await waitForLog(launched.userData, marker, 20_000)
    const logs = readLogs(launched.userData)
    expect(found, `renderer 的 console.error 未落进日志（诊断包缺 renderer 侧故障）。日志尾部：\n${logs.slice(-1500)}`).toBe(true)
    // 同时必须是本项新增的那条结构化记录（而不是碰巧被别处记下）
    expect(logs, '应出现 renderer:console-error 结构化记录').toContain('renderer:console-error')
  }, 60_000)

  it('未捕获的 renderer 异常（window error）同样进日志——不依赖组件层是否插桩', async () => {
    const marker = 'CY_RENDERER_THROW_MARKER'
    await page.evaluate((m) => { setTimeout(() => { throw new Error(m) }, 0) }, marker)

    const found = await waitForLog(launched.userData, marker, 20_000)
    expect(found, '未捕获异常应经 renderer 的 window error → console.error → console-message 进日志').toBe(true)
  }, 60_000)

  it('诊断面能看到日志目录，且日志里确实带着 renderer 记录（导出内容的一部分）', async () => {
    // 注意：preload 的 diagnosticsState 经 unwrap 返回**数据本身**（不是 {ok,data} 信封）——
    // 我第一版按信封断言，得到 `expected undefined to be true`（断言写错，不是产品问题）。
    const state = await page.evaluate(async () => {
      const api = (window as unknown as { desktopApi: { diagnosticsState: () => Promise<{ displayDir?: string }> } }).desktopApi
      return api.diagnosticsState()
    })
    expect(typeof state?.displayDir, '诊断状态应返回（displayDir 已 sanitize、不含绝对路径）').toBe('string')
    expect(readLogs(launched.userData), '日志文件确实带着 renderer 侧记录').toContain('renderer:console-error')
  })
})
