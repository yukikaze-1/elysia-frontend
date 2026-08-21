import { beforeEach, describe, expect, it, vi } from 'vitest'

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn()
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

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'cyrene',
        privileges: expect.objectContaining({
          supportFetchAPI: true,
          corsEnabled: false,
          bypassCSP: false
        })
      })
    ])
  })
})
