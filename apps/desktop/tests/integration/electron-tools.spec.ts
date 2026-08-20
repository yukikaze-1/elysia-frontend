// tests/integration/electron-tools.spec.ts
// 阶段 6 批次 B（Task 8 / F-6-24）+ 批次 C（Task 8 / D6C）：Desktop 工具流集成——拒绝/允许/取消/写冲突/backend 只读/capture 软断言
// + 目录授权闭环（read 自动执行/write 只读 Diff/撤销/审批历史跳转撤销/命令模板空态/黑名单目录拒/后端身份不匹配）。
// 纪律：断言走 expect.poll（POLL 常数对齐套件先例）、bounding box 真点击禁 force（L1 规范）；
// 真输入 getByLabel('消息输入框')（对齐 electron-voice 先例，代码 M6）；
// wire 断言经 __cyreneMainProbe（Main 侧探针，完整 M10）；核心闭环不做降级（spec R1），capture 软断言（SwiftShader 降级条款）。
// 批次 C：mock env 桥 CYRENE_MOCK_GRANT_DIRECTORY（单个 JSON 字符串路径，F-9）+ CYRENE_MOCK_GRANT_BACKEND_IDENTITY
// （V-2 惰性读取——测试中途经 app.evaluate 翻转 Main 进程 env 可观测）；设置页入口无 settings-open testid，
// 沿用套件先例 getByRole('设置'/'关闭设置') + .cy-settings-nav-item（对齐 electron-live2d/electron-voice）。
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

// ============ 阶段 6 批次 C（Task 8 / D6C）：目录授权与审批历史 ============

/** 批次 C 公共流：发送 → 权限窗（卡片「允许此电脑操作」打开）→ 「允许指定目录」→ 确认授权 → grant 命中自动执行 → 完成。
 *  grant 匹配目录 = mock env CYRENE_MOCK_GRANT_DIRECTORY（F-9 单个 JSON 字符串路径）；默认 TTL 24h（F-18）。 */
async function grantDirFlow(page: import('playwright').Page): Promise<void> {
  await sendMessage(page)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
  await page.getByTestId('tool-approve').click()           // 卡片授权入口 → 权限窗（四问）
  await expect.poll(() => page.getByTestId('approval-grant-dir').count(), POLL).toBe(1)
  await page.getByTestId('approval-grant-dir').click()     // 第三入口「允许指定目录」（仅 read/write 显示）
  await page.getByTestId('approval-grant-confirm').click() // 确认授权（默认 24h）
  await expect.poll(() => probeStatus(page), POLL).toBe('completed')   // grant 命中 → 自动执行
}

/** 打开设置中心 → 「安全与权限」子页（批次 C 无 settings-open/nav-security testid——沿用套件先例：
 *  getByRole('设置') 打开 + .cy-settings-nav-item hasText 定位子页，对齐 electron-live2d/electron-voice） */
async function openSecurityPane(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
  await page.locator('.cy-settings-nav-item', { hasText: '安全与权限' }).click()
}

/** 关闭设置中心（✕ 关闭按钮，确定性——对齐 electron-voice 先例；Escape 键重渲染瞬间偶有丢失） */
async function closeSettings(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
}

/** wire 探针读 lastToolStatus（Main 侧 MockBackend.lastToolStatus，完整 M10）——callId 自增序列 call_mock_<n>（A3） */
async function lastToolStatus(app: import('playwright').ElectronApplication): Promise<{ status?: string; callId?: string } | null> {
  return (await app.evaluate(() => (globalThis as unknown as { __cyreneMainProbe: { getLastToolStatus(): { status?: string; callId?: string } | null } }).__cyreneMainProbe.getLastToolStatus())) ?? null
}

