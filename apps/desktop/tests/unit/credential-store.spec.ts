// tests/unit/credential-store.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CredentialStore, createEmptyFile } from '../../src/main/credentials/credential-store'
import type { SafeStorageLike } from '../../src/main/credentials/safe-storage'
import { CyreneErrorCode } from '../../src/shared/errors'
import { isKeyAllowed } from '../../src/shared/contracts'

/** 测试直读私有 filePath（避免为测试改公开 API） */
function filePathOf(s: CredentialStore): string { return (s as unknown as { filePath: string }).filePath }

/** 假 safeStorage：enc:前缀往返；decrypt 可注入失败 */
function fakeSafe(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    ...over
  }
}
function makeStore(over: { file?: string; safe?: SafeStorageLike; safeRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cy-creds-'))
  return new CredentialStore(over.file ?? join(root, 'credentials.json'), over.safe ?? fakeSafe(), isKeyAllowed, over.safeRoot ?? root)
}

describe('getStatus', () => {
  it('文件缺失 → empty', async () => {
    expect(await makeStore().getStatus('backend.token')).toBe('empty')
  })
  it('safeStorage 不可用 → unavailable（先于 empty：basic_text 新机返回 unavailable 而非 empty）', async () => {
    const store = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    expect(await store.getStatus('backend.token')).toBe('unavailable')
  })
  it('版本未知 → unavailable（读拒）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 99, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('JSON 损坏 → unavailable（clear/set 可重建）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), '{oops', { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('可解析但形状非法（无 keys）→ unavailable（不抛 TypeError）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1 }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('可解析但形状非法（keys 非对象）→ unavailable', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1, keys: null }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('单 key 块 enc 非法（null / 非字符串）→ unavailable（非 locked）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1, keys: { 'backend.token': { enc: null, algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
    const s2 = makeStore()
    writeFileSync(filePathOf(s2), JSON.stringify({ version: 1, keys: { 'backend.token': 'garbage' } }), { mode: 0o600 })
    expect(await s2.getStatus('backend.token')).toBe('unavailable')
  })
  it('base64 非法 → unavailable（非 locked）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'AQI*', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('decrypt 抛错 → locked（keyring 锁）', async () => {
    const safe = fakeSafe({ decryptString: () => { throw new Error('locked') } })
    const s = makeStore({ safe })
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('locked')
  })
  it('可读 → available', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'sk-secret')
    expect(await s.getStatus('backend.token')).toBe('available')
  })
})

describe('setCredential', () => {
  it('set 后文件 0600 + version:1 + 每 key 加密块', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    const raw = JSON.parse(readFileSync(filePathOf(s), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.keys['backend.token'].algo).toBe('safeStorage')
    expect(raw.keys['backend.token'].enc).toBe(Buffer.from('enc:tok').toString('base64'))
    expect((await import('fs')).statSync(filePathOf(s)).mode & 0o777).toBe(0o600)
  })
  it('safeStorage 不可用 → 抛 CREDENTIAL_UNAVAILABLE 且不落盘明文', async () => {
    const s = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    await expect(s.setCredential('backend.token', 'plaintext')).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
    const { existsSync } = await import('fs')
    expect(existsSync(filePathOf(s))).toBe(false)
  })
  it('非白名单 key → 抛 INVALID_INPUT', async () => {
    await expect(makeStore().setCredential('evil.key', 'x')).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
  })
  it('版本未知 → 抛 UNSUPPORTED_VERSION（写路径拒绝，不覆盖未来格式）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 2, keys: {} }), { mode: 0o600 })
    await expect(s.setCredential('backend.token', 'x')).rejects.toMatchObject({ code: CyreneErrorCode.UNSUPPORTED_VERSION })
  })
  it('损坏文件 → 写全新文件（整文件重建，只含本 key）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), '{corrupt', { mode: 0o600 })
    await s.setCredential('backend.token', 'fresh')
    const raw = JSON.parse(readFileSync(filePathOf(s), 'utf8'))
    expect(raw.keys['backend.token']).toBeTruthy()
  })
  it('重叠 set 串行化不丢更新（队列）', async () => {
    const s = makeStore()
    await Promise.all([
      s.setCredential('backend.token', 'a'),
      s.setCredential('backend.token', 'b')
    ])
    expect(await s.getCredential('backend.token')).toBe('b')
  })
})

