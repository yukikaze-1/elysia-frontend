// tests/integration/real-assembly.spec.ts
//
// 2026-09-16 审计 P1-4 / 立项 AUD-02（方案 A）：**real 装配在真实 Electron 中至少被启动过，且它的
// fail-closed 面被断言**。
//
// 缺口背景：42 个集成 spec 此前 100% 观测 mock 装配，且 `CYRENE_BACKEND:'mock'` 写在 `opts.env` 之后
// **不可被调用方覆盖**；而打包产物恒为 real（`config/backend-mode.ts`）——**用户唯一会运行的形态在
// Electron 层零覆盖**，"集成全绿"这个信号的含义因此被系统性高估。
//
// 🔴 本 spec 的**设计约束（报告没提，本轮复核发现）**：CI 里跑 Electron 的 runner 是 **Linux + xvfb**，
// 那里 `safeStorage` 是 `basic_text` ⇒ 判不可用 ⇒ 拒存；既有凭据往返用例在该环境直接
// `return { skipped: true }`（`ipc-security.spec.ts:141,157-164`）。因此**任何依赖「已存 token」的 real
// 冒烟都会在 CI 上被静默跳过**——那正是"绿灯含义被高估"的同型陷阱。
// ⇒ 本 spec **全部免凭据**：只断言"real 装配确实起来了"与"它在缺凭据时 fail-closed"，
// 这两件事不需要 token 就能真跑，因此在 Linux CI 上是真的在跑，而不是 skip。
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp } from './helpers/app'

/** 经 preload 的真实 IPC 读运行期模式（不是读 env，也不是读渲染层状态） */
async function readMode(page: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }): Promise<string> {
  return page.evaluate(async () => (await window.desktopApi.getRuntimeInfo()).mode)
}

describe('real 装配的 Electron 冒烟（AUD-02 方案 A：免凭据、CI 真跑不 skip）', () => {
  it('打包形态的装配（CYRENE_BACKEND=real）在真实 Electron 中启动，且运行期模式确为 real', async () => {
    // 这一条的意义：证明 harness 的覆盖真的生效了，且 real 装配能过完整启动链
    // （Main 装配 → preload → renderer 水合），而不是只证明"mock 能启动"。
    const launched = await launchApp(undefined, { env: { CYRENE_BACKEND: 'real' } })
    try {
      expect(await readMode(launched.page)).toBe('real')
    } finally {
      await closeApp(launched)
    }
  })

  it('缺省（不覆盖）仍是 mock——放开覆盖不能把既有 42 个 spec 的观测面悄悄换掉', async () => {
    const launched = await launchApp()
    try {
      expect(await readMode(launched.page)).toBe('mock')
    } finally {
      await closeApp(launched)
    }
  })

  it('real 装配下缺凭据时 connect **fail-closed**，且错误码可诊断（mock 永远走不到这条分支）', async () => {
    // 这是本 spec 最重要的一条：real 装配的错误面在 mock 下**结构性不可达**，
    // 而它恰是用户第一次使用时必然会遇到的路径（还没配 token 就点连接）。
    // 断言"必须失败且给出 CREDENTIAL_UNAVAILABLE"，而不是"必须成功"——所以整个用例不需要真后端、不需要凭据。
    const launched = await launchApp(undefined, { env: { CYRENE_BACKEND: 'real' } })
    try {
      const result = await launched.page.evaluate(async () => {
        // 先设一个端点：否则会先命中「请先设置后端地址」那条更早的门（同样是 CREDENTIAL_UNAVAILABLE，
        // 但我们要钉的是**凭据缺失**这一支，故把端点补上把判据收窄）。
        await window.desktopApi.setEndpoint('http://127.0.0.1:9/')
        try {
          await window.desktopApi.connect()
          return { threw: false, message: '' }
        } catch (e) {
          return { threw: true, message: e instanceof Error ? e.message : String(e) }
        }
      })

      expect(result.threw, 'real 装配缺凭据时必须拒绝连接，绝不能静默降级或假连').toBe(true)
      expect(result.message).toContain('CREDENTIAL_UNAVAILABLE')
    } finally {
      await closeApp(launched)
    }
  })

  it('real 装配下未连接即断开是安全的，且连接态保持 disconnected（不出现假 connected）', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_BACKEND: 'real' } })
    try {
      const state = await launched.page.evaluate(async () => {
        await window.desktopApi.disconnect().catch(() => { /* 未连接时允许抛，下面只看状态 */ })
        return await window.desktopApi.getConnectionState()
      })
      expect(state.status).toBe('disconnected')
    } finally {
      await closeApp(launched)
    }
  })
})
