import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDraft, PersistedCharacterDraft } from '@shared/contracts'
import { atomicWriteFile } from '../../src/main/credentials/atomic-write'
import {
  CHARACTER_DRAFT_FILE_NAME,
  CHARACTER_DRAFT_MAX_ENTRIES,
  CHARACTER_DRAFT_MAX_ENTRY_BYTES,
  CHARACTER_DRAFT_MAX_FILE_BYTES,
  CharacterDraftStore
} from '../../src/main/persistence/character-draft-store'

function draft(name: string): CharacterDraft {
  return {
    displayName: name, description: '', aliases: [],
    promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
    runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [name], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
    presentation: {}
  }
}

function entry(key: string, updatedAt: string, name = key): PersistedCharacterDraft {
  return { key, mode: 'create', displayName: name, updatedAt, draft: draft(name) }
}

function sourcedEntry(
  key: string,
  mode: 'edit' | 'clone',
  characterId: string,
  baseRevision: number,
  updatedAt: string,
  name = key
): PersistedCharacterDraft {
  return { key, mode, characterId, baseRevision, displayName: name, updatedAt, draft: draft(name) }
}

function largeDraft(name: string): CharacterDraft {
  const text = (length: number) => '界'.repeat(length)
  return {
    displayName: name,
    description: text(500),
    aliases: Array.from({ length: 10 }, () => text(32)),
    promptProfile: {
      corePersonality: text(12_000),
      relationshipStyle: text(6_000),
      emotionStyle: text(5_000),
      speakingStyle: text(6_000),
      conversationInitiative: text(3_000),
      examples: Array.from({ length: 20 }, () => ({ user: text(1_000), assistant: text(1_000) }))
    },
    runtimeDefaults: {
      voice: {},
      emotion: { idleExpressions: Array.from({ length: 16 }, () => text(32)) },
      wakeWords: Array.from({ length: 20 }, () => text(32)),
      proactive: { enabled: false, intervalSeconds: 3600, triggers: Array.from({ length: 20 }, () => text(64)) }
    },
    presentation: {},
    openingMessage: text(1_000)
  }
}

