// tests/unit/desktop-api-mock-migration.spec.ts
//
// I-06 / P2-10 的**迁移进度门禁**（2026-09-12）。
//
// 背景：评审指出 40 个 spec 手搓 `setDesktopApi(createDesktopApiMock({...}))`，那个 cast 抹掉了唯一能发现
// 「mock 与 DesktopApiLike 漂移」的机制——preload 面从 74 键涨到 93 键期间，方法被重命名/改签名
// 时 mock 会静默继续提供**已不存在**的形状，而 spec 照样全绿。受检工厂见
// `tests/unit/helpers/desktop-api.ts`。
//
// 迁移无法一轮做完（原因见 doc 16 §3.1 的 I-06 条目：一批 spec 的手写 stub 比真实签名**窄**，
// 在 strictFunctionTypes 下不可赋值——`as never` 当初掩盖的正是这件事）。因此本门禁的作用是
// **把欠账钉成显式清单**，而不是假装已经迁完：
//   · 未迁移的文件必须在下面 `PENDING` 里逐个列出；
//   · 新 spec 若再用裸 mock ⇒ 红（防止欠账增长）；
//   · 迁移完一个就要从 PENDING 删一行 ⇒ 清单不会静默过期。
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktopApiMock } from './helpers/desktop-api'

const UNIT_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * 尚未迁移到 `createDesktopApiMock` 的 spec —— **2026-09-12 已清零**。
 *
 * 清空后本门禁的角色从"欠账台账"变成**防回退闸门**：任何新 spec（或改动过的旧 spec）只要再手搓
 * `setDesktopApi({...} as never)`，就会出现在 `pendingNow` 里而与空清单不符 → 红。
 * 迁移完成的文件请把这一行留空，不要为了让它变绿而往清单里加行。
 */
const PENDING = [] as const

function specFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...specFiles(full))
    else if (entry.name.endsWith('.spec.ts')) out.push(full)
  }
  return out
}

/**
 * 截出每个 `setDesktopApi(...)` 调用的**实参文本**（按括号配平，逐字符扫）。
 *
 * 为什么不直接用 `setDesktopApi\([\s\S]{0,400}?as never`：那个 400 字符滑窗会把调用**之后**的无关
 * cast 也算进来——实测踩到 4 次误报（3 次是自己写的迁移说明、1 次是同文件里 `.vue` shim 既有的
 * `mount(..., { props: props as never })`）。只检查实参内部既消除误报，也不漏掉
 * `setDesktopApi({ x } as never)` 这类真目标（该判别力由本文件的变异验证覆盖）。
 *
 * 已知局限：不解析字符串字面量——实参里若出现含括号的字符串可能配平错位。本仓库的实参是
 * 对象字面量或标识符，不触发该局限。
 */
function desktopApiCallArgs(text: string): string[] {
  const marker = 'setDesktopApi('
  const args: string[] = []
  for (let start = text.indexOf(marker); start !== -1; start = text.indexOf(marker, start + 1)) {
    let depth = 0
    let end = start + marker.length - 1 // 指向 '('
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++
      else if (text[end] === ')') { depth--; if (depth === 0) break }
    }
    args.push(text.slice(start + marker.length, end))
  }
  return args
}

/** 相对 tests/unit 的文件名（本门禁自身不参与统计） */
function scan(): { all: string[]; migrated: string[]; strayCast: string[] } {
  const all: string[] = []
  const migrated: string[] = []
  const strayCast: string[] = []
  for (const file of specFiles(UNIT_ROOT)) {
    const name = relative(UNIT_ROOT, file).replace(/\\/g, '/')
    if (name === 'desktop-api-mock-migration.spec.ts') continue
    const text = readFileSync(file, 'utf8')
    if (!/setDesktopApi\(/.test(text)) continue
    all.push(name)
    if (text.includes('createDesktopApiMock')) {
      migrated.push(name)
      // 已迁移的文件不得再对 desktopApi 用 as never（否则等于没迁）
      if (desktopApiCallArgs(text).some((args) => args.includes('as never'))) strayCast.push(name)
    }
  }
  return { all, migrated, strayCast }
}

describe('I-06 mock 工厂迁移进度门禁', () => {
  it('扫描器仍是活的（退化哨兵）', () => {
    const { all, migrated } = scan()
    expect(all.length, `未扫到任何 setDesktopApi 调用：${JSON.stringify(all)}`).toBeGreaterThanOrEqual(40)
    expect(migrated.length, '已迁移文件数为 0 —— 工厂没有任何真实使用者，本门禁失去意义').toBeGreaterThanOrEqual(1)
  })

  it('未迁移的文件与 PENDING 清单完全一致（多一个=欠账增长，少一个=清单过期）', () => {
    const { all, migrated } = scan()
    const pendingNow = all.filter((name) => !migrated.includes(name)).sort()
    expect(
      pendingNow,
      '与 PENDING 不一致。新增裸 mock 的 spec 必须改用 createDesktopApiMock；迁移完成的文件请从 PENDING 删掉对应行'
    ).toEqual([...PENDING].sort())
  })

  it('已迁移的文件里不得残留 `as never` 铸 desktopApi（否则等于没迁）', () => {
    // 只检查 `setDesktopApi(...)` 的**实参文本**（见 desktopApiCallArgs）。因此：
    //   · 迁移说明里若把 cast 原样抄进实参注释，仍会命中——改写措辞即可，勿放宽扫描；
    //   · 调用之后（实参之外）的无关 cast 不再误报。
    const { strayCast } = scan()
    expect(strayCast, `以下文件已引入工厂却仍保留 cast：${JSON.stringify(strayCast)}`).toEqual([])
  })

  // —— 工厂自身的回归守卫（2026-09-12 迁移 store 域时发现的真实回归）——
  // 工厂的返回类型曾一度丢失 mock 方法：`{...defaults(), ...overrides}` 对每个键推断出
  // `Mock<签名> | 签名` 联合，因 `Mock<签名>` 可赋值给 `签名` 而被**子类型归约**坍缩成裸签名。
  // 修法是重载 + 精确返回类型 `Omit<DesktopApiMock, keyof O> & O`（详见 helpers/desktop-api.ts 注释）。
  // 本用例的 `mockResolvedValue` 那两行是类型层面的哨兵：回归一旦复现，本文件直接编译失败。
  it('无参调用仍返回完整默认表：各键是 mock，且默认值仍生效', async () => {
    const api = createDesktopApiMock()
    expect(vi.isMockFunction(api.connect)).toBe(true)
    expect(vi.isMockFunction(api.persistFlushDone)).toBe(true)
    api.getConnectionState.mockResolvedValue({ status: 'connected' }) // ← 类型哨兵，勿删
    expect(await api.getConnectionState()).toEqual({ status: 'connected' })
  })

  it('带 override 时，**未**被 override 的键仍是 mock（同样只靠返回类型成立）', async () => {
    // override 用**如实签名**（带参）；顺带钉住「被 override 的键保持调用者给的类型」——
    // 所以这里能传实参，而 `createDesktopApiMock()` 的其他键仍旧是完整 Mock。
    const api = createDesktopApiMock({ activate: async (id: string) => ({ conversationId: `c-${id}` }) })
    api.connect.mockResolvedValue({ sessionId: 's', protocolVersion: '2.0', serverUrl: 'u' }) // ← 类型哨兵，勿删
    expect(await api.connect()).toEqual({ sessionId: 's', protocolVersion: '2.0', serverUrl: 'u' })
    expect(await api.activate('x')).toEqual({ conversationId: 'c-x' }) // override 生效（键名与签名都受检）
  })
})
