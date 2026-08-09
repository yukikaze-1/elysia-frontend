// tests/unit/credentials-channels.spec.ts
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/contracts'
import { credentialsSetSchema, credentialsClearSchema, credentialStatusSchema } from '../../src/main/ipc/channels'

describe('credentials channels', () => {
  it('通道常量已注册', () => {
    expect(IpcChannels.credentialsGetStatus).toBe('credentials:get-status')
    expect(IpcChannels.credentialsSet).toBe('credentials:set')
    expect(IpcChannels.credentialsClear).toBe('credentials:clear')
  })
  it('set schema：合法 key+value 通过', () => {
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'sk-x' }).success).toBe(true)
  })
  it('set schema：非白名单 key 拒绝（allowlist 单一来源）', () => {
    expect(credentialsSetSchema.safeParse({ key: 'evil.key', value: 'x' }).success).toBe(false)
  })
  it('set schema：空 value / 超长 value 拒绝', () => {
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: '' }).success).toBe(false)
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'x'.repeat(4097) }).success).toBe(false)
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'x'.repeat(4096) }).success).toBe(true)
  })
  it('clear schema：合法 key 通过、非法拒绝', () => {
    expect(credentialsClearSchema.safeParse({ key: 'backend.token' }).success).toBe(true)
    expect(credentialsClearSchema.safeParse({ key: 'nope' }).success).toBe(false)
  })
  it('status schema：4 值合法、非法值拒绝、key refine', () => {
    for (const s of ['unavailable', 'locked', 'empty', 'available'] as const) {
      expect(credentialStatusSchema.safeParse({ status: s, key: 'backend.token' }).success).toBe(true)
    }
    expect(credentialStatusSchema.safeParse({ status: 'weird', key: 'backend.token' }).success).toBe(false)
    expect(credentialStatusSchema.safeParse({ status: 'empty', key: 'bad.key' }).success).toBe(false)
  })
})
