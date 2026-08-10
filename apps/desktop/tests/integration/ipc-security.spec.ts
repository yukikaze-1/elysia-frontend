// tests/integration/ipc-security.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })

describe('IPC 安全', () => {
  it('desktopApi 只暴露白名单方法（无 raw ipcRenderer/任意通道）', async () => {
    const surface = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      return {
        keys: Object.keys((w.desktopApi as object | undefined) ?? {}).sort(),
        hasIpc: !!w.ipcRenderer,
        hasRequire: typeof w.require,
        hasProcess: typeof w.process
      }
    })
    expect(surface.keys).toEqual(['clearBackendToken', 'getAppInfo', 'getCredentialStatus', 'setBackendToken'])
    expect(surface.hasIpc).toBe(false)
    expect(surface.hasRequire).toBe('undefined')
    expect(surface.hasProcess).toBe('undefined')
  })
  it('超大输入 → SCHEMA_VALIDATION_FAILED', async () => {
    const err = await page.evaluate(async () => {
      try { await window.desktopApi.setBackendToken('x'.repeat(4097)); return null }
      catch (e: unknown) { return e instanceof Error ? e.message : String(e) }
    })
    expect(err).toContain('SCHEMA_VALIDATION_FAILED')
  })
  it('空串 → SCHEMA_VALIDATION_FAILED', async () => {
    const err = await page.evaluate(async () => {
      try { await window.desktopApi.setBackendToken(''); return null }
      catch (e: unknown) { return e instanceof Error ? e.message : String(e) }
    })
    expect(err).toContain('SCHEMA_VALIDATION_FAILED')
  })
  it('凭据往返按 safeStorage 可用性分支断言', async () => {
    const flow = await page.evaluate(async (): Promise<{
      initial: string; setErr: string | null; s1?: string; s2?: string; s3?: string; afterClear?: string
    }> => {
      const initial = await window.desktopApi.getCredentialStatus()
      if (initial === 'unavailable') {
        let setErr: string | null = null
        try { await window.desktopApi.setBackendToken('sk-test-token') } catch (e: unknown) { setErr = e instanceof Error ? e.message : String(e) }
        const afterClear = await window.desktopApi.clearBackendToken()
        return { initial, setErr, afterClear }
      }
      const s1 = await window.desktopApi.setBackendToken('sk-test-token')
      const s2 = await window.desktopApi.getCredentialStatus()
      const s3 = await window.desktopApi.clearBackendToken()
      return { initial, setErr: null, s1, s2, s3 }
    })
    if (flow.initial === 'unavailable') {
      expect(flow.setErr).toContain('CREDENTIAL_UNAVAILABLE')
      expect(flow.afterClear).toBe('unavailable')
    } else {
      expect(flow.s1).toBe('available'); expect(flow.s2).toBe('available'); expect(flow.s3).toBe('empty')
    }
  })
  it('非主窗口 webContents invoke → 被 isTrustedSender 拒绝（来源校验）', async () => {
    const res = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const hidden = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await hidden.loadURL('about:blank')
      try {
        const outcome = await hidden.webContents.executeJavaScript('window.desktopApi.getAppInfo()')
        return { ok: true, outcome }
      } catch (e: unknown) { return { ok: false, err: String(e) } }
      finally { hidden.destroy() }
    }, join(__dirname, '../../out/preload/index.js')) // tests/integration → apps/desktop/out/preload/index.js
    expect(res.ok).toBe(false)
    expect(res.err).toContain('拒绝')
  })
})
