// tests/unit/dialog-service.spec.ts
// 原生对话框适配层（Silent Test Window Mode，2026-09-12）。
//
// 判别力要点：silent 下**真的没有调用 electron.dialog**（不是"看起来没弹"），并且调用被记录成
// 可断言的证据（是否触发/参数是否正确/取消结果可被处理）；visible 与生产模式则逐字委派给
// electron.dialog（含带父窗与不带父窗两种形态）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resolveRuntimeEnvironment } from '../../src/main/config/runtime-environment'

const { dialogMock } = vi.hoisted(() => ({
  dialogMock: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['C:/picked/native.txt'] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'C:/picked/native.json' })),
    showErrorBox: vi.fn(),
  },
}))
vi.mock('electron', () => ({ dialog: dialogMock }))

const { createDialogService, dialogInvocations, resetDialogInvocations } = await import('../../src/main/native-ui/dialog-service')
import type { BrowserWindow } from 'electron'

const SILENT = resolveRuntimeEnvironment({ env: { CYRENE_TEST_HARNESS: '1' }, mode: 'test' })
const VISIBLE_TEST = resolveRuntimeEnvironment({ env: { CYRENE_TEST_HARNESS: '1', CYRENE_WINDOW_MODE: 'visible' }, mode: 'test' })
const PROD = resolveRuntimeEnvironment({ env: {}, mode: 'production' })

const parent = { id: 1 } as unknown as BrowserWindow

beforeEach(() => {
  resetDialogInvocations()
  dialogMock.showOpenDialog.mockClear()
  dialogMock.showSaveDialog.mockClear()
  dialogMock.showErrorBox.mockClear()
})

afterEach(() => { vi.restoreAllMocks() })

describe('silent 测试模式：不弹原生窗口，但调用可验证', () => {
  it('目录/文件选择：返回确定性「用户取消」，且完全不触达 electron.dialog', async () => {
    const svc = createDialogService(SILENT)
    const r = await svc.showOpenDialog(parent, { title: '选择目录', properties: ['openDirectory'] })
    expect(r).toEqual({ canceled: true, filePaths: [] })
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled()
    expect(dialogInvocations()).toEqual([
      expect.objectContaining({ kind: 'open', title: '选择目录', properties: ['openDirectory'], shown: false }),
    ])
  })

  it('保存对话框：返回确定性「取消」，参数（defaultPath/filters）仍被记录', async () => {
    const svc = createDialogService(SILENT)
    const r = await svc.showSaveDialog(undefined, { defaultPath: 'cyrene-diagnose.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    expect(r).toEqual({ canceled: true, filePath: '' })
    expect(dialogMock.showSaveDialog).not.toHaveBeenCalled()
    expect(dialogInvocations()).toEqual([
      expect.objectContaining({ kind: 'save', defaultPath: 'cyrene-diagnose.json', filters: [{ name: 'JSON', extensions: ['json'] }], shown: false }),
    ])
  })

  it('致命错误提示框：不弹原生模态框（否则测试看起来"卡住"且干扰桌面），改为 stderr 留痕', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    createDialogService(SILENT).showErrorBox('Cyrene 无法启动', 'userData 目录不可用')
    expect(dialogMock.showErrorBox).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('userData 目录不可用'))
    expect(dialogInvocations()).toEqual([
      expect.objectContaining({ kind: 'error-box', title: 'Cyrene 无法启动', message: 'userData 目录不可用', shown: false }),
    ])
  })

  it('调用记录有上限（长跑测试不得无界增长）', async () => {
    const svc = createDialogService(SILENT)
    for (let i = 0; i < 60; i++) await svc.showOpenDialog(undefined, { title: `t${i}` })
    const records = dialogInvocations()
    expect(records).toHaveLength(50)
    expect(records[records.length - 1].title).toBe('t59') // 保留最近 50 条（最新的在尾部）
  })
})

describe('可见测试模式 / 生产：逐字委派 electron.dialog', () => {
  it('有父窗 → 传父窗；无父窗 → 无父调用形态（行为与整改前一致）', async () => {
    const svc = createDialogService(VISIBLE_TEST)
    await svc.showOpenDialog(parent, { title: '选择目录', properties: ['openDirectory'] })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ title: '选择目录' }))
    await svc.showOpenDialog(undefined, { title: '选择目录', properties: ['openDirectory'] })
    expect(dialogMock.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: '选择目录' }))
    // 可见测试模式仍留痕（shown=true：确实弹了原生窗口），供人工调试核对
    expect(dialogInvocations().every((i) => i.shown)).toBe(true)
  })

  it('生产模式：委派且**不**记录（无测试消费者，不留内存痕迹）', async () => {
    const svc = createDialogService(PROD)
    await svc.showSaveDialog(parent, { defaultPath: 'x.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    svc.showErrorBox('t', 'm')
    expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ defaultPath: 'x.json' }))
    expect(dialogMock.showErrorBox).toHaveBeenCalledWith('t', 'm')
    expect(dialogInvocations()).toEqual([])
  })
})
