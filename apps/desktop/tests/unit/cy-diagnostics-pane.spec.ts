// @vitest-environment happy-dom
// tests/unit/cy-diagnostics-pane.spec.ts
// 阶段 7 批次 A（Task 6）：CyDiagnosticsPane 四分区——日志管理/开发者模式/连接诊断/脱敏诊断导出。
// 环境 happy-dom：Vue Test Utils 挂载（cy-security-pane.spec 同款先例）；window.confirm（happy-dom 未实现）
// 经 vi.stubGlobal 注入（组件内 window.confirm 调用——真实 Electron 渲染进程存在）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import CyDiagnosticsPane from '../../src/renderer/src/components/CyDiagnosticsPane.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import type { DiagnosticsDevEvent, DiagnosticsExportResult, DiagnosticsState } from '@shared/contracts'
import type { PublicToolEvent } from '@shared/contracts/tool'

// —— Core 全局桩（本 spec 经 useLive2dStore → controller → adapter → @framework 模块作用域枚举在 import 时
//   访问 Live2DCubismCore；happy-dom 无该全局——与 live2d-panel.spec 同款先例）——
vi.hoisted(() => {
  const names = [
    'Normal', 'AddGlow', 'Add', 'Darken', 'Multiply', 'ColorBurn', 'LinearBurn', 'Lighten', 'Screen',
    'ColorDodge', 'Overlay', 'SoftLight', 'HardLight', 'LinearLight', 'Hue', 'Color',
    'AddCompatible', 'MultiplyCompatible'
  ] as const
  const ColorBlendType: Record<string, number> = {}
  names.forEach((n, i) => { ColorBlendType[`ColorBlendType_${n}`] = i })
  ;(globalThis as Record<string, unknown>).Live2DCubismCore = { ColorBlendType }
})

/** 开发者模式二次确认固定文案（brief/spec §6.4——必须逐字逐标点相同，防误触边界说明收紧的回归哨兵） */
const DEV_MODE_CONFIRM = 'DevTools 可查看当前页面 DOM 与正在输入的内容；已保存凭据不可读回；远程调试端口始终关闭；重启后自动关闭'

/** DiagnosticsState 合法夹具（镜像 diagnostics-handlers.spec stateFixture 全字段形态；lastCleanup 初始 null） */
function makeState(): DiagnosticsState {
  return {
    devMode: false,
    displayDir: '~/.../logs',          // sanitize 后展示形态（绝对路径不上行，M-2）——直接显示
    logSizeBytes: 2048,
    logFiles: [
      { name: 'app.log', sizeBytes: 512, modifiedAt: '2026-08-22T03:00:00.000Z' },
      { name: 'app-2.log', sizeBytes: 1536, modifiedAt: '2026-08-21T03:00:00.000Z' },
    ],
    retentionDays: 3,
    auditRetentionDays: 30,
    eventDropped: 2,
    lastCleanup: null,
  }
}

function toolFixture(): PublicToolEvent {
  return { id: 't1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status: 'completed', occurredAt: '2026-08-22T00:00:00.000Z' }
}

let stateObj: DiagnosticsState
let devHandler: ((ev: DiagnosticsDevEvent) => void) | undefined
let devUnsub: (() => void) | undefined
let confirmFn: ReturnType<typeof vi.fn>

/** 可控 deferred（in-flight 挂起/恢复——诊断导出去重时序断言） */
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** 诊断六键 mock（desktopApi 六键全 mock；toolList 供 dev 工具清单元数据）——
 *  不在此断言 DesktopApiLike（保留 vi.fn 方法类型），setDesktopApi 处 cast（cy-security-pane 同款） */
const api = {
  diagnosticsState: vi.fn(),
  diagnosticsDevModeSet: vi.fn(),
  diagnosticsOpenLogDir: vi.fn(async () => {}),
  diagnosticsClearLogs: vi.fn(),
  diagnosticsExport: vi.fn(),
  onDiagnosticsDevEvent: vi.fn((h: (ev: DiagnosticsDevEvent) => void): (() => void) => {
    devHandler = h
    devUnsub = vi.fn()
    return devUnsub
  }),
  toolList: vi.fn(),
}

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  stateObj = makeState()
  devHandler = undefined
  devUnsub = undefined
  confirmFn = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmFn)
  vi.clearAllMocks()
  api.diagnosticsState.mockResolvedValue(stateObj)                    // 引用共享：set/clear mock 就地 mutate → 刷新可见
  api.diagnosticsDevModeSet.mockImplementation(async (enabled: boolean) => { stateObj.devMode = enabled })
  api.diagnosticsClearLogs.mockImplementation(async () => { stateObj.lastCleanup = { removedFiles: 3, freedBytes: 20480 } })
  api.diagnosticsExport.mockResolvedValue({ cancelled: false, displayPath: '~/diagnose.json', sizeBytes: 100, truncatedLog: false, truncatedAudit: false } satisfies DiagnosticsExportResult)
  api.toolList.mockResolvedValue([toolFixture()])
  setDesktopApi(createDesktopApiMock(api))   // I-06 / P2-10：原为 `api as unknown as DesktopApiLike`
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountPane() {
  const w = mount(CyDiagnosticsPane, { global: { plugins: [pinia] } })
  await flushPromises()
  return w
}