describe('getCredential / clearCredential', () => {
  it('getCredential 返回明文（仅 Main 内部）', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    expect(await s.getCredential('backend.token')).toBe('tok')
  })
  it('解密失败清缓存 → 后续 getCredential 返回 null（不返回陈旧明文）', async () => {
    let fail = false
    const safe = fakeSafe({ decryptString: (b: Buffer) => { if (fail) throw new Error('locked'); return b.toString().replace(/^enc:/, '') } })
    const s = makeStore({ safe })
    await s.setCredential('backend.token', 'tok')
    fail = true
    expect(await s.getStatus('backend.token')).toBe('locked') // getStatus 解密失败 → 清缓存 + locked
    expect(await s.getCredential('backend.token')).toBe(null) // 缓存已清，重解密失败 → null
  })
  it('clear 移除 key、清缓存', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    await s.clearCredential('backend.token')
    expect(await s.getStatus('backend.token')).toBe('empty')
    expect(await s.getCredential('backend.token')).toBe(null)
  })
  it('clear 遇损坏文件 → 写全新空文件（整文件重建）', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), '{corrupt', { mode: 0o600 })
    await s.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync(filePathOf(s), 'utf8'))
    expect(raw).toEqual({ version: 1, keys: {} })
  })
  it('clear 遇版本未知 → 抛 UNSUPPORTED_VERSION', async () => {
    const s = makeStore()
    writeFileSync(filePathOf(s), JSON.stringify({ version: 3, keys: {} }), { mode: 0o600 })
    await expect(s.clearCredential('backend.token')).rejects.toMatchObject({ code: CyreneErrorCode.UNSUPPORTED_VERSION })
  })
  it('safeStorage 不可用但文件可解析 → clear 仍可移除（不需解密）', async () => {
    const s = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    writeFileSync(filePathOf(s), JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    await s.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync(filePathOf(s), 'utf8'))
    expect(raw.keys['backend.token']).toBeUndefined()
  })
})

describe('EMPTY_FILE 工厂', () => {
  it('createEmptyFile 每次返回全新对象', () => {
    const a = createEmptyFile()
    const b = createEmptyFile()
    expect(a).not.toBe(b)
    a.keys['backend.token'] = { enc: 'x', algo: 'safeStorage' }
    expect(b.keys).toEqual({})
  })
  it('多 key 损坏重建互不污染（自定义 allowlist）', async () => {
    const allow = (k: string) => k === 'backend.token' || k.startsWith('model.')
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-mk-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), allow, root)
    const storeB = new CredentialStore(file, fakeSafe(), allow, root)
    await storeA.setCredential('backend.token', 'a')
    await storeA.setCredential('model.llm.key', 'llm')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.setCredential('model.stt.key', 'stt')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.keys['model.stt.key']).toBeTruthy()
    expect(raw.keys['backend.token']).toBeUndefined()
    expect(raw.keys['model.llm.key']).toBeUndefined()
  })
  it('两个 Store 单 key 损坏重建回归守卫', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-2s-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    const storeB = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    await storeA.setCredential('backend.token', 'a')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.setCredential('backend.token', 'b')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.keys['backend.token'].enc).toBe(Buffer.from('enc:b').toString('base64'))
  })
  it('两个 Store 单 key 损坏重建回归守卫（clear 变体）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-cl-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    const storeB = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    await storeA.setCredential('backend.token', 'a')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw).toEqual({ version: 1, keys: {} })
  })
})
