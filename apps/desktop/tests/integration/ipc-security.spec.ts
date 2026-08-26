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
    // 批次A desktopApi 扩展:既有 4 键(3 凭据 + getAppInfo)+ chat 11 方法 + 3 订阅 + 连接装配 3 键(setEndpoint/getEndpoint/getRuntimeInfo) = 21 键;批次B T10 加 onChatError → 22 键;阶段3 G2 加持久化面 4 键(cacheMessages/hydratePersistence/openExternal/persistSession) → 26 键;阶段3 G3 加 attachments 面 4 键(attachmentsCancel/attachmentsCheck/attachmentsUpload/attachmentsValidate) → 30 键;阶段3 G4 加历史/表情面 3 键(getMessageContext/listStickers/queryChatHistory) → 33 键;阶段4 批次A 加模型服务/TTS 面 9 键(activateModelProfile/deleteModelProfile/getActiveModelSelection/listModelProfiles/listTtsVoices/previewTts/saveModelProfile/setTtsVoice/testModelProfile) → 42 键;阶段4 批次B 加语音面 12 键(audioCancel/voiceCancelDictation/voiceCancelRealtime/voiceCommit/voiceDiscard/voiceSendAudio/voiceStartDictation/voiceStartRealtime/voiceStartRecord/voiceStopDictation/voiceStopRealtime/voiceStopRecord) + 设置面 2 键(settingsLoad/settingsSave) → 56 键;阶段5 批次A 加 Live2D 面 1 键(listLive2dModels) → 57 键;阶段6 批次B 加工具面 6 键(onToolEvent/toolCancel/toolConfirmUpload/toolDecide/toolList/toolPickSource) → 63 键;阶段6 批次C 加目录授权/审批历史面 4 键(toolGrantDirectory/toolListGrants/toolRevokeGrant/toolListHistory) → 67 键;阶段7 批次A（Task 5）加诊断面 6 键(diagnosticsClearLogs/diagnosticsDevModeSet/diagnosticsExport/diagnosticsOpenLogDir/diagnosticsState/onDiagnosticsDevEvent) → 73 键(契约 R2-1 定名:export 为 JS 保留字→diagnosticsExport);阶段7批次B（Task 1）加 getLastCrash → 74 键
    expect(surface.keys).toEqual([
      'activate', 'activateModelProfile', 'attachmentsCancel', 'attachmentsCheck', 'attachmentsUpload', 'attachmentsValidate',
      'audioCancel',
      'cacheMessages', 'cancel', 'clearBackendToken', 'connect', 'createConversation', 'deleteConversation', 'deleteModelProfile',
      'diagnosticsClearLogs', 'diagnosticsDevModeSet', 'diagnosticsExport', 'diagnosticsOpenLogDir', 'diagnosticsState',
      'disconnect', 'getActiveModelSelection', 'getAppInfo', 'getConnectionState', 'getCredentialStatus', 'getEndpoint', 'getLastCrash', 'getMessageContext', 'getMessages',
      'getRuntimeInfo', 'hydratePersistence', 'listConversations', 'listLive2dModels', 'listModelProfiles', 'listStickers', 'listTtsVoices', 'onChatError', 'onChatEvent', 'onChatReplay', 'onChatState', 'onDiagnosticsDevEvent', 'onToolEvent',
      'openExternal', 'persistSession', 'previewTts', 'queryChatHistory', 'renameConversation', 'saveModelProfile',
      'send', 'setBackendToken', 'setEndpoint', 'setTtsVoice', 'settingsLoad', 'settingsSave', 'testModelProfile',
      'toolCancel', 'toolConfirmUpload', 'toolDecide', 'toolGrantDirectory', 'toolList', 'toolListGrants', 'toolListHistory', 'toolPickSource', 'toolRevokeGrant',
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
  it('diagnostics:dev-event 是纯 push 通道:不入 IpcChannels invoke 枚举(契约 R2-1)', async () => {
    // 阶段 7 批次 A(Task 5):diagnostics:dev-event=Main→Renderer 下行(M2 契约——不入 registerHandler 面);
    // 订阅面 onDiagnosticsDevEvent 为 preload ipcRenderer.on(push 通道 + DiagnosticsDevEventSchema 校验)。
    expect(PushChannels.diagnosticsDevEvent).toBe('diagnostics:dev-event')
    expect(Object.values(IpcChannels)).not.toContain('diagnostics:dev-event')
    const hasSub = await page.evaluate(() => typeof window.desktopApi.onDiagnosticsDevEvent === 'function')
    expect(hasSub).toBe(true)
  })
  it('diagnostics:last-crash 是纯 invoke 通道:不入 PushChannels 推送枚举(阶段 7 批次 B Task 1)', async () => {
    // Renderer 崩溃后已死,Mark 落盘,后续经 getLastCrash invoke 一次性读回——故为命令式 invoke 通道,
    // 绝不入 Main→Renderer 推送集合(PushChannels),也无 ipcRenderer.on 订阅语义。
    expect(Object.values(PushChannels)).not.toContain('diagnostics:last-crash')
    expect(Object.values(IpcChannels)).toContain('diagnostics:last-crash')
    // preload 暴露 getLastCrash(invoke 一次性读后清空;74 键白名单已含该键)
    const hasHandler = await page.evaluate(() => typeof window.desktopApi.getLastCrash === 'function')
    expect(hasHandler).toBe(true)
  })
  it('renderer:crash 是纯 push 占位通道:不入 IpcChannels invoke 枚举(阶段 7 批次 B Task 1)', async () => {
    // renderer:crash 为 Main→Renderer 下行推送占位(契约层明示不实际发送——Renderer 已死收不到,实际走 getLastCrash invoke);
    // PushChannels.rendererCrash 必须存在于推送集合,且不出现在任何命令式 invoke 通道枚举里,也无 preload 订阅方法。
    expect(PushChannels.rendererCrash).toBe('renderer:crash')
    expect(Object.values(IpcChannels)).not.toContain('renderer:crash')
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
  it('未知通道 invoke → 未注册通道报错（Electron 层拒绝语义；spec §4.2）', async () => {
    // 测试专用窗口：nodeIntegration 仅为本断言触达原始 ipcRenderer（应用面 desktopApi 恒窄——第 1 条白名单用例已钉）；
    // 断言标的 = Electron「ipcMain.handle 未注册名 invoke 必须 reject」本身（预载面/prod 面无此通道可达性——M2 契约）。
    // 用后即刻销毁；与既有「非主窗口 webContents invoke」夹具窗口同族（测试专用 BrowserWindow 先例）。
    const res = await app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } })
      await win.loadURL('about:blank')
      try {
        const out = await win.webContents.executeJavaScript(
          "require('electron').ipcRenderer.invoke('cy:nonexistent-channel-xyz').then((r) => 'ok:' + JSON.stringify(r)).catch((e) => 'err:' + e.message)"
        )
        return { out }
      } catch (e: unknown) { return { out: 'exec-fail:' + String(e) } }
      finally { win.destroy() }
    })
    expect(res.out).toMatch(/^err:/)
    expect(res.out).toMatch(/no handler registered/i)
  })
  it('超大对象入参（>4MiB 结构）→ 通道级边界拒（IPC_MESSAGE_TOO_LARGE；spec §4.2）', async () => {
    const err = await page.evaluate(async () => {
      try {
        const big = 'x'.repeat(4.5 * 1024 * 1024)   // 4.5MiB 单结构——超 MAX_IPC_MESSAGE_BYTES（4MiB，ipc.ts:96）
        await window.desktopApi.cacheMessages({
          conversationId: 'conv-oversize',
          updatedAt: new Date().toISOString(),
          messages: [{ messageId: 'm-oversize', conversationId: 'conv-oversize', role: 'user', status: 'completed', createdAt: new Date().toISOString(), content: big }],
        })
        return null
      } catch (e: unknown) { return e instanceof Error ? e.message : String(e) }
    })
    expect(err).toBeTruthy()
    expect(err).toContain('IPC_MESSAGE_TOO_LARGE')
  })
  it('类型混淆抽样（数字/布尔冒充字符串等）→ SCHEMA_VALIDATION_FAILED（spec §4.2）', async () => {
    const errs = await page.evaluate(async () => {
      const out: string[] = []
      const attempts: Array<() => Promise<unknown>> = [
        () => window.desktopApi.setBackendToken(123 as unknown as string),
        () => window.desktopApi.setEndpoint(42 as unknown as string),
        () => window.desktopApi.diagnosticsDevModeSet('yes' as unknown as boolean),
      ]
      for (const attempt of attempts) {
        try { await attempt(); out.push('ok') }
        catch (e: unknown) { out.push(e instanceof Error ? e.message : String(e)) }
      }
      return out
    })
    expect(errs.length).toBe(3)
    for (const err of errs) expect(err).toContain('SCHEMA_VALIDATION_FAILED')
  })
  it('openExternal >2048 字符 → 拒（SCHEMA_VALIDATION_FAILED；task-1-med1 待办收口）', async () => {
    const err = await page.evaluate(async () => {
      try { await window.desktopApi.openExternal(`https://example.com/${'x'.repeat(2100)}`); return null }
      catch (e: unknown) { return e instanceof Error ? e.message : String(e) }
    })
    expect(err).toBeTruthy()
    expect(err).toContain('SCHEMA_VALIDATION_FAILED')
    // 正方向未被 2048 破坏：monkeypatch shell.openExternal（navigation.spec 先例）记录 → 合法 ≤2048 URL 到达打开层
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __ext: string[] }
      g.__ext = []
      shell.openExternal = (u: string): Promise<void> => { g.__ext.push(u); return Promise.resolve() }
    })
    const ok = await page.evaluate(async () => {
      try { await window.desktopApi.openExternal('https://example.com/ok'); return 'ok' }
      catch (e: unknown) { return 'err:' + (e instanceof Error ? e.message : String(e)) }
    })
    expect(ok).toBe('ok')
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __ext: string[] }).__ext), { timeout: 5000, interval: 200 })
      .toContain('https://example.com/ok')
  })
})

