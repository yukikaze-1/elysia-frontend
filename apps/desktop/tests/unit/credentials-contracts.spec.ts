// tests/unit/credentials-contracts.spec.ts
import { describe, expect, it } from 'vitest'
import { BACKEND_TOKEN_KEY, CREDENTIAL_KEY_ALLOWLIST, isKeyAllowed } from '../../src/shared/contracts/credentials'

describe('credentials contracts', () => {
  it('allowlist 当前仅 backend.token', () => {
    expect(CREDENTIAL_KEY_ALLOWLIST).toEqual(['backend.token'])
  })
  it('BACKEND_TOKEN_KEY 在 allowlist 内', () => {
    expect(isKeyAllowed(BACKEND_TOKEN_KEY)).toBe(true)
  })
  it('任意非白名单 key 拒绝', () => {
    expect(isKeyAllowed('backend.token2')).toBe(false)
    expect(isKeyAllowed('')).toBe(false)
    expect(isKeyAllowed('model.llm.openai')).toBe(false) // model.* 预留未激活
  })
  it('model.* 通配语义在 allowlist 结构上可表达（预留，未激活）', () => {
    expect(isKeyAllowed('model.llm.openai')).toBe(false)
  })
})