describe('CyDiagnosticsPane 四分区（日志管理/开发者模式/连接诊断/脱敏诊断导出）', () => {
  it('挂载 → diagnosticsState 被调；日志管理渲染 displayDir/大小/保留期/文件列表/丢弃计数', async () => {
    const w = await mountPane()
    expect(api.diagnosticsState).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="diag-log-dir"]').text()).toBe('~/.../logs')     // sanitize 形态直接显示
    expect(w.find('[data-testid="diag-log-size"]').text()).toContain('2 KB')
    expect(w.find('[data-testid="diag-log-retention"]').text()).toContain('日志轮转 5MB×3 份')
    expect(w.find('[data-testid="diag-log-retention"]').text()).toContain('审计保留 30 天')
    expect(w.find('[data-testid="diag-log-files"]').text()).toContain('app.log')
    expect(w.find('[data-testid="diag-log-dropped"]').text()).toContain('2')
  })

  it('清理：confirm（防误触）→ diagnosticsClearLogs → 刷新后「已清理 N 文件/释放 M 字节」回显', async () => {
    const w = await mountPane()
    await w.find('[data-testid="diag-log-clear"]').trigger('click')
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0]?.[0]).toContain('不可撤销')
    await flushPromises()
    expect(api.diagnosticsClearLogs).toHaveBeenCalledTimes(1)
    expect(api.diagnosticsState).toHaveBeenCalledTimes(2)   // 挂载一次 + 清后刷新一次
    const el = w.find('[data-testid="diag-cleanup-result"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('已清理 3 个文件')
    expect(el.text()).toContain('释放 20 KB')
  })

  it('清理：confirm 拒绝 → 不调用 diagnosticsClearLogs', async () => {
    confirmFn.mockReturnValue(false)
    const w = await mountPane()
    await w.find('[data-testid="diag-log-clear"]').trigger('click')
    expect(api.diagnosticsClearLogs).not.toHaveBeenCalled()
  })

  it('开发者模式开启：confirm（固定文案）→ diagnosticsDevModeSet(true) → banner「开发者模式已开启」+ badge', async () => {
    const w = await mountPane()
    await w.find('[data-testid="diag-dev-toggle"]').trigger('click')
    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn.mock.calls[0]?.[0]).toBe(DEV_MODE_CONFIRM)   // 固定串逐字一致
    await flushPromises()
    expect(api.diagnosticsDevModeSet).toHaveBeenCalledWith(true)
    expect(w.find('[data-testid="diag-dev-banner"]').exists()).toBe(true)
    expect(w.find('[data-testid="diag-dev-banner"]').text()).toContain('开发者模式已开启')
    expect(w.find('[data-testid="diag-dev-badge"]').exists()).toBe(true)
  })

  it('开发者模式二次确认拒绝 → 不调用 diagnosticsDevModeSet', async () => {
    confirmFn.mockReturnValue(false)
    const w = await mountPane()
    await w.find('[data-testid="diag-dev-toggle"]').trigger('click')
    expect(api.diagnosticsDevModeSet).not.toHaveBeenCalled()
  })

  it('dev 事件：onDiagnosticsDevEvent 注册；收到事件渲染列表（type/preview）', async () => {
    stateObj.devMode = true                                      // 展示项仅 devMode 时渲染
    const w = await mountPane()
    expect(api.onDiagnosticsDevEvent).toHaveBeenCalledTimes(1)
    expect(devHandler).toBeDefined()
    devHandler!({ ts: '2026-08-22T03:00:00.000Z', type: 'generation.started', preview: 'gen_1 · 32 tokens' })
    await nextTick()
    const list = w.find('[data-testid="diag-dev-events"]')
    expect(list.exists()).toBe(true)
    expect(list.text()).toContain('generation.started')
    expect(list.text()).toContain('gen_1 · 32 tokens')
  })

  it('卸载 → 退订 dev 事件（unsubscribe 被调）', async () => {
    const w = await mountPane()
    expect(devUnsub).toBeDefined()
    w.unmount()
    expect(devUnsub!).toHaveBeenCalledTimes(1)
  })

  it('在途卸载（diagnosticsState 未 resolve 时就卸载）→ **不建立**订阅（修复前订阅照建、无人拆除 ⇒ 永久驻留）', async () => {
    // 2026-09-16 审计 P2：订阅建在 `await api.diagnosticsState()` 之后，而 onBeforeUnmount 早已跑过
    // （那时 unsubDev 还是 null）⇒ 每"挂载后在途卸载"一次泄漏一个订阅。判据：卸载标记在订阅前被复查。
    let release: (s: typeof stateObj) => void = () => {}
    api.diagnosticsState.mockReturnValue(new Promise((r) => { release = r }))
    const w = mount(CyDiagnosticsPane, { global: { plugins: [pinia] } })
    await nextTick()
    w.unmount()                       // state 仍在途即卸载
    release(stateObj)
    await flushPromises()
    expect(api.onDiagnosticsDevEvent).not.toHaveBeenCalled()   // 修复前这里是 1（订阅被建出来且永不拆除）
    expect(devUnsub).toBeUndefined()
  })

  it('dev 展示项仅 devMode 时渲染（关闭时无 banner/事件/工具/store 摘要/性能/日志链接）', async () => {
    const w = await mountPane()
    expect(w.find('[data-testid="diag-dev-banner"]').exists()).toBe(false)
    expect(w.find('[data-testid="diag-dev-events"]').exists()).toBe(false)
    expect(w.find('[data-testid="diag-dev-tools"]').exists()).toBe(false)
    expect(w.find('[data-testid="diag-dev-store"]').exists()).toBe(false)
    expect(w.find('[data-testid="diag-dev-perf"]').exists()).toBe(false)
    expect(w.find('[data-testid="diag-dev-log-link"]').exists()).toBe(false)
  })

  it('devMode 时 Store 摘要与工具清单渲染（连接状态/origin/会话 id/消息计数/语音枚举——无消息正文）', async () => {
    stateObj.devMode = true
    useConnectionStore().setState({ status: 'connected', serverUrl: 'http://127.0.0.1:8000', protocolVersion: '2.0' })
    useConversationStore().currentId = 'conv_1'
    useMessageStore().order.splice(0, 0, 'm1', 'm2')            // 计数来源：当前会话消息 id 列表
    const w = await mountPane()
    const store = w.find('[data-testid="diag-dev-store"]')
    expect(store.exists()).toBe(true)
    expect(store.text()).toContain('已连接')
    expect(store.text()).toContain('http://127.0.0.1:8000')
    expect(store.text()).toContain('conv_1')
    expect(w.find('[data-testid="diag-store-messages"]').text()).toBe('2')
    expect(w.find('[data-testid="diag-store-voice"]').text()).toBe('空闲')
    expect(w.find('[data-testid="diag-dev-tools"]').text()).toContain('desktop.file.read')
    // Live2D 性能读数：空态（happy-dom 未挂 Live2D controller → getStats null → 显示未启动）
    expect(w.find('[data-testid="diag-dev-perf"]').text()).toContain('未启动')
  })

  it('导出成功 → 结果（displayPath）提示显示；cancelled 分支无提示', async () => {
    const w = await mountPane()
    await w.find('[data-testid="diag-export"]').trigger('click')
    await flushPromises()
    expect(api.diagnosticsExport).toHaveBeenCalledTimes(1)
    const el = w.find('[data-testid="diag-export-result"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('~/diagnose.json')
    expect(el.text()).toContain('100 B')
    // cancelled（用户取消导出对话框）→ 静默：不产生结果提示
    api.diagnosticsExport.mockResolvedValue({ cancelled: true })
    await w.find('[data-testid="diag-export"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="diag-export-result"]').text()).toContain('~/diagnose.json')   // 保留上一次成功提示
  })

  it('导出失败 → 提示「导出失败」（不崩溃）', async () => {
    api.diagnosticsExport.mockRejectedValue(new Error('[UNKNOWN] 导出失败'))
    const w = await mountPane()
    await w.find('[data-testid="diag-export"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="diag-export-result"]').text()).toContain('导出失败')
  })

  it('导出 in-flight 去重：导出进行中再次点击不触发第二次（C-15）+ 完成后按钮恢复可用', async () => {
    // C-15：#onExport 原无 in-flight 锁——导出进行中再次点击会并发 diagnosticsExport。本用例：
    // ① 首次点击 → diagnosticsExport 挂起（deferred）→ 按钮 disabled（:disabled="exporting"）；
    // ② 挂起期间再次点击 → diagnosisExport 仅一次（去重）；
    // ③ resolve 后按钮恢复 enabled，再点 → 第二次调用（证明 finally 释放 exporting）。
    const d = deferred<DiagnosticsExportResult>()
    api.diagnosticsExport.mockReturnValueOnce(d.promise)
    const w = await mountPane()
    const btn = w.find('[data-testid="diag-export"]')
    await btn.trigger('click')
    await flushPromises()
    expect(api.diagnosticsExport).toHaveBeenCalledTimes(1)
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)   // in-flight 按钮禁用
    // 挂起期间再次点击 → 去重（不触发第二次 diagnosticsExport）
    await btn.trigger('click')
    await flushPromises()
    expect(api.diagnosticsExport).toHaveBeenCalledTimes(1)
    // resolve → finally 释放 exporting → 按钮恢复可用，再点触发第二次
    d.resolve({ cancelled: false, displayPath: '~/d.json', sizeBytes: 50, truncatedLog: false, truncatedAudit: false })
    await flushPromises()
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    await btn.trigger('click')
    await flushPromises()
    expect(api.diagnosticsExport).toHaveBeenCalledTimes(2)
  })

  it('连接诊断：只读渲染 status/endpoint/protocolVersion/lastError（connectionStore 值）', async () => {
    useConnectionStore().setState({ status: 'connected', serverUrl: 'http://127.0.0.1:8000', protocolVersion: '2.0', serverVersion: '0.1.0' })
    useConnectionStore().setError({ code: 'UNKNOWN', message: '握手失败' })
    const w = await mountPane()
    expect(w.find('[data-testid="diag-conn-status"]').text()).toContain('已连接')
    expect(w.find('[data-testid="diag-conn-endpoint"]').text()).toBe('http://127.0.0.1:8000')
    expect(w.find('[data-testid="diag-conn-proto"]').text()).toContain('2.0')
    expect(w.find('[data-testid="diag-conn-last-error"]').text()).toContain('握手失败')
  })

  it('打开日志目录点击 → diagnosticsOpenLogDir', async () => {
    const w = await mountPane()
    await w.find('[data-testid="diag-log-open"]').trigger('click')
    expect(api.diagnosticsOpenLogDir).toHaveBeenCalledTimes(1)
  })

  it('state 拉取失败：fail-open 降级显示（分区头渲染 + 错误提示，无未处理 rejection）', async () => {
    api.diagnosticsState.mockRejectedValue(new Error('[UNKNOWN] 状态拉取失败'))
    const w = await mountPane()
    expect(w.find('[data-testid="diag-state-error"]').exists()).toBe(true)
    expect(w.find('.cy-l2d-title').text()).toContain('开发与诊断')
    await nextTick()   // 挂载后无残留 rejection（onMounted catch 兜底）
  })
})