async function makeStore(options: { writer?: typeof atomicWriteFile; base?: string; safeRoot?: string } = {}) {
  const base = options.base ?? await mkdtemp(join(tmpdir(), 'cyrene-character-drafts-'))
  const safeRoot = options.safeRoot ?? await realpath(base)
  const counts: string[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const store = new CharacterDraftStore({
    appCache: base,
    safeRoot,
    logger: logger as never,
    countDiagnostic: (code) => counts.push(code),
    ...(options.writer ? { writer: options.writer } : {})
  })
  await store.load()
  return { base, safeRoot, store, counts, logger }
}

/**
 * 直接向 safeRoot 内写根文件时必须**复刻生产写入形态**：0o600（owner-only）。
 *
 * 2026-09-10 修复（CI Linux 红）：原夹具用裸 `writeFile`（POSIX 下 umask 022 → 0o644），而 load() 走
 * openSafeFile(purpose:'read')，其 POSIX 分支要求 (mode & 0o400) === 0o400 且 (mode & 0o077) === 0
 * （safe-open.ts checkModeMask，Windows 恒 false）→ 0644 被判「权限不正确」→ load() fail-closed 返回空。
 * 生产写入经 atomicWriteFile → openSafeFile(mode:'create') 固定 0o600 + fchmod 兜底，故真实文件满足该判据；
 * 夹具写 0644 属**夹具与生产契约不符**，不是产品缺陷。Windows 上 checkModeMask=false 故原夹具碰巧通过——
 * 同一 commit 三环境三结果（本地 Windows 全绿 / CI Windows 3 红 / CI Linux 2 红）即源于此类差异。
 */
function writeRootFile(base: string, payload: string | Buffer): Promise<void> {
  return writeFile(join(base, CHARACTER_DRAFT_FILE_NAME), payload, { mode: 0o600 })
}

/** JSON 对象判型：`JSON.parse` 的产物是外部输入（lib 里返回 `any`），先收成 `unknown` 再用它收窄。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 磁盘上的草稿根文件：形状对齐 character-draft-store 的 rootSchema（版本 + 记录数组）。 */
interface CharacterDraftFileOnDisk {
  schemaVersion: number
  entries: unknown[]
}

/** 读并判型草稿根文件：`JSON.parse` → `unknown` → 逐层收窄，断言里不再出现 `any`。 */
function readDraftFile(text: string): CharacterDraftFileOnDisk {
  const raw: unknown = JSON.parse(text)
  if (!isJsonObject(raw) || typeof raw.schemaVersion !== 'number' || !Array.isArray(raw.entries)) {
    throw new Error('草稿根文件形状非法（schemaVersion/entries）')
  }
  const entries: unknown[] = raw.entries
  return { schemaVersion: raw.schemaVersion, entries }
}

describe('CharacterDraftStore FE-D2', () => {
  const environments: string[] = []
  afterEach(async () => {
    await Promise.all(environments.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('原子保存/重载，list 只返回摘要且文件带严格 schemaVersion', async () => {
    const env = await makeStore(); environments.push(env.base)
    await env.store.save(entry('create:one', '2026-08-31T00:00:00.000Z', '角色一'))
    expect(env.store.list()).toEqual([{ key: 'create:one', mode: 'create', displayName: '角色一', updatedAt: '2026-08-31T00:00:00.000Z' }])
    expect(env.store.get('create:one')?.draft.displayName).toBe('角色一')
    const raw = readDraftFile(await readFile(join(env.base, CHARACTER_DRAFT_FILE_NAME), 'utf8'))
    expect(raw.schemaVersion).toBe(1)
    expect(raw.entries).toHaveLength(1)
    expect(await readFile(join(env.base, `${CHARACTER_DRAFT_FILE_NAME}.tmp`), 'utf8').catch(() => '')).toBe('')
  })

  it('根文件可读时逐条隔离损坏记录，并按 updatedAt/key 确定性保留最新十条', async () => {
    const env = await makeStore(); environments.push(env.base)
    const records = [
      ...Array.from({ length: CHARACTER_DRAFT_MAX_ENTRIES + 2 }, (_, index) => entry(`create:${index}`, `2026-08-31T00:${String(index).padStart(2, '0')}:00.000Z`, `角色${index}`)),
      { key: 'bad', mode: 'create', displayName: 'bad', updatedAt: 'not-time', draft: {} }
    ]
    await writeRootFile(env.base, JSON.stringify({ schemaVersion: 1, entries: records }))
    await env.store.load()
    expect(env.store.list()).toHaveLength(CHARACTER_DRAFT_MAX_ENTRIES)
    expect(env.store.list()[0].key).toBe('create:11')
    expect(env.store.list().some((item) => item.key === 'bad')).toBe(false)
    expect(env.counts).toContain('character-drafts:drop-invalid')
    expect(env.counts).toContain('character-drafts:drop-entry-limit')
  })

  it('损坏/超限根文件 fail-open 并隔离现场，不把正文或绝对路径写入日志', async () => {
    const env = await makeStore(); environments.push(env.base)
    const secret = 'PRIVATE_PROMPT_SHOULD_NOT_BE_LOGGED'
    await writeRootFile(env.base, `${secret}${'x'.repeat(2 * 1024 * 1024)}`)
    await env.store.load()
    expect(env.store.list()).toEqual([])
    const logs = JSON.stringify(env.logger.warn.mock.calls)
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(env.base)
  })

  it('同一进程并发保存串行落盘，最终文件始终可解析且最后状态可重载', async () => {
    const env = await makeStore(); environments.push(env.base)
    await Promise.all(Array.from({ length: 10 }, (_, index) => env.store.save(entry(`create:${index}`, `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`))))
    const raw = readDraftFile(await readFile(join(env.base, CHARACTER_DRAFT_FILE_NAME), 'utf8'))
    expect(raw.entries).toHaveLength(10)
    const fresh = new CharacterDraftStore({ ...({ appCache: env.base, safeRoot: env.safeRoot, logger: env.logger as never, countDiagnostic: () => {} }) })
    await fresh.load()
    expect(fresh.list()).toHaveLength(10)
  })

  it('第十一条保存明确拒绝，不静默淘汰已有草稿；删除按 key 串行更新', async () => {
    const env = await makeStore(); environments.push(env.base)
    for (let index = 0; index < CHARACTER_DRAFT_MAX_ENTRIES; index++) await env.store.save(entry(`create:${index}`, `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`))
    await expect(env.store.save(entry('create:overflow', '2026-08-31T01:00:00.000Z'))).rejects.toMatchObject({ code: 'DRAFT_LIMIT_EXCEEDED' })
    expect(env.store.list()).toHaveLength(10)
    await env.store.delete('create:0')
    expect(env.store.get('create:0')).toBeUndefined()
  })

  it('首笔 writer 失败不砖住队列，下一笔真实原子写落下完整 desired snapshot', async () => {
    let calls = 0
    const lowLevelSecret = 'LOW_LEVEL_WRITER_SECRET'
    const writer: typeof atomicWriteFile = async (filePath, data, options) => {
      calls++
      if (calls === 1) throw new Error(lowLevelSecret)
      await atomicWriteFile(filePath, data, options)
    }
    const env = await makeStore({ writer }); environments.push(env.base)
    const first = entry('create:first-failed', '2026-08-31T01:00:00.000Z', '首笔正文秘密')
    await expect(env.store.save(first)).rejects.toMatchObject({ code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE' })
    expect(env.store.getLastError()).toEqual({ code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE', operation: 'save' })
    // 失败写仍是进程内 desired state；第二笔整文件写会把它一并恢复到磁盘。
    expect(env.store.get(first.key)?.displayName).toBe('首笔正文秘密')

    const second = entry('create:second', '2026-08-31T01:01:00.000Z', '第二笔')
    await env.store.save(second)
    expect(calls).toBe(2)
    expect(env.store.getLastError()).toBeUndefined()
    const fresh = new CharacterDraftStore({ appCache: env.base, safeRoot: env.safeRoot, logger: env.logger as never, countDiagnostic: () => {} })
    await fresh.load()
    expect(fresh.list().map((item) => item.key)).toEqual(['create:second', 'create:first-failed'])
    const logs = JSON.stringify(env.logger.warn.mock.calls)
    expect(logs).not.toContain(lowLevelSecret)
    expect(logs).not.toContain('首笔正文秘密')
    expect(logs).not.toContain(env.base)
  })

  it('deleteByCharacterId 写失败后 retryPendingWrite 落下已清理快照', async () => {
    let failNext = false
    const writer: typeof atomicWriteFile = async (filePath, data, options) => {
      if (failNext) {
        failNext = false
        throw new Error('DELETE_LOW_LEVEL_SECRET')
      }
      await atomicWriteFile(filePath, data, options)
    }
    const env = await makeStore({ writer }); environments.push(env.base)
    await env.store.save(sourcedEntry('edit:target', 'edit', 'custom/target', 2, '2026-08-31T02:00:00.000Z'))
    await env.store.save(sourcedEntry('clone:target', 'clone', 'custom/target', 2, '2026-08-31T02:01:00.000Z'))
    await env.store.save(sourcedEntry('edit:other', 'edit', 'custom/other', 1, '2026-08-31T02:02:00.000Z'))
    await env.store.save(entry('create:independent', '2026-08-31T02:03:00.000Z'))

    failNext = true
    await expect(env.store.deleteByCharacterId('custom/target')).rejects.toMatchObject({ code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE' })
    expect(env.store.getLastError()).toEqual({ code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE', operation: 'delete' })
    expect(env.store.list().map((item) => item.key).sort()).toEqual(['create:independent', 'edit:other'])

    await env.store.retryPendingWrite()
    expect(env.store.getLastError()).toBeUndefined()
    const fresh = new CharacterDraftStore({ appCache: env.base, safeRoot: env.safeRoot, logger: env.logger as never, countDiagnostic: () => {} })
    await fresh.load()
    expect(fresh.list().map((item) => item.key).sort()).toEqual(['create:independent', 'edit:other'])
  })

  it('appCache 逃逸 safeRoot：load 不抛（boot 不阻塞）+ **降级态**下读写全拒 + 不触碰外部文件/日志正文', async () => {
    const safe = await mkdtemp(join(tmpdir(), 'cyrene-character-safe-'))
    const outside = await mkdtemp(join(tmpdir(), 'cyrene-character-outside-'))
    environments.push(safe, outside)
    const env = await makeStore({ base: outside, safeRoot: await realpath(safe) })
    const secret = 'OUTSIDE_DRAFT_SECRET'
    // H-11b 同族（2026-09-13）改判：这条此前期望 `list() === []` + `save()` 抛
    // CHARACTER_DRAFT_STORAGE_UNAVAILABLE——那是**旧行为**（隔离失败被 `.catch(()=>{})` 吞掉，
    // 内存换成空仓库、下一次写覆写未能隔离的原文件）。现改为：置降级位 → 读也拒绝（返回空是谎报，
    // 磁盘上明明有东西）→ 写拒绝（保现场）。load 本身仍不抛，启动不受影响。
    expect(env.store.getLastError()).toEqual({ code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE', operation: 'load' })
    expect(env.store.getDegradedReason(), '隔离失败必须进入降级态，不得被吞').toContain('isolate-failed')
    expect(env.counts).toContain('character-drafts:degraded')

    expect(() => env.store.list()).toThrowError(/持久化已降级/)
    await expect(env.store.save(entry('create:outside', '2026-08-31T03:00:00.000Z', secret)))
      .rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    await expect(env.store.delete('create:outside')).rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    await expect(env.store.deleteByCharacterId('custom/x')).rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    await expect(env.store.retryPendingWrite()).rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    await expect(env.store.clear()).rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    expect(await stat(join(outside, CHARACTER_DRAFT_FILE_NAME)).catch(() => undefined)).toBeUndefined()
    const logs = JSON.stringify(env.logger.warn.mock.calls)
    expect(logs).not.toContain(safe)
    expect(logs).not.toContain(outside)
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain('draft-cache-outside-safe-root')
    // 降级日志同样只含固定 code/文件名（该文件头注明的纪律：不含正文/绝对路径/底层 message）
    const errorLogs = JSON.stringify(env.logger.error.mock.calls)
    expect(errorLogs).toContain('character-drafts:degraded')
    expect(errorLogs).not.toContain(safe)
    expect(errorLogs).not.toContain(outside)
  })

  it('未被隔离的原文件在降级态下逐字节保留（判别用例：修复前下一次 save 会覆写它）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-character-drafts-'))
    environments.push(base)
    // 这一条刻意**不用** safeRoot 不匹配来造降级：那种夹具下 `assertStorageRoot` 本来就会拦住写，
    // 于是"覆写"根本发生不了——判别力是假的（本轮 M1 变异时实际发现：它红在错误码不同，而不是红在文件被改）。
    // 真实形态是「隔离改名失败、但写入路径本身健康」（文件被 AV/备份代理锁住 / 只读目录下 rename 失败）：
    // 故这里保留正确的 safeRoot，只注入 isolate 失败（与 session-store.spec 同款手法）。
    const original = 'not-json{{{'
    await writeRootFile(base, original)
    const counts: string[] = []
    const localLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const store = new CharacterDraftStore({
      appCache: base, safeRoot: await realpath(base), logger: localLogger as never,
      countDiagnostic: (code) => counts.push(code)
    })
    const isolation = (store as unknown as { isolation: { isolate(): Promise<string> } }).isolation
    isolation.isolate = async () => { throw new Error('EPERM: rename denied') }
    await store.load()
    expect(store.getDegradedReason()).toContain('isolate-failed')
    expect(counts).toContain('character-drafts:degraded')
    await expect(store.save(entry('create:new', '2026-08-31T04:00:00.000Z'))).rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    expect(await readFile(join(base, CHARACTER_DRAFT_FILE_NAME), 'utf8'), '保现场：原文件逐字节未变').toBe(original)
  })

  it('正常路径不误报降级（getDegradedReason 为 undefined，读写照常）', async () => {
    const env = await makeStore(); environments.push(env.base)
    expect(env.store.getDegradedReason()).toBeUndefined()
    await env.store.save(entry('create:ok', '2026-08-31T05:00:00.000Z'))
    expect(env.store.list()).toHaveLength(1)
    expect(env.counts).not.toContain('character-drafts:degraded')
  })

  it('安全根内目录名含两个点不被 containment 误判', async () => {
    const safe = await mkdtemp(join(tmpdir(), 'cyrene-character-safe-'))
    const cache = join(safe, 'cache..valid')
    await mkdir(cache)
    environments.push(safe)
    const outerSafeRoot = await realpath(safe)
    const writerRoots: string[] = []
    const writer: typeof atomicWriteFile = async (filePath, data, options) => {
      writerRoots.push(options.safeRoot)
      await atomicWriteFile(filePath, data, options)
    }
    const env = await makeStore({ base: cache, safeRoot: outerSafeRoot, writer })
    expect(env.store.getLastError()).toBeUndefined()
    await env.store.save(entry('create:inside', '2026-08-31T03:10:00.000Z'))
    expect(env.store.get('create:inside')).toBeDefined()
    expect(writerRoots).toEqual([outerSafeRoot])
  })

  it('合法大草稿逼近总 2MiB；首次总量越界不改变内存或磁盘前态', async () => {
    const env = await makeStore(); environments.push(env.base)
    let successful = 0
    let overflow: unknown
    for (let index = 0; index < CHARACTER_DRAFT_MAX_ENTRIES; index++) {
      const name = `大草稿${index}`
      const value: PersistedCharacterDraft = {
        key: `create:large:${index}`,
        mode: 'create',
        displayName: name,
        updatedAt: `2026-08-31T04:00:${String(index).padStart(2, '0')}.000Z`,
        draft: largeDraft(name)
      }
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThan(CHARACTER_DRAFT_MAX_ENTRY_BYTES)
      try {
        await env.store.save(value)
        successful++
      } catch (error) {
        overflow = error
        break
      }
    }
    expect(successful).toBeGreaterThan(1)
    expect(successful).toBeLessThan(CHARACTER_DRAFT_MAX_ENTRIES)
    expect(overflow).toMatchObject({ code: 'DRAFT_LIMIT_EXCEEDED' })
    const before = env.store.list().map((item) => item.key)
    const disk = JSON.parse(await readFile(join(env.base, CHARACTER_DRAFT_FILE_NAME), 'utf8')) as { entries: unknown[] }
    expect(disk.entries).toHaveLength(successful)
    expect((await stat(join(env.base, CHARACTER_DRAFT_FILE_NAME))).size).toBeLessThanOrEqual(CHARACTER_DRAFT_MAX_FILE_BYTES)
    expect(env.store.list().map((item) => item.key)).toEqual(before)
    const fresh = new CharacterDraftStore({ appCache: env.base, safeRoot: env.safeRoot, logger: env.logger as never, countDiagnostic: () => {} })
    await fresh.load()
    expect(fresh.list().map((item) => item.key)).toEqual(before)
  })

  it('deleteByCharacterId 只删除 matching edit/clone，保留其它来源与 create', async () => {
    const env = await makeStore(); environments.push(env.base)
    const records = [
      sourcedEntry('edit:target:only', 'edit', 'custom/target', 3, '2026-08-31T05:00:00.000Z'),
      sourcedEntry('clone:target:only', 'clone', 'custom/target', 3, '2026-08-31T05:01:00.000Z'),
      sourcedEntry('edit:other:keep', 'edit', 'custom/other', 2, '2026-08-31T05:02:00.000Z'),
      sourcedEntry('clone:other:keep', 'clone', 'custom/other', 2, '2026-08-31T05:03:00.000Z'),
      entry('create:keep', '2026-08-31T05:04:00.000Z')
    ]
    for (const record of records) await env.store.save(record)
    await env.store.deleteByCharacterId('custom/target')
    expect(env.store.list().map((item) => item.key).sort()).toEqual(['clone:other:keep', 'create:keep', 'edit:other:keep'])
    const fresh = new CharacterDraftStore({ appCache: env.base, safeRoot: env.safeRoot, logger: env.logger as never, countDiagnostic: () => {} })
    await fresh.load()
    expect(fresh.list().map((item) => item.key).sort()).toEqual(['clone:other:keep', 'create:keep', 'edit:other:keep'])
  })

  it('load 对 semantic-invalid full record 逐条隔离，合法记录仍可恢复', async () => {
    const env = await makeStore(); environments.push(env.base)
    const validCreate = entry('create:valid', '2026-08-31T06:00:00.000Z', '合法新建')
    const validEdit = sourcedEntry('edit:valid', 'edit', 'custom/valid', 4, '2026-08-31T06:01:00.000Z', '合法编辑')
    const invalidCreateSource = { ...entry('create:bad-source', '2026-08-31T06:02:00.000Z'), characterId: 'custom/x', baseRevision: 1 }
    const invalidEditBaseline = { ...sourcedEntry('edit:bad-base', 'edit', 'custom/x', 1, '2026-08-31T06:03:00.000Z') } as Record<string, unknown>
    delete invalidEditBaseline.baseRevision
    const invalidName = { ...sourcedEntry('clone:bad-name', 'clone', 'custom/x', 1, '2026-08-31T06:04:00.000Z'), displayName: '摘要不一致' }
    await writeRootFile(env.base, JSON.stringify({
      schemaVersion: 1,
      entries: [validCreate, invalidCreateSource, validEdit, invalidEditBaseline, invalidName]
    }))

    await env.store.load()
    expect(env.store.list().map((item) => item.key)).toEqual(['edit:valid', 'create:valid'])
    expect(env.counts.filter((code) => code === 'character-drafts:drop-invalid')).toHaveLength(3)
  })

  // 2026-09-10 新增：把「非 0600 根文件 → 全量丢弃」这一 fail-closed 语义**显式钉住**。
  // 它此前只以 CI Linux 红灯的形式偶然暴露（见 writeRootFile 注释）；本用例让语义与可用性取舍可见。
  // 记录的开放项：POSIX 上这是「为保密性检查牺牲可用性且不告知用户」——用户若从备份恢复/被同步工具改写
  // 权限，草稿会静默全丢、列表为空且无可见错误。是否改为「拒绝读取但显式告知 + 隔离现场」需单独决策，
  // 本批只钉住现状语义、不改安全策略。
  it('非 0600 根文件（group/other 位）→ POSIX 上 fail-closed 丢弃全部草稿（Windows 无权限位语义）', async () => {
    const env = await makeStore(); environments.push(env.base)
    await env.store.save(entry('create:one', '2026-08-31T00:00:00.000Z', '角色一'))
    expect(env.store.list()).toHaveLength(1)
    if (process.platform === 'win32') return   // NTFS 合成权限位，checkModeMask=false，该语义不适用
    await chmod(join(env.base, CHARACTER_DRAFT_FILE_NAME), 0o644)
    await env.store.load()
    expect(env.store.list()).toEqual([])
  })
})
