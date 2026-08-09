// src/main/credentials/safe-storage.ts
import { type SafeStorage } from 'electron'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

export type SafeStorageLike = Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'>

/** 严格 base64 校验：Node Buffer.from(s,'base64') 宽容（非法字符不抛、截断可解），不做严格校验损坏 blob 会误归 locked */
export function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0
}

/**
 * safeStorage 可用性：isEncryptionAvailable() 且（仅 Linux）非 basic_text 后端。
 * basic_text 是硬编码 key 的弱加密明文降级，按 doc16 §4.0「不可用即拒存」视为不可用。
 * Windows/macOS 不调用 getSelectedStorageBackend()（Electron 标注 Linux-only，非 Linux 行为未定义）。
 */
export function isSafeStorageUsable(safe: SafeStorageLike): boolean {
  if (!safe.isEncryptionAvailable()) return false
  if (process.platform === 'linux') return safe.getSelectedStorageBackend() !== 'basic_text'
  return true
}

export function encryptCredential(safe: SafeStorageLike, plaintext: string): Buffer {
  return safe.encryptString(plaintext)
}

/** 解密失败（keyring 锁/解密失败）→ 抛 CREDENTIAL_LOCKED（状态归 locked，不重试） */
export function decryptCredential(safe: SafeStorageLike, encrypted: Buffer): string {
  try {
    return safe.decryptString(encrypted)
  } catch {
    throw new CyreneError(CyreneErrorCode.CREDENTIAL_LOCKED, '系统钥匙串锁定或解密失败')
  }
}
