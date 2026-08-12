// tests/integration/audit-lifecycle.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
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

describe('审计应用装配（FE-S1-P1-01 #4）', () => {
  it('IPC credential set/clear 后 audit/ 出现 credential:set/clear 行', async () => {
    await page.evaluate(async () => {
      const initial = await window.desktopApi.getCredentialStatus()
      try {
        await window.desktopApi.setEndpoint('http://127.0.0.1:8765')
        await window.desktopApi.setBackendToken('sk-test-token')
      } catch { /* safeStorage 不可用分支：审计仍写 credential:set failed */ }
      try { await window.desktopApi.clearBackendToken() } catch { /* 同 */ }
      void initial
    })
    // 轮询（fire-and-forget 竞态）：断言 set 与 clear 行都出现
    await expect.poll(() => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }, { timeout: 5000, interval: 200 })
      .toContain('credential:set')
    await expect.poll(() => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }, { timeout: 5000, interval: 200 })
      .toContain('credential:clear')
  })
})
