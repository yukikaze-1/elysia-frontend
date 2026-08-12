import { describe, expect, it, vi } from 'vitest'
import { createCredentialsExecutors } from '../../src/main/credentials'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import { BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY } from '../../src/shared/contracts'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { CredentialStore } from '../../src/main/credentials/credential-store'

const noopSanitize = (m: string): string => m
const fakeLogger: Logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) }
function makeExecutors(store: unknown) {
  return createCredentialsExecutors(store as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize })
}
function makeExecutorsWithAudit(store: unknown, audit = vi.fn()) {
  return { executors: createCredentialsExecutors(store as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize, audit }), audit }
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
  it('BACKEND_TOKEN_KEY → 委派 connConfig.setBackendToken（store.setCredential 未被调）', async () => {
    const config = { setBackendToken: vi.fn(async () => {}), clearBackendToken: vi.fn(async () => {}) }
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const executors = createCredentialsExecutors(store as unknown as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize }, config as never)
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 't' })
    expect(config.setBackendToken).toHaveBeenCalledWith('t')
    expect(store.setCredential).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, data: { status: 'available', key: 'backend.token' } })
  })
  it('BACKEND_TOKEN_KEY clear → 委派 connConfig.clearBackendToken', async () => {
    const config = { setBackendToken: vi.fn(async () => {}), clearBackendToken: vi.fn(async () => {}) }
    const store = { getStatus: vi.fn(async () => 'empty'), clearCredential: vi.fn(async () => {}) }
    const executors = createCredentialsExecutors(store as unknown as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize }, config as never)
    await executors.clear({ key: BACKEND_TOKEN_KEY })
    expect(config.clearBackendToken).toHaveBeenCalled()
    expect(store.clearCredential).not.toHaveBeenCalled()
  })
  it('非白名单 key → schema 拒绝（SCHEMA_VALIDATION_FAILED，不触 store/config）', async () => {
    const config = { setBackendToken: vi.fn(async () => {}), clearBackendToken: vi.fn(async () => {}) }
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const executors = createCredentialsExecutors(store as unknown as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize }, config as never)
    const res = await executors.set({ key: 'app.foo', value: 'v' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(store.setCredential).not.toHaveBeenCalled()
    expect(config.setBackendToken).not.toHaveBeenCalled()
  })
  it('BACKEND_TOKEN_ORIGIN_KEY → 拒绝（绑定 origin 仅经连接配置内部维护）', async () => {
    const config = { setBackendToken: vi.fn(async () => {}), clearBackendToken: vi.fn(async () => {}) }
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const executors = createCredentialsExecutors(store as unknown as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize }, config as never)
    const res = await executors.set({ key: BACKEND_TOKEN_ORIGIN_KEY, value: 'https://a.example' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INVALID_INPUT')
    expect(store.setCredential).not.toHaveBeenCalled()
    expect(config.setBackendToken).not.toHaveBeenCalled()
  })
})

describe('审计（FE-S1-P1-01）', () => {
  it('set 成功 → audit credential:set success', async () => {
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:set', status: 'success' }))
  })
  it('set 失败 → audit credential:set failed + 原错误仍返回（不吞错）', async () => {
    const store = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const { executors, audit } = makeExecutorsWithAudit(store)
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:set', status: 'failed', summary: expect.stringContaining('CREDENTIAL_UNAVAILABLE') }))
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
  it('set 后 status 变化 → audit credential:status-change', async () => {
    const store = { getStatus: vi.fn(async () => 'available').mockResolvedValueOnce('empty'), setCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:status-change', summary: expect.stringContaining('from=empty') }))
  })
  it('clear 成功 → audit credential:clear success', async () => {
    const store = { getStatus: vi.fn(async () => 'empty'), clearCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.clear({ key: BACKEND_TOKEN_KEY })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:clear', status: 'success' }))
  })
  it('audit 抛错 → set 仍 ok:true（fail-open 不翻转操作结果）', async () => {
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const { executors } = makeExecutorsWithAudit(store, vi.fn(() => { throw new Error('audit boom') }))
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toEqual({ ok: true, data: { status: 'available', key: 'backend.token' } })
  })
  it('set 失败且 audit 抛错 → 仍返回原错误（audit 不替换错误）', async () => {
    const store = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const { executors } = makeExecutorsWithAudit(store, vi.fn(() => { throw new Error('audit boom') }))
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
})
