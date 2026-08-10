import { describe, expect, it, vi } from 'vitest'
import { createCredentialsExecutors } from '../../src/main/credentials'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import { BACKEND_TOKEN_KEY } from '../../src/shared/contracts'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { CredentialStore } from '../../src/main/credentials/credential-store'

const noopSanitize = (m: string): string => m
const fakeLogger: Logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) }
function makeExecutors(store: unknown) {
  return createCredentialsExecutors(store as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize })
}

describe('createCredentialsExecutors', () => {
  it('get-status 固定查 BACKEND_TOKEN_KEY（0 参）', async () => {
    const store = { getStatus: vi.fn(async () => 'empty') }
    const res = await makeExecutors(store).getStatus(undefined)
    expect(res).toEqual({ ok: true, data: { status: 'empty', key: 'backend.token' } })
    expect(store.getStatus).toHaveBeenCalledWith('backend.token')
  })
  it('set 成功 → 响应 {status,key}（value 不回显）', async () => {
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const res = await makeExecutors(store).set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toEqual({ ok: true, data: { status: 'available', key: 'backend.token' } })
    expect(store.setCredential).toHaveBeenCalledWith('backend.token', 'sk-x')
  })
  it('set 抛 CREDENTIAL_UNAVAILABLE → 信封 ok:false（preload 据此抛错而非 undefined status）', async () => {
    const store = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const res = await makeExecutors(store).set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
  it('非法 key → SCHEMA_VALIDATION_FAILED（allowlist refine 拦）', async () => {
    const res = await makeExecutors({}).clear({ key: 'evil' })
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })
  it('clear 成功 → 响应 {status,key}', async () => {
    const store = { getStatus: vi.fn(async () => 'empty'), clearCredential: vi.fn(async () => {}) }
    const res = await makeExecutors(store).clear({ key: BACKEND_TOKEN_KEY })
    expect(res).toEqual({ ok: true, data: { status: 'empty', key: 'backend.token' } })
  })
})
