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
    // 批次A desktopApi 扩展:既有 4 键(3 凭据 + getAppInfo)+ chat 11 方法 + 3 订阅 + 连接装配 3 键(setEndpoint/getEndpoint/getRuntimeInfo) = 21 键(排序断言)
    expect(surface.keys).toEqual([
      'activate', 'cancel', 'clearBackendToken', 'connect', 'createConversation', 'deleteConversation',
      'disconnect', 'getAppInfo', 'getConnectionState', 'getCredentialStatus', 'getEndpoint', 'getMessages',
      'getRuntimeInfo', 'listConversations', 'onChatEvent', 'onChatReplay', 'onChatState', 'renameConversation',
      'send', 'setBackendToken', 'setEndpoint'
    ])
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
      await window.desktopApi.setEndpoint('http://127.0.0.1:8765')   // 新规则：token 需先绑定 endpoint，否则 setBackendToken 抛 CREDENTIAL_UNAVAILABLE
      const s2 = await window.desktopApi.setBackendToken('sk-test-token')
      const s3 = await window.desktopApi.getCredentialStatus()
      const s4 = await window.desktopApi.clearBackendToken()
      return { initial, setErr: null, s1: s2, s2: s3, s3: s4 }
    })
    if (flow.initial === 'unavailable') {
      expect(flow.setErr).toContain('CREDENTIAL_UNAVAILABLE')
      expect(flow.afterClear).toBe('unavailable')
    } else {
      expect(flow.s1).toBe('available'); expect(flow.s2).toBe('available'); expect(flow.s3).toBe('empty')
    }
  })
  it('endpoint 变更后旧 token 不自动复用（绑定被清）', async () => {
    const res = await page.evaluate(async () => {
      const initial = await window.desktopApi.getCredentialStatus()
      if (initial === 'unavailable') return { skipped: true }   // safeStorage 不可用环境跳过（与凭据往返用例同款分支）
      await window.desktopApi.setEndpoint('http://127.0.0.1:8765')   // 先绑定本机
      await window.desktopApi.setBackendToken('sk-test')
      await window.desktopApi.setEndpoint('https://attacker.example') // origin 变 → 自动清 token 绑定
      return { skipped: false, status: await window.desktopApi.getCredentialStatus() }
    })
    if (res.skipped) return
    expect(res.status).toBe('empty')   // 集成套件跑 Mock（launchApp 设 CYRENE_BACKEND=mock）；真正禁止外发 token 的 connect 守卫在 Real 路径，由 chat-service 单测覆盖
  })
  it('getRuntimeInfo 返回装配模式', async () => {
    const info = await page.evaluate(() => window.desktopApi.getRuntimeInfo())
    expect(['real', 'mock']).toContain(info.mode)
    expect(typeof info.packaged).toBe('boolean')
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
