// tests/integration/ipc-security.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { IpcChannels, PushChannels } from '@shared/contracts'
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
    // 批次A desktopApi 扩展:既有 4 键(3 凭据 + getAppInfo)+ chat 11 方法 + 3 订阅 + 连接装配 3 键(setEndpoint/getEndpoint/getRuntimeInfo) = 21 键;批次B T10 加 onChatError → 22 键;阶段3 G2 加持久化面 4 键(cacheMessages/hydratePersistence/openExternal/persistSession) → 26 键;阶段3 G3 加 attachments 面 4 键(attachmentsCancel/attachmentsCheck/attachmentsUpload/attachmentsValidate) → 30 键;阶段3 G4 加历史/表情面 3 键(getMessageContext/listStickers/queryChatHistory) → 33 键;阶段4 批次A 加模型服务/TTS 面 9 键(activateModelProfile/deleteModelProfile/getActiveModelSelection/listModelProfiles/listTtsVoices/previewTts/saveModelProfile/setTtsVoice/testModelProfile) → 42 键;阶段4 批次B 加语音面 12 键(audioCancel/voiceCancelDictation/voiceCancelRealtime/voiceCommit/voiceDiscard/voiceSendAudio/voiceStartDictation/voiceStartRealtime/voiceStartRecord/voiceStopDictation/voiceStopRealtime/voiceStopRecord) + 设置面 2 键(settingsLoad/settingsSave) → 56 键;阶段5 批次A 加 Live2D 面 1 键(listLive2dModels) → 57 键;阶段6 批次B 加工具面 6 键(onToolEvent/toolCancel/toolConfirmUpload/toolDecide/toolList/toolPickSource) → 63 键
    expect(surface.keys).toEqual([
      'activate', 'activateModelProfile', 'attachmentsCancel', 'attachmentsCheck', 'attachmentsUpload', 'attachmentsValidate',
      'audioCancel',
      'cacheMessages', 'cancel', 'clearBackendToken', 'connect', 'createConversation', 'deleteConversation', 'deleteModelProfile',
      'disconnect', 'getActiveModelSelection', 'getAppInfo', 'getConnectionState', 'getCredentialStatus', 'getEndpoint', 'getMessageContext', 'getMessages',
      'getRuntimeInfo', 'hydratePersistence', 'listConversations', 'listLive2dModels', 'listModelProfiles', 'listStickers', 'listTtsVoices', 'onChatError', 'onChatEvent', 'onChatReplay', 'onChatState', 'onToolEvent',
      'openExternal', 'persistSession', 'previewTts', 'queryChatHistory', 'renameConversation', 'saveModelProfile',
      'send', 'setBackendToken', 'setEndpoint', 'setTtsVoice', 'settingsLoad', 'settingsSave', 'testModelProfile',
      'toolCancel', 'toolConfirmUpload', 'toolDecide', 'toolList', 'toolPickSource',
      'voiceCancelDictation', 'voiceCancelRealtime', 'voiceCommit', 'voiceDiscard', 'voiceSendAudio',
      'voiceStartDictation', 'voiceStartRealtime', 'voiceStartRecord', 'voiceStopDictation', 'voiceStopRealtime', 'voiceStopRecord'
    ])
    expect(surface.hasIpc).toBe(false)
    expect(surface.hasRequire).toBe('undefined')
    expect(surface.hasProcess).toBe('undefined')
  })
  it('chat:error 是纯 push 通道:不入 IpcChannels invoke 枚举(M4)', async () => {
    // Main→Renderer 推送通道只经 preload 的 ipcRenderer.on 订阅,绝无 invoke 语义;
    // PushChannels.error 必须存在于推送集合,且不出现在任何命令式 invoke 通道枚举里。
    expect(PushChannels.error).toBe('chat:error')
    expect(Object.values(IpcChannels)).not.toContain('chat:error')
    // 订阅面含 onChatError(纯 push 订阅方法;22 键白名单已含该键)
    const hasSub = await page.evaluate(() => typeof window.desktopApi.onChatError === 'function')
    expect(hasSub).toBe(true)
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
