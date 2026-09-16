// tests/integration/gpu-fallback.spec.ts
//
// 2026-09-16 审计 P2 / 立项（A + B）：Linux 无 GPU 的硬件加速回退——**应用层**证据。
//
// 判定矩阵已由 `tests/unit/runtime-environment.spec.ts` 钉死（那是"算出来的结论"）；
// 本 spec 补的是另一半：**这个结论有没有真的被应用到 Electron 命令行上**。
// 两者必须分开验——本仓反复出现过"能力写在文档/算在函数里，但没接到执行点"的同型缺陷
// （沙盒目录层、退出前 flush、`clientMessageId` 上行都是这一族）。
//
// 为什么只做"正向"（显式 disable ⇒ 开关存在）而不做"缺省不得加"的反向断言：
// **Linux 上反向断言恒假**——测试脚手架自己的 `defaultGlArgs` 就会注入 `--disable-gpu`
// （那是 X99 取证后的测试侧修复）。在 Linux CI 上 `hasSwitch('disable-gpu')` 与被测代码无关地恒为 true，
// 写这条反向用例只会得到一个永远不会因本代码变红的假断言。"缺省不干预"因此留在单测矩阵里覆盖。
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp } from './helpers/app'

describe('GPU 回退的应用层证据（2026-09-16 审计 P2）', () => {
  it('CYRENE_GPU_MODE=disable ⇒ 真实 Electron 进程的命令行里确实带上了 disable-gpu', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_GPU_MODE: 'disable' } })
    try {
      const hasSwitch = await launched.app.evaluate(({ app }) => app.commandLine.hasSwitch('disable-gpu'))
      expect(hasSwitch, '显式要求软件渲染时必须真的落到命令行上（决策算出来 ≠ 已应用）').toBe(true)
    } finally {
      await closeApp(launched)
    }
  })

  it('回退生效后应用照常可用：启动链完整、窗口与 renderer 都正常', async () => {
    // 防的是"加了开关反而起不来"——回退的价值必须是"能跑"，而不只是"没崩"。
    const launched = await launchApp(undefined, { env: { CYRENE_BACKEND: 'real', CYRENE_GPU_MODE: 'disable' } })
    try {
      const mode = await launched.page.evaluate(async () => (await window.desktopApi.getRuntimeInfo()).mode)
      expect(mode).toBe('real')
      const status = await launched.page.evaluate(async () => (await window.desktopApi.getConnectionState()).status)
      expect(status).toBe('disconnected')   // 未连接属正常初态（本用例只验启动链完整）
    } finally {
      await closeApp(launched)
    }
  })
})
