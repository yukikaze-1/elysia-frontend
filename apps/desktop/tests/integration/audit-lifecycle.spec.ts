// tests/integration/audit-lifecycle.spec.ts
// M-31（review 2026-09-11 P2-10）：本文件此前唯一的端到端审计断言是 `.toContain('credential:set')`——
// 该子串同时匹配 `"status":"success"` 与 `"status":"failed"`，于是「审计 sink 停止写成功记录」「只写失败」
// 这类回归全绿。现改为**解析 JSONL、断言结构化 type + status**，并与 page 侧实际观察到的 API 结果对齐。
//
// 同时记录 M-32 的分支归属（见下）：本仓集成装配用的是 **electron 真实 safeStorage**（`main/index.ts:199`
// 直接注入 `safeStorage`，只有单测注入 fake），因此这条用例在 Windows/macOS 上走的是真实 OS 加密往返；
// 无 keyring 的 headless Linux（CI）走 `basic_text → unavailable` 降级分支。两条分支的**实际去向**都会
// 打印出来，并断言「审计记录的 status 与观察到的 API 结果一致」——于是无论走哪条，这条用例都真的在判别。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { BACKEND_TOKEN_KEY } from '@shared/contracts'
import { launchApp, closeApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })

const auditFile = (): string => {
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return join(userData, 'Cyrene', 'audit', `audit-${key}.jsonl`)
}
const readAudit = (): string => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }

/** 审计行形态（createAuditor 直写 JSON.stringify(event)，ts 由装配层注入） */
interface AuditLine { ts?: string; type?: string; status?: string; summary?: string }

/**
 * 解析 JSONL；容忍「写入过程中的半行」（append 是逐行写，读盘可能与写并发）。
 * 解析失败**不静默丢弃**：只跳过文件末尾那一条不完整行，中段的坏行照样让用例红
 * （审计文件格式本身坏掉是必须看见的回归）。
 */
function parseAuditLines(raw: string): AuditLine[] {
  const rawLines = raw.split('\n').filter((l) => l.trim().length > 0)
  const out: AuditLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    try {
      out.push(JSON.parse(rawLines[i]) as AuditLine)
    } catch {
      if (i !== rawLines.length - 1) throw new Error(`审计 JSONL 第 ${i + 1} 行不是合法 JSON：${rawLines[i]}`)
    }
  }
  return out
}

/** 轮询到指定 type 的审计行出现，返回**全部**匹配行（不止第一条） */
async function pollAuditLines(type: string, minCount = 1): Promise<AuditLine[]> {
  let matched: AuditLine[] = []
  await expect.poll(
    () => { matched = parseAuditLines(readAudit()).filter((l) => l.type === type); return matched.length },
    { timeout: 5000, interval: 200 }
  ).toBeGreaterThanOrEqual(minCount)
  return matched
}

describe('审计应用装配（FE-S1-P1-01 #4 / M-31：解析 JSONL 断言 type+status）', () => {
  it('IPC credential set/clear 后 audit/ 出现 credential:set/clear 行，且 status 与实际 API 结果一致', async () => {
    const observed = await page.evaluate(async (): Promise<{
      credentialStatus: string
      setOk: boolean
      setErr: string | null
      clearOk: boolean
      clearErr: string | null
      setResult: string | null
      clearResult: string | null
    }> => {
      const credentialStatus = await window.desktopApi.getCredentialStatus()
      // safeStorage 可用时需要先绑定 endpoint（token 与 origin 绑定），否则抛 CREDENTIAL_UNAVAILABLE
      try { await window.desktopApi.setEndpoint('http://127.0.0.1:8765') } catch { /* 已绑定/不可用不阻断本用例 */ }
      let setOk = false
      let setErr: string | null = null
      let setResult: string | null = null
      try { setResult = await window.desktopApi.setBackendToken('sk-test-token'); setOk = true }
      catch (e: unknown) { setErr = e instanceof Error ? e.message : String(e) }
      let clearOk = false
      let clearErr: string | null = null
      let clearResult: string | null = null
      try { clearResult = await window.desktopApi.clearBackendToken(); clearOk = true }
      catch (e: unknown) { clearErr = e instanceof Error ? e.message : String(e) }
      return { credentialStatus, setOk, setErr, clearOk, clearErr, setResult, clearResult }
    })

    // M-32 可见化：本条用例实际走了哪条凭据分支（真实 OS 加密 → 'empty'；无 keyring → 'unavailable'）
    // 分支归属必须可见（M-32「让事实显式而非隐含」）
    console.log(`[audit-lifecycle] credentialStatus=${observed.credentialStatus} setOk=${observed.setOk} clearOk=${observed.clearOk}`)

    // —— 解析 JSONL 断言（不再用子串 grep）——
    const setLines = await pollAuditLines('credential:set')
    const clearLines = await pollAuditLines('credential:clear')

    for (const line of [...setLines, ...clearLines]) {
      expect(line.ts, '审计行必须带装配层注入的 ISO ts').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(['success', 'failed'], `status 必须显式落盘：${JSON.stringify(line)}`).toContain(line.status)
      expect(line.summary, `summary 应指明 key：${JSON.stringify(line)}`).toContain(`key=${BACKEND_TOKEN_KEY}`)
    }
    // status 与**实际 API 结果**对齐：这正是「sink 停止写成功记录 / 只写失败」会红的地方
    expect(setLines.map((l) => l.status), 'credential:set 的审计 status 必须与实际 setBackendToken 结果一致')
      .toEqual([observed.setOk ? 'success' : 'failed'])
    expect(clearLines.map((l) => l.status), 'credential:clear 的审计 status 必须与实际 clearBackendToken 结果一致')
      .toEqual([observed.clearOk ? 'success' : 'failed'])
    // 反向哨兵：失败分支必须留下错误码（success 分支不该有 code=）
    if (!observed.setOk) expect(setLines[0].summary).toContain('code=')
    else expect(setLines[0].summary).not.toContain('code=')

    // —— 状态变化审计（before≠after 才写，createCredentialsExecutors:26-34）——
    // set 的 status-change 依环境「起点」而有无（起点可能是 unavailable/empty/available），不断言其存在；
    // clear 的 status-change 在本环境下是确定的：set 成功后为 available，clear 后必为 empty → 必写一次。
    if (observed.setOk) {
      const changes = await pollAuditLines('credential:status-change')
      expect(changes.map((l) => l.summary), 'credential:status-change 应记录 from/to').toEqual(
        expect.arrayContaining([expect.stringContaining(`key=${BACKEND_TOKEN_KEY}`)])
      )
      expect(changes.every((l) => l.status === undefined), 'status-change 不是操作结果事件，不应带 status').toBe(true)
    }
  })
})
