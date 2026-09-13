import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomScheme } from 'electron'

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({
  // mock 按 Electron 的真实声明 `registerSchemesAsPrivileged(customSchemes: CustomScheme[])` 标注——
  // 裸 `vi.fn()` 的调用实参是 `any`（取 `mock.calls[0][0]` 即 no-unsafe-assignment）
  registerSchemesAsPrivileged: vi.fn<(customSchemes: CustomScheme[]) => void>()
}))

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged }
}))

import { registerCyreneScheme } from '../../src/main/protocol/scheme'

describe('cyrene protocol privileges', () => {
  beforeEach(() => {
    registerSchemesAsPrivileged.mockClear()
  })

  it('保持 corsEnabled=false（阶段 5 D-4：放开后非受信 origin 可读 cyrene:// 资源）', () => {
    registerCyreneScheme()

    // `expect.objectContaining` 的返回类型被 vitest 声明成 `any`（赋给变量即 no-unsafe-assignment）；
    // 改为按 Electron 的真实声明取实参断言
    const registered = registerSchemesAsPrivileged.mock.calls[0][0]
    const scheme = registered.find((s) => s.scheme === 'cyrene')
    expect(scheme).toBeDefined()
    expect(scheme?.privileges).toMatchObject({
      supportFetchAPI: true,
      corsEnabled: false,
      bypassCSP: false
    })
  })
})
