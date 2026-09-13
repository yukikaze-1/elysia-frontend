// tests/integration/persistence-degraded.spec.ts
//
// H-11b renderer 半边（2026-09-13）：**本地保存停用这件事必须到达用户**。
//
// 修复前的事实链（评审 H-11b + doc 16 §5 第 7 条）：Main 在隔离失败后进入降级态、拒绝一切写入
// （这部分已在 2026-09-11 落地，证据是 session-store 单测「原文件逐字节未变」），但**renderer 侧
// 一个字都看不到**——IPC 错误码是兜底的 `UNKNOWN`（executor 兜成「内部错误」），`draft.store.persistNow`
// 又无条件 fail-open 吞掉失败。用户会一直以为草稿在存着，直到重启后发现全丢。
//
// 本用例走**真实产品路径**构造降级（不注入任何测试专用分支）：把 app-cache/drafts-v1.json 预置成
// 指向 **userData 之外**的链接 → `openSafeFile` 拒符号链接（posix O_NOFOLLOW / windows pre-open lstat）
// → `readFile` 进隔离分支 → `isolate()` 的 `assertContained` 因 realpath 越根而上抛 → SessionStore 置降级位。
//
// 链接形态按平台择一（**两种都让 Main 走同一条降级路径**，触发标签都是 `read-failed:unknown`）：
//   · 文件 symlink —— Linux 恒可，断言最强（外部目标文件逐字节未变）；
//   · 目录 junction —— Windows 免特权可用（本机实测：文件 symlink 报 EPERM，junction 成功且
//     `lstat().isSymbolicLink() === true`、`realpath` 解析到外部）。此时断言改为"外部目录里除哨兵文件外
//     什么都没多出来"，因为被覆写的对象是链接本身而不是某个文件。
// 若两者都不可用（既无 symlink 权限又非 Windows）→ 整组跳过，并在测试名里写明，而不是伪装通过。
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'
import { detectLinkMode } from './helpers/links'

const POLL = { timeout: 15000, interval: 200 }
const MARK = 'H11B-降级态下键入的草稿-7c41f0'
const DRAFTS_REL = 'app-cache/drafts-v1.json'

/** 可用的链接形态（探测实现与理由见 helpers/links.ts；两种形态都让 Main 走同一条降级路径） */
const linkMode = detectLinkMode()

/** 连接 + 激活首个会话（与 persist-flush.spec.ts 同款真实路径；键入草稿需要输入框可用） */
async function connectAndActivateFirst(page: Page): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).first().click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(
    () => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true),
    POLL
  ).toBe(false)
}

interface DegradedSetup {
  launched: LaunchedApp
  outside: string
  /** 目标文件（file-symlink 形态） */
  targetFile: string
  /** 外部目录的哨兵文件 + 内容（dir-junction 形态） */
  sentinel: string
  sentinelText: string
  original: string
}

/** 预置「隔离必然失败」：drafts 文件是指向外部的链接 */
async function launchDegraded(): Promise<DegradedSetup> {
  const outside = mkdtempSync(join(tmpdir(), 'cy-persist-degrade-'))
  const targetFile = join(outside, 'drafts-v1.json')
  const sentinel = join(outside, 'sentinel.txt')
  const sentinelText = 'outside-dir-sentinel'
  writeFileSync(sentinel, sentinelText, { mode: 0o600 })
  const original = JSON.stringify({ schemaVersion: 99, entries: { 'conv-1001': { text: '必须保住', updatedAt: 't' } } })
  // dir-junction 形态：链接指向**目录**，于是"外部目录里有什么"就是可断言的全部事实
  if (linkMode === 'file-symlink') writeFileSync(targetFile, original, { mode: 0o600 })
  const launched = await launchApp([{ relPath: DRAFTS_REL, symlinkTo: linkMode === 'file-symlink' ? targetFile : outside }])
  return { launched, outside, targetFile, sentinel, sentinelText, original }
}

