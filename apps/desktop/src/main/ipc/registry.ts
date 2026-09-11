import { BrowserWindow, ipcMain } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { getTrustedDevOrigins, isAppRendererUrl } from '../config/trusted-renderer-origin'
import type { ZodType } from 'zod'

let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()

export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }

/**
 * 为什么这里**没有**做通道字节预算的运行时检查（P1-1，2026-09-11 实测后决定不做）。
 *
 * 报告给了两条路，运行时收口是其中带已知代价的一条。我实现了它，随后**撤回**，依据如下（均为实测/实测失败）：
 *
 *  1. **它会遮蔽更具体的诊断**（被既有集成用例当场抓住）：`chat:cache-messages` 超 4 MiB 时，
 *     handler 抛的是可操作的 `IPC_MESSAGE_TOO_LARGE`（"消息快照超过单条 IPC 大小上限"），
 *     而路由点的通用拒绝把它换成了 `SCHEMA_VALIDATION_FAILED` ——
 *     `persistence-lifecycle.spec.ts` 立刻红在「expected ... to contain 'IPC_MESSAGE_TOO_LARGE'」。
 *     要修就得把每个通道的错误码与文案**再抄一份**到声明表里，那正是本仓库反复吃亏的镜像漂移面。
 *  2. **它不可能统一**：二进制载荷不能度量——实测 1 MiB `Uint8Array` 经 `JSON.stringify` 需 **114 ms**
 *     且字符串膨胀 **10.9×**，故单向音频通道无论如何都得由 handler 用 O(1) 的 `byteLength` 自行判断。
 *  3. **方向不匹配**：若干通道声明的预算描述的是**响应**大小（如 hydrate/persist 的装箱降级），
 *     而路由点能度量的是**入参**——对它们做入参检查没有意义。
 *  4. **边际价值有限**：这些 handler 本来就在执行预算（声明表里 `enforcedAt` 逐条注明），
 *     而"漏掉一处"这一真实缺口已由**声明表 + 枚举断言门禁**解决（它上线首次运行就抓到
 *     `credentials:get-status` 未登记）。路由点检查只在"有人删掉 handler 内的检查"时才有增量。
 *
 * 结论：让**遗漏可见**（声明 + 门禁）是收益/风险比最高的一层；在受信路由点重建一套需要
 * 额外维护错误码、度量方式与方向语义的平行实现，收益不抵漂移与遮蔽风险。
 * 该不变量若将来要强制到路由点，正确做法是把它做成**由契约生成的**声明（而非手抄第二份），
 * 并保留各通道原有的错误码。
 */

/** 可测纯守卫（P2-01）：win null/销毁、sender 不匹配、senderFrame 非 mainFrame、发送 frame URL 不受信 → 拒绝 */
export function isTrustedSenderFor(
  win: { isDestroyed(): boolean; webContents: { mainFrame: unknown } } | null,
  event: { sender: unknown; senderFrame: { url: string } | null },
  trusted: ReadonlySet<string>
): boolean {
  if (!win || win.isDestroyed()) return false
  if (!event.senderFrame) return false
  if (event.sender !== win.webContents) return false
  if (event.senderFrame !== win.webContents.mainFrame) return false
  return isAppRendererUrl(event.senderFrame.url, trusted)
}

/** 结构宽化：同时接受 IpcMainEvent（ipcMain.on 单向）与 IpcMainInvokeEvent（ipcMain.handle invoke） */
function isTrustedSender(event: { sender: unknown; senderFrame: { url: string } | null }): boolean {
  return isTrustedSenderFor(mainWindow, event, getTrustedDevOrigins())
}

export function registerHandler(
  channel: IpcChannelName,
  executor: (raw: unknown) => Promise<IpcResult<unknown>>,
  arity: 0 | 1 = 0
): void {
  if (registered.has(channel)) {
    throw new CyreneError(CyreneErrorCode.UNKNOWN, `重复注册 IPC 通道 ${channel}`)
  }
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'UNKNOWN', message: '拒绝' } }
    if (args.length !== arity) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    return executor(args.length > 0 ? args[0] : undefined)
  })
  registered.add(channel) // handle 绑定成功后标记——绑定失败不污染 registered，后续可重试
}

/**
 * 单向通道（P4-B D-P18：voice:audio-chunk 等二进制上行，fire-and-forget 非 invoke）：
 * 复用同一 trusted-sender 守卫 + registered 集合（防与 registerHandler 通道名冲突）；payload 经 schema 校验，
 * 非法静默丢弃 + warn（单向无响应面，不向 sender 回报）。arity 固定 1（payload 缺省 undefined 不触发 handler）。
 */
export function registerOneWayHandler<T>(
  channel: IpcChannelName,
  schema: ZodType<T>,
  handler: (data: T) => void,
  opts: { logger?: { warn(code: string, fields?: Record<string, string | number | boolean>): void } } = {}
): void {
  if (registered.has(channel)) {
    throw new CyreneError(CyreneErrorCode.UNKNOWN, `重复注册 IPC 通道 ${channel}`)
  }
  ipcMain.on(channel, (event, payload) => {
    if (!isTrustedSender(event)) {
      // Minor-7：非受信 sender 同样 warn（fire-and-forget 无响应面，静默拒收难排查——调试友好）
      opts.logger?.warn('ipc:oneway-untrusted', { channel })
      return
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      opts.logger?.warn('ipc:oneway-invalid', { channel })
      return
    }
    handler(parsed.data)
  })
  registered.add(channel) // 绑定成功后标记
}
