// tests/unit/diagnostics-handlers.spec.ts（node）
// Task 5（阶段 7 批次 A，spec §6.2）：诊断 IPC 五 invoke 通道 handler 接线——
// registerDiagnosticsHandlers 经 createIpcHandler（双向 zod）+ registerHandler（可信 sender/arity 守卫）。
// electron mock 先例（voice-handlers.spec 同款）：捕获 ipcMain.handle 的 listener 后直调（伪造可信 sender），
// 验证装配接线 + schema 畸形 + 非受信 sender 拒绝。preload 面（desktopApi 六键）由 ipc-security 集成白名单
// 67→73 断言 + DesktopApiLike mock 编译覆盖（本 task Step 4/5；preload 运行时接线归集成 Task 8）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels, type DiagnosticsExportResult, type DiagnosticsState, type IpcResult } from '@shared/contracts'
import { DiagnosticsStateSchema, DiagnosticsExportResultSchema } from '@shared/schemas'
import { diagnosticsDevModeSetSchema } from '../../src/main/ipc/channels'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'
import type { Logger } from '../../src/main/diagnostics/logger'

const sanitize: MessageSanitizer = (m) => m

// —— electron mock：registry 无 getter，经 ipcMain.handle 捕获 listener 再直调（伪造可信 sender）——
const { mockIpcMain, getListeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    mockIpcMain: {
      handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => { listeners.set(channel, listener) }),
      on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => { listeners.set(channel, listener) })
    },
    getListeners: () => listeners
  }
})
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: mockIpcMain }))

const fakeMainFrame = { url: 'cyrene://renderer/index.html' } // P2-01：isTrustedSenderFor 要求 senderFrame === webContents.mainFrame 且 URL 受信
const fakeWindow = { isDestroyed: () => false, webContents: { id: 1, mainFrame: fakeMainFrame } }
const fakeEvent = { sender: fakeWindow.webContents, senderFrame: fakeMainFrame }
/** 非受信 frame URL（http 非回环/非白名单）→ isAppRendererUrl false */
const evilEvent = { sender: fakeWindow.webContents, senderFrame: { url: 'http://evil.example/x' } }

beforeEach(() => {
  getListeners().clear()
  mockIpcMain.handle.mockClear()
  mockIpcMain.on.mockClear()
})

/** DiagnosticsState 合法夹具（strict schema 全字段：devMode/displayDir/logSizeBytes/logFiles/retentionDays/auditRetentionDays/eventDropped/lastCleanup） */
function stateFixture(): DiagnosticsState {
  return {
    devMode: false,
    displayDir: '~/.../logs',
    logSizeBytes: 42,
    logFiles: [{ name: 'app.log', sizeBytes: 42, modifiedAt: '2026-08-22T00:00:00.000Z' }],
    retentionDays: 3,
    auditRetentionDays: 30,
    eventDropped: 0,
    lastCleanup: null,
  }
}

function exportFixture(): DiagnosticsExportResult {
  return { cancelled: false, displayPath: '~/diagnose.json', sizeBytes: 100, truncatedLog: false, truncatedAudit: false }
}

function makeService() {
  return {
    getState: vi.fn(() => stateFixture()),
    setDevMode: vi.fn(),
    openLogDir: vi.fn(async () => {}),
    clearLogs: vi.fn(async () => {}),
    exportPackage: vi.fn(async () => exportFixture()),
    dispose: vi.fn(),
  }
}

type ServiceLike = ReturnType<typeof makeService>

/** 每次 resetModules + 动态 import 拿全新 registry/diagnostics-handlers（registry 的 registered Set 模块级，避免重复注册抛错） */
async function registerOnce(service: ServiceLike): Promise<{ invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>>; logger: Logger }> {
  vi.resetModules()
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() } as unknown as Logger
  const { setMainWindow } = await import('../../src/main/ipc/registry')
  const { registerDiagnosticsHandlers } = await import('../../src/main/ipc/diagnostics-handlers')
  setMainWindow(fakeWindow as never)
  registerDiagnosticsHandlers({ service: service, sanitize, logger })
  return {
    invoke: (channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      const listener = getListeners().get(channel)
      if (!listener) throw new Error(`通道未注册: ${channel}`)
      return listener(fakeEvent, ...args) as Promise<IpcResult<unknown>>
    },
    logger,
  }
}

describe('registerDiagnosticsHandlers 真实接线（electron mock 捕获 ipcMain.handle）', () => {
  it('diagnostics:state 接线——service.getState + DiagnosticsStateSchema 合法响应', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsState)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(DiagnosticsStateSchema.safeParse(res.data).success).toBe(true) // 响应经契约 schema 校验（服务夹具合法）
      expect(res.data).toEqual(stateFixture())
    }
    expect(service.getState).toHaveBeenCalledTimes(1)
  })
  it('diagnostics:dev-mode-set {enabled:true}——service.setDevMode(true) + z.undefined 响应', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsDevModeSet, { enabled: true })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toBeUndefined()
    expect(service.setDevMode).toHaveBeenCalledWith(true)
  })
  it('diagnostics:open-log-dir——service.openLogDir + z.undefined 响应（arity 0）', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsOpenLogDir)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toBeUndefined()
    expect(service.openLogDir).toHaveBeenCalledTimes(1)
  })
  it('diagnostics:clear-logs——service.clearLogs + z.undefined 响应（arity 0）', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsClearLogs)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toBeUndefined()
    expect(service.clearLogs).toHaveBeenCalledTimes(1)
  })
  it('diagnostics:export——service.exportPackage + DiagnosticsExportResultSchema 合法响应（cancelled:false 分支）', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsExport)
    expect(res.ok).toBe(true)
    if (res.ok) expect(DiagnosticsExportResultSchema.safeParse(res.data).success).toBe(true)
    expect(service.exportPackage).toHaveBeenCalledTimes(1)
  })
  it('diagnostics:last-crash（阶段 7 批次 B Task 2）——直 import getCrashMarker，无崩溃 → ok data null（arity 0 + RendererCrashEventSchema.nullable 响应）', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsLastCrash)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toBeNull() // getCrashMarker 模块级初始 null（一次性读后清）
  })
  it('schema 畸形（enabled:"yes"）→ SCHEMA_VALIDATION_FAILED 且不调 service.setDevMode', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    expect(diagnosticsDevModeSetSchema.safeParse({ enabled: 'yes' }).success).toBe(false) // 先验 schema 拒绝
    const res = await invoke(IpcChannels.diagnosticsDevModeSet, { enabled: 'yes' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(service.setDevMode).not.toHaveBeenCalled()
  })
  it('非受信 sender → 拒绝（registry trusted 门复用：ok:false UNKNOWN「拒绝」）', async () => {
    const service = makeService()
    const { invoke: trustedInvoke } = await registerOnce(service)
    expect(trustedInvoke).toBeTypeOf('function') // 保证 registerOnce 已装配（listener 捕获完成）
    const listener = getListeners().get(IpcChannels.diagnosticsState)
    expect(listener).toBeDefined()
    const res = await listener!(evilEvent) as IpcResult<unknown>
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toBe('拒绝')
    expect(service.getState).not.toHaveBeenCalled() // 拒绝面不触达服务
  })
  it('arity 不走（diagnostics:state 带载荷）→ SCHEMA_VALIDATION_FAILED（registry 精确匹配）', async () => {
    const service = makeService()
    const { invoke } = await registerOnce(service)
    const res = await invoke(IpcChannels.diagnosticsState, { unexpected: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(service.getState).not.toHaveBeenCalled()
  })
})
