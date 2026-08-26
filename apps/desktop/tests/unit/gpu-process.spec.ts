// tests/unit/gpu-process.spec.ts（node）
// Task 6（阶段 7 批次 B）：child-process-gone 的 GPU 分支兜底单测——
// 消费 Task 2 抽出的 handleChildProcessGone（index.ts 导出）。
// NOTE（本 Task 唯一偏离 brief 骨架）：index.ts 静态 import 会触发 `void main().catch(...)`（index.ts:455）。
//   纯 node 不 mock electron 时 real `electron` 解析为路径字符串（app/dialog 皆 undefined），main() async 函数
//   在 `app.isPackaged` 处抛错 → catch → fatal → dialog.showErrorBox(undefined) → TypeError。
//   故与 Task 2 renderer-crash-handler.spec 同款：vi.mock('electron') 且 app.requestSingleInstanceLock 返回 false，
//   使 main() 在 whenReady/装配前提前 exit(0) 短路（仅 installAppIdentity 在 tmpdir 下 mkdir 两目录，测试可容忍）。
// NOTE（无先失败）：handleChildProcessGone 已在 Task 2 落地并导出，本测试 Step 2 是「直接 PASS」——
//   本 Task 是「补消费+补测试」，非「从零实现」。deps 无 reload——GPU 不 reload（reload 归 render-process-gone）。
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const noop = vi.fn()
  const APP_DATA = '/tmp/cyrene-7b-task6-appdata'
  const mockApp = {
    isPackaged: false,
    commandLine: { hasSwitch: () => false, getSwitchValue: () => '' },
    getPath: () => APP_DATA,
    setName: noop, setPath: noop,
    requestSingleInstanceLock: () => false, // main() 提前短路 exit(0)（见文件头注释）
    on: noop, quit: noop, exit: noop,
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.0.0', setAppUserModelId: noop,
  }
  return { noop, APP_DATA, mockApp }
})

vi.mock('electron', () => ({
  app: h.mockApp,
  BrowserWindow: class { static getAllWindows() { return [] } },
  session: { defaultSession: { setPermissionCheckHandler: h.noop, setPermissionRequestHandler: h.noop } },
  shell: { openExternal: h.noop },
  dialog: { showErrorBox: h.noop },
  Menu: { setApplicationMenu: h.noop, buildFromTemplate: () => [] },
  safeStorage: {},
  net: {},
  protocol: { registerSchemesAsPrivileged: h.noop, handle: h.noop, unhandle: h.noop, isProtocolHandled: () => false },
  ipcMain: { handle: h.noop, on: h.noop },
}))

import { handleChildProcessGone } from '../../src/main/index'

function makeDeps() {
  return { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, audit: vi.fn() }
}
describe('child-process-gone GPU 兜底', () => {
  it('type==="GPU" → audit "gpu:crash" + warn（不 reload——deps 无 reload）', () => {
    const deps = makeDeps()
    handleChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, deps)
    expect(deps.logger.warn).toHaveBeenCalledWith('gpu-process-gone', { reason: 'crashed', exitCode: 1 })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu:crash' }))
  })
  it('type 非 GPU（Utility）→ 不处理（不 warn 不 audit）', () => {
    const deps = makeDeps()
    handleChildProcessGone({ type: 'Utility', reason: 'crashed', exitCode: 1 }, deps)
    expect(deps.logger.warn).not.toHaveBeenCalled()
    expect(deps.audit).not.toHaveBeenCalled()
  })
})
