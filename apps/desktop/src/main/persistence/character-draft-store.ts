// FE-D2：未提交角色编辑草稿的 Main 持久化边界。
// 草稿只存于 app-cache，不进入 SessionStore、消息缓存、日志或诊断正文。
// 读取逐条校验、写入原子替换；所有文件路径都来自 user-data-dirs + safeRoot。
import { join, basename, relative, isAbsolute, sep } from 'node:path'
import { unlink, realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { CharacterDraftSummary, PersistedCharacterDraft } from '@shared/contracts'
import { CharacterDraftKeySchema, PersistedCharacterDraftSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { atomicWriteFile } from '../credentials/atomic-write'
import { openSafeFile } from './safe-open'
import { createCorruptIsolation, type CorruptIsolation } from './corrupt-isolation'
import type { Logger } from '../diagnostics/logger'
import { cloneValue } from '@shared/domain'

export const CHARACTER_DRAFT_FILE_NAME = 'character-drafts-v1.json'
export const CHARACTER_DRAFT_SCHEMA_VERSION = 1 as const
export const CHARACTER_DRAFT_MAX_ENTRIES = 10
export const CHARACTER_DRAFT_MAX_ENTRY_BYTES = 512 * 1024
export const CHARACTER_DRAFT_MAX_FILE_BYTES = 2 * 1024 * 1024

const CharacterDraftFileSchema = z.object({
  schemaVersion: z.literal(CHARACTER_DRAFT_SCHEMA_VERSION),
  // Do not reject the whole file merely because an older/crashed writer left
  // more than the current quota. Valid records are still isolated and the
  // deterministic newest-ten policy below keeps recovery useful.
  entries: z.array(z.unknown())
}).strict()

export interface CharacterDraftStoreDeps {
  appCache: string
  safeRoot: string
  logger: Logger
  countDiagnostic(code: string): void
  /** 单测可注入原子 writer；生产默认使用 atomicWriteFile。 */
  writer?: typeof atomicWriteFile
}

export interface CharacterDraftStorageError {
  code: typeof CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE
  operation: 'load' | 'save' | 'delete' | 'retry'
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

function compareEntries(left: PersistedCharacterDraft, right: PersistedCharacterDraft): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key)
}

function summaryOf(entry: PersistedCharacterDraft): CharacterDraftSummary {
  return {
    key: entry.key,
    mode: entry.mode,
    ...(entry.characterId !== undefined ? { characterId: entry.characterId } : {}),
    ...(entry.baseRevision !== undefined ? { baseRevision: entry.baseRevision } : {}),
    displayName: entry.displayName,
    updatedAt: entry.updatedAt
  }
}

function storageError(operation: CharacterDraftStorageError['operation']): CyreneError {
  return new CyreneError(
    CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE,
    '角色草稿本地存储暂不可用',
    { backendCode: CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE, operation }
  )
}

/**
 * Main 角色草稿仓库。
 *
 * `entries` 是当前进程的 last-known-good 快照；写请求通过一个 promise
 * tail 串行落盘。每次排队时捕获完整 JSON，因此同 key 的后写自然覆盖先写，
 * 失败也不会释放错误地释放另一笔写入的锁。
 */
export class CharacterDraftStore {
  private readonly file: string
  private readonly isolation: CorruptIsolation
  private readonly writer: typeof atomicWriteFile
  private entries = new Map<string, PersistedCharacterDraft>()
  private writeTail: Promise<void> = Promise.resolve()
  private lastError: CharacterDraftStorageError | undefined

  constructor(private readonly deps: CharacterDraftStoreDeps) {
    this.file = join(deps.appCache, CHARACTER_DRAFT_FILE_NAME)
    this.isolation = createCorruptIsolation({ logger: deps.logger, countDiagnostic: deps.countDiagnostic })
    this.writer = deps.writer ?? atomicWriteFile
  }

  /**
   * 启动读取 fail-open：整文件坏则隔离并以空仓库继续；单条坏只丢该条。
   * 任何日志只含固定 code/bytes，不含草稿正文、绝对路径或底层异常 message。
   */
  async load(): Promise<void> {
    try {
      await this.assertStorageRoot('load')
      const { fd } = await openSafeFile(this.file, { mode: 'existing', purpose: 'read', safeRoot: this.deps.safeRoot })
      let text: string
      try {
        const stat = await fd.stat()
        if (!stat.isFile() || stat.size > CHARACTER_DRAFT_MAX_FILE_BYTES) throw new Error('invalid-draft-file-size')
        text = await fd.readFile('utf8')
      } finally {
        await fd.close()
      }

      if (utf8Bytes(text) > CHARACTER_DRAFT_MAX_FILE_BYTES) throw new Error('invalid-draft-file-size')
      const root: unknown = JSON.parse(text)
      const parsedRoot = CharacterDraftFileSchema.safeParse(root)
      if (!parsedRoot.success) throw new Error('invalid-draft-file-schema')

      const candidates = new Map<string, PersistedCharacterDraft>()
      for (const raw of parsedRoot.data.entries) {
        const parsed = PersistedCharacterDraftSchema.safeParse(raw)
        if (!parsed.success) {
          this.isolation.dropInvalid('character-drafts:drop-invalid')
          continue
        }
        const entry = cloneValue(parsed.data)
        const entryBytes = utf8Bytes(JSON.stringify(entry))
        if (entryBytes > CHARACTER_DRAFT_MAX_ENTRY_BYTES) {
          this.isolation.dropInvalid('character-drafts:drop-oversize')
          continue
        }
        const previous = candidates.get(entry.key)
        if (!previous || compareEntries(entry, previous) < 0) candidates.set(entry.key, entry)
      }

      // 以最新 updatedAt 优先构造内存快照，并对有效 payload 再做一次有界筛选。
      // 正常 root 已受 2MiB 文件上限约束；这层防御也覆盖未来 envelope 扩展。
      const orderedAll = [...candidates.values()].sort(compareEntries)
      const ordered = orderedAll.slice(0, CHARACTER_DRAFT_MAX_ENTRIES)
      for (let index = CHARACTER_DRAFT_MAX_ENTRIES; index < orderedAll.length; index++) {
        this.isolation.dropInvalid('character-drafts:drop-entry-limit')
      }
      const accepted: PersistedCharacterDraft[] = []
      let payloadBytes = utf8Bytes(JSON.stringify({ schemaVersion: CHARACTER_DRAFT_SCHEMA_VERSION, entries: [] }))
      for (const entry of ordered) {
        const candidate = [...accepted, entry]
        const candidateBytes = utf8Bytes(JSON.stringify({ schemaVersion: CHARACTER_DRAFT_SCHEMA_VERSION, entries: candidate }))
        if (candidateBytes > CHARACTER_DRAFT_MAX_FILE_BYTES) {
          this.isolation.dropInvalid('character-drafts:drop-total-oversize')
          continue
        }
        accepted.push(entry)
        payloadBytes = candidateBytes
      }
      void payloadBytes // 保留变量用于明确 payload 边界，避免未来误改回仅计 entry。
      this.entries = new Map(accepted.map((entry) => [entry.key, entry]))
      this.lastError = undefined
      await this.isolation.pruneCorrupt(this.file, 'character-drafts')
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) {
        this.entries = new Map()
        this.lastError = undefined
        return
      }

      // safe-open/JSON/schema/size 失败都不把正文或底层异常透出；尽力隔离现场。
      this.entries = new Map()
      this.lastError = { code: CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE, operation: 'load' }
      this.deps.logger.warn('character-drafts:load-failed', { code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE' })
      await this.isolation.isolate(this.file, 'character-drafts', this.deps.safeRoot).catch(() => {})
    }
  }

  list(): CharacterDraftSummary[] {
    return [...this.entries.values()]
      .sort(compareEntries)
      .map((entry) => cloneValue(summaryOf(entry)))
  }

  get(key: string): PersistedCharacterDraft | undefined {
    this.assertKey(key)
    const entry = this.entries.get(key)
    return entry ? cloneValue(entry) : undefined
  }

  async save(input: PersistedCharacterDraft): Promise<void> {
    const parsed = PersistedCharacterDraftSchema.safeParse(input)
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '角色草稿格式无效')
    const entry = cloneValue(parsed.data)
    const entryBytes = utf8Bytes(JSON.stringify(entry))
    if (entryBytes > CHARACTER_DRAFT_MAX_ENTRY_BYTES) {
      throw new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '角色草稿超过单条大小上限', { backendCode: 'CHARACTER_DRAFT_LIMIT_EXCEEDED' })
    }

    // 在更新内存快照前先验证 app-cache 位于受控根内；否则安全失败的写请求
    // 不能把外部路径对应的记录伪装成已保存。
    await this.assertStorageRoot('save')
    const next = new Map(this.entries)
    next.set(entry.key, entry)
    if (next.size > CHARACTER_DRAFT_MAX_ENTRIES) {
      throw new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '角色草稿条目超过数量上限', { backendCode: 'CHARACTER_DRAFT_LIMIT_EXCEEDED' })
    }
    const serialized = this.serialize(next)
    this.entries = next
    return this.enqueueWrite(serialized, 'save')
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key)
    if (!this.entries.has(key)) return
    await this.assertStorageRoot('delete')
    const next = new Map(this.entries)
    next.delete(key)
    this.entries = next
    return this.enqueueWrite(this.serialize(next), 'delete')
  }

  /** 角色归档成功后的内部清理；删除同一角色的 edit/clone 草稿，不影响远端归档结果。 */
  async deleteByCharacterId(characterId: string): Promise<void> {
    if (typeof characterId !== 'string' || characterId.trim().length === 0) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '角色标识无效')
    const next = new Map([...this.entries].filter(([, entry]) =>
      !((entry.mode === 'edit' || entry.mode === 'clone') && entry.characterId === characterId)
    ))
    if (next.size === this.entries.size) return
    await this.assertStorageRoot('delete')
    this.entries = next
    return this.enqueueWrite(this.serialize(next), 'delete')
  }

  /** 清理失败后的安全重试基础；仍使用当前内存快照，不恢复已删除的正文。 */
  async retryPendingWrite(): Promise<void> {
    await this.assertStorageRoot('retry')
    return this.enqueueWrite(this.serialize(this.entries), 'retry')
  }

  getLastError(): CharacterDraftStorageError | undefined {
    return this.lastError ? { ...this.lastError } : undefined
  }

  /** 测试/设置清理使用；不暴露为 Renderer IPC。 */
  async clear(): Promise<void> {
    this.entries = new Map()
    await unlink(this.file).catch(() => {})
    this.lastError = undefined
  }

  private assertKey(key: string): void {
    if (!CharacterDraftKeySchema.safeParse(key).success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '角色草稿 key 无效')
  }

  private serialize(entries: Map<string, PersistedCharacterDraft>): string {
    const ordered = [...entries.values()].sort(compareEntries)
    const text = JSON.stringify({ schemaVersion: CHARACTER_DRAFT_SCHEMA_VERSION, entries: ordered })
    if (utf8Bytes(text) > CHARACTER_DRAFT_MAX_FILE_BYTES) {
      throw new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '角色草稿文件超过总大小上限', { backendCode: 'CHARACTER_DRAFT_LIMIT_EXCEEDED' })
    }
    return text
  }

  private async assertStorageRoot(operation: CharacterDraftStorageError['operation']): Promise<void> {
    try {
      const [safe, cache] = await Promise.all([realpath(this.deps.safeRoot), realpath(this.deps.appCache)])
      const rel = relative(safe, cache)
      // `cache..valid` is a legal child name. Only an actual parent segment at
      // the beginning of path.relative() escapes the root.
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('draft-cache-outside-safe-root')
    } catch {
      this.lastError = { code: CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE, operation }
      throw storageError(operation)
    }
  }

  private enqueueWrite(serialized: string, operation: 'save' | 'delete' | 'retry'): Promise<void> {
    const run = this.writeTail.catch(() => {}).then(async () => {
      try {
        await this.writer(this.file, serialized, { safeRoot: this.deps.safeRoot })
        this.lastError = undefined
      } catch {
        this.lastError = { code: CyreneErrorCode.CHARACTER_DRAFT_STORAGE_UNAVAILABLE, operation }
        this.deps.logger.warn('character-drafts:write-failed', {
          code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE',
          bytes: utf8Bytes(serialized)
        })
        throw storageError(operation)
      }
    })
    // 永远把 tail 收敛到已处理状态，下一笔写入不能被上一笔 reject 卡死。
    this.writeTail = run.catch(() => {})
    return run
  }
}

export function characterDraftFilePath(appCache: string): string {
  // 供测试/诊断断言使用；只返回派生 basename，不改变仓库的路径事实源。
  return join(appCache, basename(CHARACTER_DRAFT_FILE_NAME))
}
