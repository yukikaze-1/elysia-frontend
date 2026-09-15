// src/main/attachments/file-ref.ts
// S5-B2（H-01 结构性修法，2026-09-15）：**不可猜文件引用**表。
//
// ## 为什么是这张表，而不是一个 HMAC
//
// 直觉方案是「Main 用只存在于主进程的密钥对路径签 HMAC」。但本仓的信任边界做不到：`isTrustedSenderFor`
// 只校验 webContents + mainFrame + URL ⇒ **Main 无法区分 preload 世界与页面主世界的 invoke**（同一帧）。
// 于是任何「由 preload 携带的秘密」都在页面主世界的可达面上，签名方案的秘密本身不成立。
//
// 真正的信任锚只能是 **Main 自己的内存**：token 由 Main 随机生成、路径只存在 Main 的表里。
// 效果等价且更简单——对端只能引用**Main 登记过的**文件；对端无法为任意路径凭空造出一个有效 token
// （表里没有它），也无法从 token 反推路径（token 与路径之间没有可计算关系）。
//
// ## 登记来源（两个，都在 Main 侧可控）
//
//  1. `webUtils.getPathForFile` 的产物：preload 在 `toIpcDescriptor` 里立即经
//     `attachments:register-file-ref` 登记换 token。
//     实测（`tests/integration/h01-fileref-probe.spec.ts`）该 API 对 JS 构造的 File 恒返空串，故这里的路径
//     只可能来自**真实 OS 拖入/选中**的文件。
//  2. Main 自身的对话框结果（工具域 `desktop.file.select` 等）——本批未接，留作扩展点。
//
// ## 边界（如实声明）
//
//  - 这是**会话内**表：进程重启即失效；**显式断开连接或切换后端地址**时经 `clear()` 清空
//    （`chat-service` 的 `onConnectionTeardown` → `index.ts` 装配的 `fileRefsHolder`）。
//    **瞬态 WS 掉线重连不清**——那是同一次用户会话，清掉会让正在编辑的待发送附件凭空失效，且没有安全收益。
//    ⚠️ 2026-09-15 复核修正：本行此前写「断线重连（`clear()`）即失效」，但 `clear()` 当时**没有任何调用点**
//    （安全评审 S6/S7-C1）——文档描述了不存在的属性。现已接线，口径同时收紧为上面这句。
//  - 它**不替代**任何既有守卫：命中 token 之后，realpath 规范化、userData 排除、路径黑名单、大小与魔数
//    复核**逐条照旧**（见 `upload-service.ts`）。本表只回答「这个路径是谁登记过的」，不回答「这个路径是否安全」。
//  - token 一旦签发，在 TTL 内可重复使用（同一次拖入的 validate 与 upload 各用一次是正常路径）。
import { randomBytes } from 'node:crypto'

/** 引用有效期：与工具域 `SELECT_EXEMPT_TTL_MS`（10 分钟）同量级——用户从拖入到点发送不会更久 */
export const FILE_REF_TTL_MS = 10 * 60 * 1000
/** 表容量上限：超限优先逐出**最旧**条目（正常使用下远达不到；防止对端刷爆主进程内存） */
export const FILE_REF_MAX = 256

export interface FileRefRegistry {
  /** 登记一个真实路径，返回不可猜 token（同路径重复登记各得一个 token，互不影响） */
  issue(realInputPath: string): string
  /** 解析 token → 路径；未知/已过期 → undefined（**不抛错**，由调用方按 fail-closed 处理） */
  resolve(fileRef: string): string | undefined
  /** 清空（显式断开连接 / 切换后端地址 / 测试隔离；瞬态重连不清，见文件头注） */
  clear(): void
  /** 当前条目数（测试与诊断用；不暴露给 Renderer） */
  size(): number
}

export function createFileRefRegistry(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): FileRefRegistry {
  const ttlMs = opts.ttlMs ?? FILE_REF_TTL_MS
  const max = opts.max ?? FILE_REF_MAX
  const now = opts.now ?? (() => Date.now())
  /** 插入序即最旧序（Map 保序），故逐出无需排序 */
  const table = new Map<string, { path: string; issuedAt: number }>()

  function prune(): void {
    const t = now()
    for (const [token, entry] of table) {
      if (t - entry.issuedAt > ttlMs) table.delete(token)
      else break   // 保序 ⇒ 后面的都更新
    }
  }

  return {
    issue(realInputPath) {
      prune()
      while (table.size >= max) {
        const oldest = table.keys().next()
        if (oldest.done) break
        table.delete(oldest.value)
      }
      // 32 字节 CSPRNG hex：不可猜（不是哈希路径，token 与路径之间无可计算关系）
      const token = `fileref_${randomBytes(32).toString('hex')}`
      table.set(token, { path: realInputPath, issuedAt: now() })
      return token
    },
    resolve(fileRef) {
      const entry = table.get(fileRef)
      if (!entry) return undefined
      if (now() - entry.issuedAt > ttlMs) { table.delete(fileRef); return undefined }
      return entry.path
    },
    clear() { table.clear() },
    size() { return table.size }
  }
}
