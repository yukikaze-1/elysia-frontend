// tests/integration/window-load-failure.spec.ts
// C 批（2026-09-16 审计 P2）：主 frame 加载失败此前**零处理点**——只有 `loadURL(...).catch` 留一行日志，
// 用户看到的是**无提示白屏**，且没有任何恢复入口。本用例在真实 Electron 里制造一次主 frame 加载失败
// （导航到 cyrene:// 下不存在的路径），断言"用户可见提示"真的发生了。
//
// 观测面：Main 侧 harness 探针 `__cyreneMainProbe.getDialogInvocations()`（silent 测试窗口模式下
// dialog-service 只记录调用并转 stderr，不会弹窗打扰宿主桌面）。这是"提示存在"的直接证据，
// 而不是"代码里有这么一段"的转述。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string

beforeAll(async () => {
  ({ app, page, userData } = await launchApp())
})
afterAll(async () => {
  await closeApp({ app, page, userData })
})

/** 一次对话框调用记录（与 native-ui/dialog-service.ts 的 DialogInvocation 白名单字段一致） */
interface DialogInvocation { kind: string; title?: string; message?: string; shown: boolean }

describe('主 frame 加载失败 → 有用户可见提示（而不是无提示白屏）', () => {
  it('主 frame 导航到连不上的地址 → 记录 error-box 调用（含标题/正文），且 silent 下未真弹窗', async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      // 制造一次**真正的加载失败**（ERR_CONNECTION_REFUSED：本机 1 端口必然拒绝）。
      // 注：cyrene:// 下的 404 **不会**触发本路径——协议 handler 返回的是带 404 状态的响应，
      // 渲染进程会把它当"加载完成"（页面显示 404 正文），故那种形态不产生 did-fail-load。
      await win.loadURL('http://127.0.0.1:1/__cyrene_unreachable__').catch(() => {})
    })
    await expect
      .poll(async () => app.evaluate(() => {
        const probe = (globalThis as unknown as { __cyreneMainProbe?: { getDialogInvocations(): unknown } }).__cyreneMainProbe
        const list = (probe?.getDialogInvocations() ?? []) as DialogInvocation[]
        return list.filter((i) => i.kind === 'error-box').length
      }), { timeout: 20000, interval: 500 })
      .toBeGreaterThan(0)
    const boxes = await app.evaluate(() => {
      const probe = (globalThis as unknown as { __cyreneMainProbe?: { getDialogInvocations(): unknown } }).__cyreneMainProbe
      return ((probe?.getDialogInvocations() ?? []) as DialogInvocation[]).filter((i) => i.kind === 'error-box')
    })
    const loadFailure = boxes.find((b) => (b.title ?? '').includes('加载失败'))
    expect(loadFailure, `未记录「页面加载失败」提示；实际记录：${JSON.stringify(boxes)}`).toBeDefined()
    expect(loadFailure?.message ?? '').toContain('页面加载失败')
    expect(loadFailure?.shown).toBe(false)   // silent 测试窗口模式：记录调用但不弹窗
  })
})
