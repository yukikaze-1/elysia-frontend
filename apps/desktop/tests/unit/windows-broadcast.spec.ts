// tests/unit/windows-broadcast.spec.ts —— H-12（2026-09-11）：广播的销毁守卫。
//
// 修复前 `index.ts` 的 tool pushEvent 是三个 send 点里唯一既无 null 检查也无 isDestroyed() 的：
// `for (const w of BrowserWindow.getAllWindows()) w.webContents.send(...)`。
// 窗口关闭过程中被投递会让 send 抛错，而该处位于 IPC executor 之外（没有错误信封兜底），
// 于是升级为主进程未捕获异常。
import { describe, expect, it, vi } from 'vitest'
import { broadcastToWindows, type BroadcastWindow } from '../../src/main/windows/broadcast'

function makeWindow(opts: { destroyed?: boolean; webContentsDestroyed?: boolean; sendThrows?: boolean } = {}) {
  const send = vi.fn(() => { if (opts.sendThrows) throw new Error('Object has been destroyed') })
  const win: BroadcastWindow = {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: { isDestroyed: () => opts.webContentsDestroyed ?? false, send }
  }
  return { win, send }
}

describe('broadcastToWindows（H-12 销毁守卫）', () => {
  it('正常窗口收到投递，返回投递数', () => {
    const a = makeWindow(); const b = makeWindow()
    const sent = broadcastToWindows([a.win, b.win], 'tool:event', { id: 1 })
    expect(sent).toBe(2)
    expect(a.send).toHaveBeenCalledWith('tool:event', { id: 1 })
    expect(b.send).toHaveBeenCalledWith('tool:event', { id: 1 })
  })

  it('已销毁窗口被跳过（不投递、不计数）', () => {
    const alive = makeWindow(); const dead = makeWindow({ destroyed: true })
    const sent = broadcastToWindows([dead.win, alive.win], 'tool:event', {})
    expect(sent).toBe(1)
    expect(dead.send).not.toHaveBeenCalled()
    expect(alive.send).toHaveBeenCalledTimes(1)
  })

  it('webContents 已销毁同样跳过（窗口在而内容没了）', () => {
    const gone = makeWindow({ webContentsDestroyed: true })
    const sent = broadcastToWindows([gone.win], 'tool:event', {})
    expect(sent).toBe(0)
    expect(gone.send).not.toHaveBeenCalled()
  })

  it('检查与发送之间的竞态抛错被吞，且不阻断其余窗口', () => {
    const racy = makeWindow({ sendThrows: true }); const ok = makeWindow()
    const sent = broadcastToWindows([racy.win, ok.win], 'tool:event', {})
    expect(sent).toBe(1)                  // racy 未计数
    expect(ok.send).toHaveBeenCalledTimes(1) // 后面的窗口照常投递
  })

  it('空窗口表 → 0（不抛）', () => {
    expect(broadcastToWindows([], 'tool:event', {})).toBe(0)
  })
})
