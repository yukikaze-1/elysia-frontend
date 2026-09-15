// tests/integration/electron-live2d-context-loss.spec.ts
// J 取证（2026-09-15 Live2D 评审 L5）：**GPU 上下文丢失 → 自动重建之后，画布还画得出来吗？**
//
// 为什么单独一个文件：L5 是**疑似**结论——评审的推理是「`adapter.destroy()` 不清 framework 的
// 按-context 着色器缓存，而 `restoreContext()` 恢复的是**同一个** `WebGLRenderingContext` 对象，
// 于是重建后 `loadShaders()` 命中旧 Map 键、跳过重新编译，绘制用已失效的 program ⇒
// 状态显示"就绪"而画面空白」。既有的 Live2D 集成用例只断言「draw 调用次数/非透明像素」，
// 而**没有任何用例在触发 context lost 之后**复查像素 —— 所以套件全绿**不能**反证本条。
//
// 本文件的断言口径（刻意区分两种失败，避免"采不到"被当成"真空白"）：
//   ① `countNonTransparentPx` 必须 !== -1（采样有效：画布存在且可 drawImage）；
//   ② 重建**之后**的非透明像素必须 > 0。
// 若 ② 失败而 ① 成立 ⇒ **L5 被证实**（状态就绪但画面空白），修法是让 destroy/unload 与 context
// 生命周期对齐（`CubismFramework.dispose()` / `doStaticRelease()`）；若 ② 通过 ⇒ 在本环境下 L5 不成立，
// 结论按"未复现"如实记录，不据此改渲染代码。
//
// 装配与观测原语复用 helpers/live2d-fixture.ts（与 electron-live2d-core/-motion 同一套）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { closeApp } from './helpers/app'
import {
  POLL, installLive2dMaster, teardownLive2dMaster, freshUserData, launchL2d,
  statusText, waitLive2dSettled, countNonTransparentPx, connectAndActivateFirst
} from './helpers/live2d-fixture'

let haruInstalled = false

beforeAll(async () => { haruInstalled = (await installLive2dMaster()).haru }, 120_000)
afterAll(() => { teardownLive2dMaster() })

/** 让渲染面的 WebGL 上下文丢失（Chromium 的 WEBGL_lose_context 扩展）。返回是否成功发出。 */
async function loseWebglContext(page: import('playwright').Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
    if (!canvas) return false
    // 同一个 canvas 上再次 getContext 会拿到既有上下文（不会新建），故这里拿到的是渲染器正在用的那个
    const gl = canvas.getContext('webgl') ?? canvas.getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_lose_context')
    if (!ext) return false
    ext.loseContext()
    return true
  })
}

describe('J 取证：GPU 上下文丢失后自动重建（L5 疑似的判据）', () => {
  it('L5：上下文丢失 → 自动重建 → 画布必须仍有非透明像素（否则即"状态就绪但画面空白"）', async () => {
    expect(haruInstalled, '本用例需要 haru 模型（否则无从谈重建后的画面）').toBe(true)
    const launched = await launchL2d(freshUserData())
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 与 electron-live2d-motion 同款前置：连上 Mock 后端并激活首个会话，渲染环才会真正推进
      await connectAndActivateFirst(page)
      // ① 基线：重建前必须真的在画。
      // **必须轮询**：`preserveDrawingBuffer:false` 时 WebGL 画布在合成后会被清空，一次性采样可能读到空缓冲
      // （本轮实测：同一次运行里轮询到 20365px，紧随其后的一次性采样读到 0）——故断言用 poll，
      // 单独取一次只为日志读数，不作断言。
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 8000 }).toBeGreaterThan(0)
      const before = await countNonTransparentPx(page)

      const lost = await loseWebglContext(page)
      expect(lost, 'WEBGL_lose_context 必须可用（拿不到就说明这条取证路径不成立，不能当成通过）').toBe(true)

      // ② 等自动重建落定：状态回到"就绪"（或按既有口径落到回退/失败——那也是可观测结局）
      await expect.poll(() => statusText(page), { ...POLL, timeout: 15_000 }).toMatch(/就绪|回退|失败/)
      const settled = await statusText(page)

      // ③ 关键断言：采样必须有效（与"真空白"区分开）。同样用轮询——理由见 ① 的缓冲清空说明；
      //    这里轮询的是"是否有画面"，若 8s 内始终为 0 则失败，那正是 L5 的判据。
      const after = await countNonTransparentPx(page)
      // 取证读数必须可见：本用例的价值在于"哪一支成立"，而不是"最终是绿的"。
      // （此前那条 lil 夹具的教训：分支静默不执行时，绿等于没测。）
      console.log(`[l5-context-loss] status=${settled} before=${before}px after=${after}px`)
      expect(after, `采样无效（-1）：无法判定画面；status=${settled}`).not.toBe(-1)

      if (settled.includes('就绪')) {
        // 只有"声称就绪"这一支才承载 L5 的判据：状态说就绪，画面就必须有东西。
        // 用轮询而不是一次性采样（同上：缓冲可能在合成后被清空）——8s 内始终无像素才算 L5 成立。
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 8000 })
          .toBeGreaterThan(0)
      } else {
        // 回退/失败支：不声称可用，画面为空是预期（写实记录，不当作 L5 证据）
        expect(after, '回退/失败支不应有画面（有则说明状态与画面不一致，另案）').toBe(0)
      }
    } finally { await closeApp(launched) }
  })
})
