// tests/unit/safe-storage.spec.ts
import { describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential, isSafeStorageUsable, isValidBase64 } from '../../src/main/credentials/safe-storage'
import { CyreneErrorCode } from '../../src/shared/errors'

function fakeSafe(over: Partial<Record<string, unknown>> = {}): any {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    ...over
  }
}

describe('isValidBase64', () => {
  it('合法 base64 通过', () => {
    expect(isValidBase64('AQID')).toBe(true)
    expect(isValidBase64('AQIDBA==')).toBe(true)
  })
  it('非法字符 / 长度 %4 拒绝', () => {
    expect(isValidBase64('AQI*')).toBe(false)   // 非法字符
    expect(isValidBase64('AQI')).toBe(false)     // 长度非 4 倍数
    expect(isValidBase64('AQ===')).toBe(false)   // 多个 pad
  })
})

describe('isSafeStorageUsable', () => {
  it('isEncryptionAvailable=false → 不可用', () => {
    expect(isSafeStorageUsable(fakeSafe({ isEncryptionAvailable: () => false }))).toBe(false)
  })
  it('linux + basic_text → 不可用（明文降级拒存）', () => {
    expect(isSafeStorageUsable(fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }))).toBe(false)
  })
  it('linux + gnome_libsecret → 可用', () => {
    expect(isSafeStorageUsable(fakeSafe({ getSelectedStorageBackend: () => 'gnome_libsecret' }))).toBe(true)
  })
  it('非 linux 不调用 getSelectedStorageBackend（未提供该方法的 fake 不崩）', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const safe: any = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('x'), decryptString: () => 'x' }
      expect(isSafeStorageUsable(safe)).toBe(true) // 不访问 getSelectedStorageBackend
    } finally { Object.defineProperty(process, 'platform', { value: orig }) }
  })
})

describe('encrypt/decrypt', () => {
  it('往返一致', () => {
    const safe = fakeSafe()
    const enc = encryptCredential(safe, 'secret-token')
    expect(decryptCredential(safe, enc)).toBe('secret-token')
  })
  it('decryptString 抛错 → 抛 CREDENTIAL_LOCKED', () => {
    const safe = fakeSafe({ decryptString: () => { throw new Error('keyring locked') } })
    try { decryptCredential(safe, Buffer.from('AQID')); expect.unreachable() }
    catch (e: any) { expect(e.code).toBe(CyreneErrorCode.CREDENTIAL_LOCKED) }
  })
})
