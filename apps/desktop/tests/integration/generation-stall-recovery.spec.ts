// tests/integration/generation-stall-recovery.spec.ts
// H-10（2026-09-11）：后端**真的卡住**时，界面必须自己走出来。
//
// 这是本批唯一能证明「用户不再被永久卡住」的端到端证据。单测已钉住看门狗逻辑与 store 接线，
// 但它们证明不了「真实事件流经真实 store 后 UI 真的收敛」——H-04 那批就因为 e2e 断言选错对象
// 而恒绿过一次，故此处必须有真机证据。
//
// 怎么造出真卡住：`CYRENE_MOCK_STALL_GENERATION=1` 使发送触发的生成**只发夹具首条
// `generation.started` 然后彻底静默**（mock-backend.ts 的 stallGeneration）。这正是评审描述的
// 「后端卡住或丢终态」。该注入只影响发送路径（scheduleReplay 仅被 send/sendVoiceCommit 调用），
// 握手不受影响，故用例仍能正常登录到可用状态。
//
// 判据取**用户可见**的三件事，而非内部状态：
//   ① 流式占位「正在输入…」出现（证明确实进入了生成中）；
//   ② 一个静默窗口后它**自己消失**（证明用户不再被永久卡住——没有修复时它会一直在）；
//   ③ 停止按钮消失、输入框恢复可用（活动代已释放）。
//
// 注意：本用例必须真的等满静默窗口（50s），因为窗口长度是产品决定，不该为测试缩短——
// 缩短会让测试不再覆盖上线时真正生效的那个值。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

/** 恢复预算：必须明显大于 50s 静默窗口，同时给慢启动留余量 */
const RECOVERY_BUDGET_MS = 90_000

let launched: LaunchedApp
let page: Page
/** 现场采集：应用/页面在等待期间消失时必须能说清「什么时候、因为什么」 */
const events: string[] = []
let startedAt = 0
const stamp = (): string => `${Date.now() - startedAt}ms`

/**
 * 局部轮询——**不能用 `expect.poll`**：它只能在 test 体内调用，在 beforeAll 里会抛
 * “expect.poll() must be called inside a test”，且该异常的表象是后续 locator 报
 * “Target page has been closed”（本轮实测踩到，真实原因被表象掩盖过一次）。
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}${last ? ` — 最后一次错误：${String(last)}` : ''}`)
}

beforeAll(async () => {
  startedAt = Date.now()
  launched = await launchApp(undefined, { env: { CYRENE_MOCK_STALL_GENERATION: '1' } })
  page = launched.page
  page.on('close', () => events.push(`${stamp()} page:close`))
  page.on('crash', () => events.push(`${stamp()} page:crash`))
  page.on('pageerror', (e) => events.push(`${stamp()} pageerror:${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') events.push(`${stamp()} console.error:${m.text().slice(0, 200)}`) })
  launched.app.on('close', () => events.push(`${stamp()} app:close`))
  // 连接 + 激活首个会话（对齐套件既有先例；此处用局部 waitFor 而非 expect.poll）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await waitFor(
    async () => ((await page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? '')) ?? '').includes('已连接'),
    20_000, '连接成功'
  )
  await waitFor(async () => (await page.locator('.cy-conversation').count()) > 0, 20_000, '会话列表出现')
  await page.locator('.cy-conversation-main').first().click()
  // 激活必须真正完成，输入框才会出现（对齐 electron-live2d.spec.ts 的 connectAndActivateFirst：
  // 那边也是先等 .cy-chat-heading h2 出现标题）
  await waitFor(
    async () => ((await page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? '')) ?? '').length > 0,
    30_000, '会话标题出现（激活完成）'
  )
  // 不再自己等「输入框可用」：`fill`/`click` 自带 auto-wait（等可编辑/可点击），
  // 手写轮询反而引入了一个我解释不了的假超时（诊断显示超时瞬间元素明明已 enabled）。
}, 150_000)

afterAll(async () => { if (launched) await closeApp(launched) })

describe('生成静默看门狗（H-10）端到端', () => {
  it('后端卡住 → 界面自行走出「生成中」，不再永久滞留', async () => {
    const input = page.locator('textarea[aria-label="消息输入框"]')
    // 用**真实按键**而非 fill：fill 只设 DOM value + 派发一次 input，而本组件的 v-model 走
    // draftStore（computed get/set），实测该路径下 canSend 仍为 false（DOM 有文本、store 草稿为空）。
    // 真实按键逐字触发 input，与用户实际输入一致，故用它。
    await input.click()
    await input.pressSequentially('这条消息会触发一次卡住的生成', { delay: 10 })
    const sendBtn = page.getByRole('button', { name: '发送', exact: true })
    try {
      await sendBtn.click({ timeout: 20_000 })
    } catch (err) {
      const diag = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>('.cy-send-btn')
        const rect = btn?.getBoundingClientRect()
        const cs = btn ? getComputedStyle(btn) : null
        return {
          sendDisabled: btn?.disabled ?? null,
          sendOuterHTML: btn?.outerHTML ?? null,
          sendBox: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) } : null,
          sendStyle: cs ? { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents } : null,
          roleMatchCount: [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '发送').length,
          gen: (window as unknown as { __cyreneTest?: { getGenerationState: () => unknown } }).__cyreneTest?.getGenerationState() ?? null
        }
      })
      throw new Error(`发送按钮不可点诊断：${JSON.stringify(diag)}（原始：${String(err)}）`)
    }

    // ① 确实进入了生成中（started 是夹具首条，立即到达）
    await waitFor(async () => (await page.locator('.cy-streaming-placeholder').count()) === 1, 20_000, '出现「正在输入…」占位')
    expect(await page.locator('.cy-stop-btn').count(), '生成中应显示停止按钮').toBe(1)

    // ② 静默窗口到期后自行收敛——**没有修复时这一步会一直失败**（占位永远在）
    try {
      await waitFor(
        async () => (await page.locator('.cy-streaming-placeholder').count()) === 0,
        RECOVERY_BUDGET_MS, '静默窗口到期后「正在输入…」自行消失'
      )
    } catch (err) {
      throw new Error(`恢复失败：${String(err)}\n时间线：${events.join(' | ')}\n生成态：${
        await page.evaluate(() => JSON.stringify((window as unknown as { __cyreneTest?: { getGenerationState: () => unknown } }).__cyreneTest?.getGenerationState() ?? null)).catch((e) => `页面不可用：${String(e)}`)
      }`)
    }

    // ③ 活动代已释放：停止按钮消失、没有残留的流式气泡、输入框恢复可编辑
    expect(await page.locator('.cy-stop-btn').count(), '停止按钮应随活动代释放而消失').toBe(0)
    expect(await page.locator('.cy-assistant-row.is-streaming').count(), '不得仍有流式中的助手气泡').toBe(0)
    // 用 locator.isEditable()（Playwright 的断言匹配器 toBeEditable 属于 @playwright/test 的 expect，
    // 与本仓库 vitest 的 chai expect 不是同一个——实测报 `Invalid Chai property: toBeEditable`）
    await waitFor(async () => input.isEditable(), 15_000, '输入框恢复可编辑')
  }, 150_000)
})
