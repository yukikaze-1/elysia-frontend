// tests/unit/gpu-process.spec.ts（node）
// Task 6（阶段 7 批次 B）：child-process-gone 的 GPU 分支兜底单测——
// 消费 Task 2 抽出的 handleChildProcessGone。
// 2026-09-17（架构整改 Prompt 2）：该函数从 `main/index.ts` 移入 `app/process-error-guards.ts`
//   （与另两个进程级守卫同址），import 随之改指；断言与语义逐字未变。
// NOTE（历史）：此前本用例静态 import index.ts 会触发 `void main().catch(...)`，故需
//   vi.mock('electron') + `app.requestSingleInstanceLock` 返回 false 让 main() 提前短路。
//   改用 process-error-guards 后 index.ts 不再被加载，但那段 electron mock 仍是本文件所需
//   （main-window.ts 等被间接 import）。
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

import { handleChildProcessGone } from '../../src/main/app/process-error-guards'

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
