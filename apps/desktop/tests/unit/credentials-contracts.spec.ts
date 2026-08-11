// tests/unit/credentials-contracts.spec.ts
import { describe, expect, it } from 'vitest'
import { BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY, CREDENTIAL_KEY_ALLOWLIST, isKeyAllowed } from '../../src/shared/contracts/credentials'

describe('credentials contracts', () => {
  it('allowlist 当前 backend.token + backend_token_origin', () => {
    expect(CREDENTIAL_KEY_ALLOWLIST).toEqual(['backend.token', 'backend_token_origin'])
  })
  it('BACKEND_TOKEN_KEY 在 allowlist 内', () => {
    expect(isKeyAllowed(BACKEND_TOKEN_KEY)).toBe(true)
  })
  it('BACKEND_TOKEN_ORIGIN_KEY 在白名单且与 BACKEND_TOKEN_KEY 并列', () => {
    expect(isKeyAllowed(BACKEND_TOKEN_ORIGIN_KEY)).toBe(true)
    expect(BACKEND_TOKEN_ORIGIN_KEY).not.toBe(BACKEND_TOKEN_KEY)
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
