// tests/integration/electron-tools.spec.ts
// 阶段 6 批次 B（Task 8 / F-6-24）：Desktop 工具流集成——拒绝/允许/取消/写冲突/backend 只读/capture 软断言。
// 纪律：断言走 expect.poll（POLL 常数对齐套件先例）、bounding box 真点击禁 force（L1 规范）；
// 真输入 getByLabel('消息输入框')（对齐 electron-voice 先例，代码 M6）；
// wire 断言经 __cyreneMainProbe（Main 侧探针，完整 M10）；核心闭环不做降级（spec R1），capture 软断言（SwiftShader 降级条款）。
import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'   // readFileSync：H14
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 5000, interval: 200 }
const FIXTURE_ROOT = '/tmp/cyrene-fixtures'
const FIXTURE = `${FIXTURE_ROOT}/note.txt`
const FLOW_READ = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: FIXTURE } } })

async function ensureFixture(content = 'hello fixture\n'): Promise<void> {
  mkdirSync(FIXTURE_ROOT, { recursive: true }); writeFileSync(FIXTURE, content)
}
afterEach(() => { rmSync(FIXTURE_ROOT, { recursive: true, force: true }) })

/** 点连接 → 激活首个会话（conv-1001）→ 输入框就绪（对齐 electron-voice 先例 connectAndActivateFirst） */
async function connectAndActivateFirst(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true), POLL).toBe(false)
}

async function sendMessage(page: import('playwright').Page): Promise<void> {
  await page.getByLabel('消息输入框').fill('读取我的笔记')
  await page.getByLabel('消息输入框').press('Enter')
}
/** 探针读取（统一收口，避免重复 page.evaluate 样板） */
async function probeStatus(page: import('playwright').Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const s = (window as unknown as { __cyreneTest: { getToolState(): { liveOrder: string[]; records: Record<string, { status: string }> } } }).__cyreneTest.getToolState()
    return s.liveOrder.map(id => s.records[id].status).find(st => ['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(st))
  })
}

describe('阶段 6 批次 B 工具流', () => {
  it('桌面工具：拒绝 → 卡片「用户已拒绝」+ wire rejected（__cyreneMainProbe）', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]) } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-deny').click()    // 拒绝按钮（对等权重）
    await expect.poll(() => probeStatus(page), POLL).toBe('rejected')
    // wire 断言：Main 探针读 MockBackend.lastToolStatus（完整 M10）
    await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { __cyreneMainProbe: { getLastToolStatus(): unknown } }).__cyreneMainProbe.getLastToolStatus()), POLL)
      .toEqual(expect.objectContaining({ status: 'rejected' }))
    await closeApp(launched)
  })

  it('桌面工具：允许一次 → 执行 fixture → 卡片「执行完成」+ 归档', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]) } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()          // 卡片授权入口 → 权限窗（四问）
    await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(1)
    await page.getByTestId('approval-allow').click()        // 允许一次
    await expect.poll(() => probeStatus(page), POLL).toBe('completed')
    await closeApp(launched)
  })

  it('取消路径：点击取消任务 → 已取消 + wire cancelled', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]) } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-cancel').click()           // 取消按钮独立 v-if（awaiting 态可用，H13）
    await expect.poll(() => probeStatus(page), POLL).toBe('cancelled')
    await expect.poll(() => launched.app.evaluate(() => (globalThis as unknown as { __cyreneMainProbe: { getLastToolStatus(): unknown } }).__cyreneMainProbe.getLastToolStatus()), POLL)
      .toEqual(expect.objectContaining({ status: 'cancelled' }))
    await closeApp(launched)
  })

  it('写冲突 → FILE_CONFLICT → 卡片「执行失败」+ 原文件不变（spec §3.13 核心闭环，A-6）', async () => {
    await ensureFixture('v1\n')
    const flow = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.write', arguments: { path: FIXTURE, content: 'v2\n' } } })
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: flow, CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]) } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(1)
    writeFileSync(FIXTURE, 'v3\n')   // 授权后、执行前外部修改（预读 hash 与原子替换前不一致）
    await page.getByTestId('approval-allow').click()
    await expect.poll(() => probeStatus(page), POLL).toBe('failed')
    expect(readFileSync(FIXTURE, 'utf8')).toBe('v3\n')   // 原文件不变
    await closeApp(launched)
  })

  it('Backend 工具只读卡片（无授权入口）', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'backend', started: { toolName: 'search_web' }, completed: { success: true, outputSummary: 'ok' } }) } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getToolState(): { records: Record<string, { status: string }> } } }).__cyreneTest.getToolState().records['tc_mock_backend_1']?.status), POLL).toBe('completed')
    expect(await page.getByTestId('tool-approve').count()).toBe(0)
    expect(await page.getByTestId('tool-deny').count()).toBe(0)
    await closeApp(launched)
  })

  it('capture 流程（软断言）：允许 → 源选择 → 预览 → 确认上传 → 终态（A-21/B-1）', async () => {
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.screen.capture', arguments: {} } }),
      CYRENE_MOCK_CAPTURE_SOURCES: JSON.stringify([{ sourceId: 'screen:0', sourceName: '屏幕 1' }]),
    } })
    const page = launched.page
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()
    await page.getByTestId('approval-allow').click()
    await expect.poll(() => page.getByTestId('capture-source').count(), POLL).toBe(1)
    await page.getByTestId('capture-source').click()
    await expect.poll(() => page.getByTestId('capture-confirm').count(), POLL).toBe(1)
    await page.getByTestId('capture-confirm').click()
    await expect.poll(() => probeStatus(page), POLL).toBe('completed')
    await closeApp(launched)
  })
})
