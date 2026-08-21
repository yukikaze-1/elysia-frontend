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

  it('enables Chromium CORS processing so the handler origin allowlist can decide dev fetches', () => {
    registerCyreneScheme()

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'cyrene',
        privileges: expect.objectContaining({
          supportFetchAPI: true,
          corsEnabled: true,
          bypassCSP: false
        })
      })
    ])
  })
})
