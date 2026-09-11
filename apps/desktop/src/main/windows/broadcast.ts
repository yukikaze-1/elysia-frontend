// src/main/windows/broadcast.ts —— 向所有窗口广播的带守卫实现（H-12，2026-09-11）。
//
// 背景：`index.ts` 的 tool `pushEvent` 是三个 send 点里**唯一**既无 null 检查也无 `isDestroyed()`
// 的（另外两处走 `getMainWindow()` 至少有 null 短路）。窗口在关闭过程中被投递会让
// `webContents.send` 抛错；该异常发生在 IPC 之外（没有 executor 的错误信封兜底），
// 于是变成主进程未捕获异常。
//
// 抽成纯函数便于单测（对照 `handleChildProcessGone` 的先例）。
export interface BroadcastWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void }
}

/**
 * 逐个窗口投递，跳过已销毁者。返回实际投递数。
 *
 * 仍要 try/catch：`isDestroyed()` 与 `send()` 之间存在真实竞态（窗口恰好在此刻销毁），
 * 单个窗口失败不得阻断其余窗口，也不得把异常抛回调用方。
 */
export function broadcastToWindows(windows: readonly BroadcastWindow[], channel: string, payload: unknown): number {
  let sent = 0
  for (const win of windows) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
      sent++
    } catch { /* 检查与发送之间窗口被销毁：跳过该窗口，继续其余 */ }
  }
  return sent
}