describe('路径/重放/授权后参数引用断言（spec §1.1-3——阶段 6 实现证据「引用 + 无回退」哨兵；L-14）', () => {
  // 口径（plan Task 8 集成扩展段）：引用既有阶段 6 验证过的实现面（safe-open Windows 变体/UNC/ADS、
  // paramHash canonical、callId 幂等、queryStatus 三分支）——不重写实现、不复制行为断言
  // （行为权威面在阶段 6 单测 tool-service.spec/param-hash.spec/safe-open.spec），本层钉「走查发现点
  // 的导出仍存在 + 语义常量未回退」，防后续改造静默移除/改名。
  it('safe-open：Windows 语义注入体（preOpenLstat/checkModeMask）+ 默认平台选择（引用哨兵）', async () => {
    const { posixPlatform, windowsPlatform, defaultSafeOpenPlatform } = await import('../../src/main/persistence/safe-open')
    expect(posixPlatform.kind).toBe('posix')
    expect(windowsPlatform.kind).toBe('windows')
    expect(windowsPlatform.preOpenLstat).toBe(true)    // Windows 无 O_NOFOLLOW → open 前 lstat 拒 symlink
    expect(windowsPlatform.checkModeMask).toBe(false)  // NTFS 合成权限位跳过
    expect(posixPlatform.checkModeMask).toBe(true)     // POSIX existing 校验权限位（0400/0404 拒——批次 C 修复）
    expect(typeof defaultSafeOpenPlatform()).toBe('object')
  })
  it('paramHash canonical：canonicalJsonStringify 键序稳定 + computeParamHash 确定性/敏感性（引用哨兵）', async () => {
    const { canonicalJsonStringify, computeParamHash } = await import('../../src/main/tools/param-hash')
    expect(canonicalJsonStringify({ a: 1, b: 2 })).toBe(canonicalJsonStringify({ b: 2, a: 1 }))
    const h = computeParamHash({ path: '/p', args: { x: 1 } })
    expect(computeParamHash({ path: '/p', args: { x: 1 } })).toBe(h)
    expect(computeParamHash({ path: '/p', args: { x: 2 } })).not.toBe(h)
  })
  it('调用幂等/值校验优先级/queryStatus 数据源哨兵（真实行为面归阶段 6 单测——本层钉模块面不灭）', async () => {
    const { PATH_BLACKLIST_DEFAULTS, isPathBlacklisted, normalizeToolPath } = await import('../../src/main/tools/tool-policy')
    const { TOOL_NAMES, DESKTOP_TOOL_VERSION } = await import('../../src/main/tools/tool-registry')
    const toolService = await import('../../src/main/tools/tool-service')
    expect(PATH_BLACKLIST_DEFAULTS.length).toBeGreaterThan(0)     // 黑名单预置非空（可注入 replace——路径面归阶段 6）
    expect(typeof isPathBlacklisted).toBe('function')
    expect(typeof normalizeToolPath).toBe('function')
    expect(TOOL_NAMES).toEqual(['desktop.file.select', 'desktop.file.read', 'desktop.file.write', 'desktop.screen.capture'])
    expect(DESKTOP_TOOL_VERSION).toBe('1.0.0')
    // “callId 幂等（canonicalJsonStringify 比对）+ paramHash 重算校验 + queryStatus 三分支（L-1/完成/失败）”
    // 为 tool-service 内部行为——此处以「服务工厂/决策链入口仍存在」钉住实现面（行为测试在阶段 6 单测子集）
    expect(typeof toolService.createToolService).toBe('function')
  })
})
