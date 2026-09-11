// tests/unit/atomic-write-concurrency.spec.ts
// H-11a（2026-09-11）：并发原子写不得静默失败。
//
// 原缺陷：临时名是**固定**的 `${basename}.tmp`，两个并发写者共用同一个临时文件——
//   A: open temp → 写入 A 内容
//   B: open temp（同名）→ 写 B 内容（temp 现在装的是 B）
//   A: rename(temp → target)   ← 把 B 尚未 rename 的 temp 搬走了，target = B 内容（A 以为写成功）
//   B: rename(temp → target)   ← ENOENT，temp 已被 A 搬走 → **B 的写静默失败**
// 唯一的单实例锁只保证「一个应用进程」，不保证「一个写者」：SessionStore 有多条写同一文件的路径
// （persistSession × setActiveConversation；cacheMessages × syncConversationList），且 chat-service
// 侧三条都是 fire-and-forget。
//
// 本 spec 用**真并发**（Promise.all 同时发起）撞那个窗口，断言「全部写者都成功」——
// 这正是修复前不成立的性质。变异验证：把临时名改回固定的 `${basename}.tmp` → 本 spec 红。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { atomicWriteFile } from '../../src/main/credentials/atomic-write'

let dir = ''
let root = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cy-atomic-'))
  root = await realpath(dir)   // realpath：macOS/Windows 下 tmpdir 可能是 symlink，包含性检查要求真实路径
})
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const target = (): string => join(root, 'store.json')

describe('atomicWriteFile 并发写（H-11a）', () => {
  it('20 个并发写者写同一文件：每一个都必须成功（不得有 ENOENT 静默失败）', async () => {
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ writer: i, tag: 'x'.repeat(2000 + i) }))
    // 同时发起：撞的正是 open→rename 那个窗口
    const results = await Promise.allSettled(payloads.map((p) => atomicWriteFile(target(), p, { safeRoot: root })))

    const rejected = results
      .map((r, i) => (r.status === 'rejected' ? `#${i}: ${String((r as PromiseRejectedResult).reason)}` : null))
      .filter((x): x is string => x !== null)
    expect(rejected, `并发写出现失败（固定临时名会让后 rename 者 ENOENT）:\n${rejected.join('\n')}`).toEqual([])
  })

  it('并发写后文件内容完整且是某一个写者的完整载荷（不出现撕裂/截断）', async () => {
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ writer: i, tag: 'y'.repeat(1000 + i) }))
    await Promise.all(payloads.map((p) => atomicWriteFile(target(), p, { safeRoot: root })))

    const onDisk = readFileSync(target(), 'utf8')
    // 必须是某个载荷的**逐字节**完整复制——原子替换的意义就在这里（不会出现半截 JSON）
    expect(payloads.includes(onDisk), '磁盘内容不是任何一个写者的完整载荷（撕裂写？）').toBe(true)
  })

  it('写成功后不残留临时文件（每次写用独立 UUID temp，成功路径必须清干净）', async () => {
    await Promise.all([
      atomicWriteFile(target(), '{"a":1}', { safeRoot: root }),
      atomicWriteFile(target(), '{"a":2}', { safeRoot: root })
    ])
    const leftovers = readdirSync(root).filter((n) => n.endsWith('.tmp'))
    expect(leftovers, `成功写后残留 temp：${leftovers.join(', ')}`).toEqual([])
  })

  it('陈旧 temp 会被回收（UUID 化后不再靠同名复用清理，必须有主动回收，否则换一种泄漏）', async () => {
    // 造一个 2 小时前的陈旧 temp（阈值 1 小时）
    const stale = join(root, 'store.json.00000000-0000-4000-8000-000000000000.tmp')
    const { writeFileSync, utimesSync } = await import('node:fs')
    writeFileSync(stale, 'crashed mid-write')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    await atomicWriteFile(target(), '{"fresh":true}', { safeRoot: root })

    const leftovers = readdirSync(root).filter((n) => n.endsWith('.tmp'))
    expect(leftovers, '陈旧 temp 应被回收').toEqual([])
    expect(JSON.parse(readFileSync(target(), 'utf8'))).toEqual({ fresh: true })
  })

  it('新近 temp 不被误删（在途写入的 temp 不得被别的写者清掉）', async () => {
    const recent = join(root, 'store.json.11111111-1111-4111-8111-111111111111.tmp')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(recent, 'in-flight')

    await atomicWriteFile(target(), '{"fresh":true}', { safeRoot: root })

    expect(readdirSync(root).includes('store.json.11111111-1111-4111-8111-111111111111.tmp'),
      '刚创建的 temp 可能是别的写者的在途文件，不得回收').toBe(true)
  })
})
