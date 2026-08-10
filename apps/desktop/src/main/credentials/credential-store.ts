// src/main/credentials/credential-store.ts
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { atomicWriteFile } from './atomic-write'
import { decryptCredential, encryptCredential, isSafeStorageUsable, isValidBase64, type SafeStorageLike } from './safe-storage'

export const CREDENTIAL_FILE_VERSION = 1 as const
export interface CredentialFileSchemaV1 {
  version: typeof CREDENTIAL_FILE_VERSION
  keys: Record<string, { enc: string; algo: 'safeStorage' }>
}

const EMPTY_FILE: CredentialFileSchemaV1 = { version: 1, keys: {} }

/** 顶层形状守卫：JSON 可解析但 keys 缺失/非对象（如 {"version":1}、keys:null）→ 视为损坏
 *  （version 值留待调用方判定——未知版本须走 UNSUPPORTED_VERSION，不能被当作损坏重建） */
function hasKeysShape(v: unknown): v is { version: number; keys: Record<string, unknown> } {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as { keys?: unknown }).keys === 'object' &&
    (v as { keys?: unknown }).keys !== null &&
    !Array.isArray((v as { keys?: unknown }).keys)
}

export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve()
  private cache = new Map<string, string>()

  constructor(
    private readonly filePath: string,
    private readonly safe: SafeStorageLike,
    private readonly isKeyAllowed: (key: string) => boolean,
    private readonly safeRoot: string
  ) {}

  /** 串行队列：.then(op, op) 两个参——任一 op reject 只影响该次，不毒化后续 op */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => {})
    return run
  }

  private async readFile(): Promise<CredentialFileSchemaV1 | null> {
    const { openSafeFile } = await import('../persistence/safe-open')
    let fd
    try {
      const r = await openSafeFile(this.filePath, { mode: 'existing', purpose: 'read', safeRoot: this.safeRoot })
      fd = r.fd
      const text = await fd.readFile('utf8')
      const parsed = JSON.parse(text) as unknown
      if (!hasKeysShape(parsed)) throw new Error('凭据文件形状非法') // 可解析但形状损坏 → 与 JSON 解析失败同语义（损坏）
      return parsed as CredentialFileSchemaV1
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e // JSON 解析失败 / 权限 / 逃逸 → 调用方按损坏或不可用处理
    } finally {
      await fd?.close().catch(() => {})
    }
  }

  async getStatus(key: string): Promise<'unavailable' | 'locked' | 'empty' | 'available'> {
    if (!this.isKeyAllowed(key)) return 'unavailable' // fail-closed（IPC zod 已拦，store 防御兜底）
    let file: CredentialFileSchemaV1 | null
    try { file = await this.readFile() } catch { return 'unavailable' } // JSON 损坏 / 权限
    if (file && file.version !== CREDENTIAL_FILE_VERSION) return 'unavailable' // 版本未知：读拒
    if (!isSafeStorageUsable(this.safe)) return 'unavailable' // 先于 empty
    if (!file) return 'empty'
    const block = file.keys[key]
    if (!block) return 'empty'
    if (typeof block !== 'object' || block === null || typeof (block as { enc?: unknown }).enc !== 'string') return 'unavailable' // 单 key 形状非法
    if (!isValidBase64(block.enc)) return 'unavailable' // 损坏 blob 不误归 locked
    try {
      const plaintext = decryptCredential(this.safe, Buffer.from(block.enc, 'base64'))
      this.cache.set(key, plaintext)
      return 'available'
    } catch {
      this.cache.delete(key) // 解密失败即清缓存
      return 'locked'
    }
  }

  async setCredential(key: string, plaintext: string): Promise<void> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    await this.enqueue(async () => {
      if (!isSafeStorageUsable(this.safe)) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '系统钥匙串不可用')
      let file: CredentialFileSchemaV1
      try { file = (await this.readFile()) ?? EMPTY_FILE } catch { file = EMPTY_FILE } // 损坏 → 整文件重建
      if (file.version !== CREDENTIAL_FILE_VERSION) throw new CyreneError(CyreneErrorCode.UNSUPPORTED_VERSION, '凭据文件版本不受支持')
      const enc = encryptCredential(this.safe, plaintext).toString('base64')
      file.keys[key] = { enc, algo: 'safeStorage' }
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2), { safeRoot: this.safeRoot })
      this.cache.set(key, plaintext)
    })
  }

  async getCredential(key: string): Promise<string | null> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    if ((await this.getStatus(key)) === 'available') return this.cache.get(key) ?? null
    return null // unavailable/locked/empty → 无明文可给
  }

  async clearCredential(key: string): Promise<void> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    await this.enqueue(async () => {
      let file: CredentialFileSchemaV1
      try { file = (await this.readFile()) ?? EMPTY_FILE } catch { file = EMPTY_FILE } // 损坏 → 整文件重建（丢其他键，契约注明）
      if (file.version !== CREDENTIAL_FILE_VERSION) throw new CyreneError(CyreneErrorCode.UNSUPPORTED_VERSION, '凭据文件版本不受支持')
      delete file.keys[key]
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2), { safeRoot: this.safeRoot })
      this.cache.delete(key)
    })
  }
}