describe.skipIf(linkMode === 'none')(`持久化降级对用户可见（H-11b renderer 半边；构造形态=${linkMode}）`, () => {
  it('降级 → 全局横幅可见、投影无路径、拒绝写入有专属码、键入后外部现场逐字节未变', async () => {
    const setup = await launchDegraded()
    const { launched, outside, targetFile, sentinel, sentinelText, original } = setup
    try {
      const { page } = launched

      // ① 用户看得见：启动水合即可见，不需要等到下一次键入被拒
      const banner = page.locator('[data-testid="persistence-banner"]')
      await expect.poll(() => banner.count(), POLL).toBe(1)
      await expect.poll(() => banner.textContent(), POLL).toContain('本地保存已停用')
      // ② 说清楚是什么：基名 + 触发标签（链接被 safe-open 拒绝后的既有归类）
      await expect.poll(() => page.locator('[data-testid="persistence-banner-detail"]').textContent(), POLL)
        .toContain('drafts-v1.json')
      const bannerText = (await banner.textContent()) ?? ''
      expect(bannerText, '横幅不得回显任何本地绝对路径').not.toContain(outside)
      expect(bannerText).not.toMatch(/[A-Za-z]:\\|\/(tmp|home)\//)
      // 横幅是**全局**的：切到设置页（chat 视图被 v-else 卸载）后依然在
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings-overlay').count(), POLL).toBe(1)
      await expect.poll(() => banner.count(), POLL).toBe(1)
      await page.getByRole('button', { name: '关闭设置' }).click()
      await expect.poll(() => page.locator('.cy-chat').count(), POLL).toBe(1)

      // ③ 水合投影：字段在、是**封闭标签**（不是 fs 原文）、且序列化后不含路径
      const notice = await page.evaluate(() => window.desktopApi.hydratePersistence().then((s) => s.persistenceDegraded ?? null))
      expect(notice?.file).toBe('drafts-v1.json')
      // 标签值不写死：posix 的 ELOOP 与 windows 的 pre-open lstat 拒绝都会在 safe-open 内被包成无 errno 的
      // SafeOpenError，故两边实测都是 `read-failed:unknown`；但**本用例要钉的是"封闭词表 + 无路径"**，
      // 而不是某个具体标签，写死具体值会把平台差异变成假红。
      expect(notice?.reason).toMatch(/^(read-failed:[a-z0-9_]+|not-an-object|schema-version-mismatch:\d+)$/)
      expect(JSON.stringify(notice)).not.toContain(outside)

      // ③' 直接写一次：错误码必须是专属的 PERSISTENCE_DEGRADED（此前是泛化 UNKNOWN/内部错误）
      const err = await page.evaluate(async () => {
        try {
          await window.desktopApi.persistSession({ conversationId: 'conv-1001', draft: { text: 'x', updatedAt: 't' }, scrollAnchor: null })
          return 'no-error'
        } catch (e) { return (e as Error).message }
      })
      expect(err).toContain('PERSISTENCE_DEGRADED')

      // ④ 真实用户路径：键入（800ms 防抖到期后触发写入）→ 输入框内容仍在（fail-open 不退化）+ 外部现场未被写
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill(MARK)
      await page.waitForTimeout(1500)   // 越过 800ms 防抖
      expect(await page.getByLabel('消息输入框').inputValue(), '内存态必须保留（否则用户当场丢字）').toBe(MARK)
      if (linkMode === 'file-symlink') {
        expect(readFileSync(targetFile, 'utf8'), '降级态下任何键入都不得覆写未能隔离的原文件').toBe(original)
      } else {
        // junction 形态：被覆写的对象是链接本身，故断言"外部目录里除哨兵外什么都没多出来、哨兵也没被改"
        expect(readdirSync(outside).sort(), '外部目录不得出现任何新文件').toEqual(['sentinel.txt'])
        expect(readFileSync(sentinel, 'utf8')).toBe(sentinelText)
        expect(statSync(sentinel).isFile()).toBe(true)
      }

      // 横幅仍在（没有被"一次成功写"或视图切换清掉）
      await expect.poll(() => banner.count(), POLL).toBe(1)
    } finally {
      await closeApp(launched)
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// **阳性对照**（不是重复覆盖，而是上一条断言的必要前提）：
// 上一条的"外部未变"若单独存在，在"键入根本没触发写入"时同样成立——那是假绿。
// 本用例用**同一条键入路径**证明「键入 → 800ms 防抖 → 真的写了盘」成立，同时钉住"健康时不显示横幅"。
describe('持久化健康时的阳性对照', () => {
  it('同一条键入路径确实落盘，且不显示任何持久化横幅', async () => {
    const launched = await launchApp()
    const draftsPath = join(launched.userData, 'Cyrene', DRAFTS_REL)
    try {
      const { page } = launched
      expect(await page.locator('[data-testid="persistence-banner"]').count()).toBe(0)
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill(MARK)
      await expect.poll(() => {
        try { return readFileSync(draftsPath, 'utf8') } catch { return '' }
      }, POLL).toContain(MARK)
      expect(await page.locator('[data-testid="persistence-banner"]').count()).toBe(0)
    } finally { await closeApp(launched) }
  })
})