describe('阶段 6 批次 C 目录授权与审批历史', () => {
  it('目录授权闭环（read）：允许指定目录 → 自动执行；再次触发同目录 read 无权限窗 + wire result（D6C-05/F-1）', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),       // fixture 在黑名单 /tmp 内 → allowRoots 放宽
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),        // mock pickDirectory 返回授权目录（F-9）
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await grantDirFlow(page)        // 第一次 → 权限窗 → 授权 → grant 命中自动执行
    await sendMessage(page)         // 第二次 → 同目录 grant 命中 → 自动执行（无权限窗）
    await expect.poll(() => lastToolStatus(launched.app), POLL)
      .toEqual(expect.objectContaining({ status: 'result', callId: 'call_mock_2' }))   // 第二次确已自动执行（wire result）
    expect(await page.getByTestId('tool-approval').count()).toBe(0)     // 无权限窗
    expect(await probeStatus(page)).toBe('completed')                   // 卡片「执行完成」
    await closeApp(launched)
  })

  it('目录授权闭环（write + 只读 Diff）：授权写目录 → 再次 write 无权限窗 + 卡片只读 Diff（无确认按钮）', async () => {
    await ensureFixture()   // 'hello fixture\n'（与 content 'v2\n' 产生 Diff）
    const flow = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.write', arguments: { path: FIXTURE, content: 'v2\n' } } })
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: flow,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await grantDirFlow(page)        // 第一次 → 授权 → 自动执行（完成记录携带 diff，F-7 契约）
    await sendMessage(page)         // 第二次 → grant 命中自动执行
    await expect.poll(() => lastToolStatus(launched.app), POLL)
      .toEqual(expect.objectContaining({ status: 'result', callId: 'call_mock_2' }))
    expect(await page.getByTestId('tool-approval').count()).toBe(0)                 // 无权限窗
    expect(await page.getByTestId('tool-diff-readonly').count()).toBeGreaterThan(0) // 卡片只读 Diff 信息条（F-4）
    expect(await page.getByTestId('approval-diff').count()).toBe(0)                 // 无确认按钮（approval-diff 仅权限窗）
    await closeApp(launched)
  })

  it('授权撤销：建立 grant → 设置页撤销 → 再次触发 read 权限窗重现 + wire 未自动执行', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await grantDirFlow(page)                  // 建立 grant（read）
    await openSecurityPane(page)
    await expect.poll(() => page.getByTestId('grant-revoke').count(), POLL).toBe(1)   // 授权管理列表出现撤销按钮
    await page.getByTestId('grant-revoke').click()                                    // 撤销
    await expect.poll(() => page.getByTestId('grant-revoked-source').count(), POLL).toBe(1)   // 卡片转「已撤销」
    await closeSettings(page)
    await sendMessage(page)                   // 再触发
    await expect.poll(() => page.getByTestId('tool-approve').count(), POLL).toBe(1)   // 权限窗重现（卡片 awaiting）
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('tool-approval').count(), POLL).toBe(1)  // 四问窗打开
    await expect.poll(() => lastToolStatus(launched.app), POLL)
      .toEqual(expect.objectContaining({ status: 'accepted', callId: 'call_mock_2' }))  // 仅 accepted，未自动执行（非 result）
    await closeApp(launched)
  })

  it('审批历史查看器（F-21）：tool:decision 入历史 + 工具过滤 + 历史跳转撤销 → grant 失效', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await grantDirFlow(page)                  // 建立 grant → tool:decision(allow_scoped) 入审计
    await openSecurityPane(page)
    await expect.poll(() => page.locator('[data-testid="history-list"] li').count(), POLL).toBeGreaterThan(0)   // 审批历史条目出现
    await page.selectOption('[data-testid="history-tool-filter"]', 'desktop.file.read')                          // 工具过滤
    await expect.poll(() => page.locator('[data-testid="history-list"] li').count(), POLL).toBeGreaterThan(0)   // read 过滤仍有条目
    await expect.poll(() => page.getByTestId('history-jump-revoke').count(), POLL).toBe(1)   // allow_scoped + 授权活动 → 跳转撤销按钮
    await page.getByTestId('history-jump-revoke').click()                                  // 撤销此授权（F-21）
    await expect.poll(() => page.getByTestId('history-jump-revoke').count(), POLL).toBe(0) // 撤销后按钮消失（activeGrant false）
    await closeSettings(page)
    await sendMessage(page)
    await expect.poll(() => page.getByTestId('tool-approve').count(), POLL).toBe(1)        // 撤销后权限窗重现（卡片 awaiting）
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('tool-approval').count(), POLL).toBe(1)
    await closeApp(launched)
  })

  it('命令模板空态（F-08 关闭）：desktop.command.run 未注册 → 空态文案', async () => {
    const launched = await launchApp(undefined, { env: {} })   // 无需工具 flow
    const { page } = launched
    await connectAndActivateFirst(page)
    await openSecurityPane(page)
    const empty = await page.getByTestId('command-templates-empty').textContent()
    expect(empty).toContain('未启用受控命令执行')
    await closeApp(launched)
  })

  it('黑名单目录拒：mock pickDirectory /etc → 授权失败（PATH_BLOCKLISTED）→ 权限窗保持打开 + 错误提示 + 卡片保持 awaiting', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify('/etc'),   // 黑名单目录（PATH_BLOCKLIST_DEFAULTS 含 /etc，allowRoots 不含）
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('approval-grant-dir').count(), POLL).toBe(1)
    await page.getByTestId('approval-grant-dir').click()
    await page.getByTestId('approval-grant-confirm').click()   // add 抛 PATH_BLOCKLISTED → IPC 结构化错误上提（F-17）
    await expect.poll(() => page.locator('.cy-approval-grant-error').count(), POLL).toBe(1)   // 错误提示出现在权限窗
    const err = await page.locator('.cy-approval-grant-error').textContent()
    expect(err).toContain('黑名单')
    const pending = await page.evaluate(() => (window as unknown as { __cyreneTest: { getPermissionPending(): unknown } }).__cyreneTest.getPermissionPending())
    expect(pending).not.toBeNull()   // 无 grant 落盘、权限窗未关闭 → 卡片保持 awaiting
    await closeApp(launched)
  })

  it('后端身份不匹配（N-3/F-2）：授权后翻转 mock 身份 → grant 不再命中 → 权限窗重现（测试末复位 env）', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
      CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
    } })
    const { page } = launched
    await connectAndActivateFirst(page)
    await grantDirFlow(page)   // 建立 grant（绑定身份 mock://local，F-5 固定常量）
    // 翻转 mock 身份（V-2 惰性读取：闭包每次调用实时读 env——Main 进程 env 可经 app.evaluate 写）
    await launched.app.evaluate(() => { (process.env as Record<string, string | undefined>).CYRENE_MOCK_GRANT_BACKEND_IDENTITY = 'http://other' })
    await sendMessage(page)
    await expect.poll(() => page.getByTestId('tool-approve').count(), POLL).toBe(1)   // 身份不匹配 → 权限窗重现（卡片 awaiting）
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('tool-approval').count(), POLL).toBe(1)
    await expect.poll(() => lastToolStatus(launched.app), POLL)
      .toEqual(expect.objectContaining({ status: 'accepted', callId: 'call_mock_2' }))   // 未自动执行
    // 测试末复位（V-2 隔离：防残留 grant 命中后续用例）
    await launched.app.evaluate(() => { delete (process.env as Record<string, string | undefined>).CYRENE_MOCK_GRANT_BACKEND_IDENTITY })
    await closeApp(launched)
  })
})
