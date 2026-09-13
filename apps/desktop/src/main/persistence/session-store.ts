// 阶段 3 G2 Main 持久化（spec §4.4.2/§4.5，docs/06 §14 Main 持久化边界）：
// drafts-v1.json（草稿+锚点+lastActive，高频小）+ message-cache-v1.json（会话列表+消息快照，低频大）。
// 纪律：版本化 schemaVersion + 逐条校验 + 整文件损坏隔离重建（不污染）+ 配额（100KB/条、50 会话、20 会话缓存、300 条/会话）+ 淘汰告知 + 正文永不写日志。
import { join, basename } from 'path'
import { unlink } from 'fs/promises'
import { atomicWriteFile } from '../credentials/atomic-write'
import { openSafeFile } from './safe-open'
import { createCorruptIsolation, type CorruptIsolation } from './corrupt-isolation'
import { toWriteFailure } from './write-failure'
import { MAX_IPC_MESSAGE_BYTES, type Conversation, type ConversationDraft, type Message, type PersistSessionInput, type PersistSessionResult, type ScrollAnchor, type SessionPersistenceState } from '@shared/contracts'
import { ConversationDraftSchema, ConversationSchema, MessageSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'

export const DRAFT_MAX_BYTES = 100 * 1024
export const DRAFT_MAX_ENTRIES = 50
export const CACHE_TOP_N = 20
export const CACHE_MESSAGES_PER_CONV = 300
/** 两个会话文件共用的当前 schema 版本（写入方与读取校验方同源，杜绝字面量双处漂移） */
export const SESSION_SCHEMA_VERSION = 1

/**
 * 判断已成功解析的 JSON 是否与当前 schema 兼容（H-11b，2026-09-11）。
 *
 * 背景：`schemaVersion` 此前**声明了却从不读**——`DraftsFile.schemaVersion: 1` 只是接口上的装饰，
 * 读取路径只检查 `data.entries` 是不是对象。于是「字段名变化（正是『旧数据不迁移』决策预期的情形）
 * 或任何外来 JSON」都会在第一次写入时被**无痕丢弃**，用户看不到任何征兆。
 *
 * 返回 `undefined` 表示兼容；否则返回问题标签（进入隔离路径 + 留痕）。
 * 抽成纯函数便于单测。
 */
export function describeSchemaProblem(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not-an-object'
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (version !== SESSION_SCHEMA_VERSION) return `schema-version-mismatch:${String(version)}`
  return undefined
}

interface DraftEntry { text: string; updatedAt: string }
interface SnapshotEntry { messages: Message[]; updatedAt: string; lastSyncAt: string }
interface DraftsFile { schemaVersion: 1; entries: Record<string, DraftEntry>; scrollAnchors: Record<string, ScrollAnchor>; lastActiveConversationId?: string }
interface CacheFile { schemaVersion: 1; conversations: Conversation[]; snapshots: Record<string, SnapshotEntry> }

export interface SessionStoreDeps {
  appCache: string
  safeRoot: string
  logger: Logger
  countDiagnostic: (code: string) => void
  getActiveConversationId(): string | undefined
}

function estBytes(s: string): number { return new TextEncoder().encode(s).byteLength }
function msgBytes(m: Message): number {
  let n = 200
  n += estBytes(m.content ?? '')
  for (const seg of m.assistantSegments ?? []) n += estBytes(seg.text ?? '')
  return n
}
function nowIso(): string { return new Date().toISOString() }

export class SessionStore {
  private readonly draftsFile: string
  private readonly cacheFile: string
  private readonly isolation: CorruptIsolation
  private drafts: DraftsFile = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
  private cache: CacheFile = { schemaVersion: 1, conversations: [], snapshots: {} }
  /**
   * 持久化降级态（H-11b）：损坏文件隔离失败后置位，此后拒绝一切写入以保现场。
   *
   * 三字段**分栏存放**（2026-09-13，renderer 半边）：`trigger` 取自封闭取值（`read-failed:<errno>` /
   * `not-an-object` / `schema-version-mismatch:<n>`，**无路径**），`detail` 是真实 fs 错误原文
   * （**含绝对路径**）。前者可经 IPC 展示，后者只进日志/`getLastError()`。
   */
  private degraded: { file: string; trigger: string; detail: string } | undefined

  constructor(private readonly deps: SessionStoreDeps) {
    this.draftsFile = join(deps.appCache, 'drafts-v1.json')
    this.cacheFile = join(deps.appCache, 'message-cache-v1.json')
    this.isolation = createCorruptIsolation({ logger: deps.logger, countDiagnostic: deps.countDiagnostic })
  }

  /** 损坏隔离读取：整文件 JSON 失败 → isolation.isolate 备份 .corrupt-session-<ts> 重建空；条目级失败丢条目不污染（FE-S1-P2-02 纪律） */
  async load(): Promise<void> {
    this.drafts = await this.readFile(this.draftsFile, (raw) => {
      const out: DraftsFile = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
      const data = raw as { entries?: unknown; scrollAnchors?: unknown; lastActiveConversationId?: unknown }
      if (data.entries && typeof data.entries === 'object') {
        for (const [k, v] of Object.entries(data.entries as Record<string, unknown>)) {
          const parsed = ConversationDraftSchema.safeParse({ conversationId: k, text: (v as { text?: string })?.text ?? '', attachmentLocalIds: [], updatedAt: (v as { text?: string; updatedAt?: string })?.updatedAt ?? '' })
          if (parsed.success) out.entries[k] = { text: parsed.data.text, updatedAt: parsed.data.updatedAt }
          else { this.isolation.dropInvalid('draft:drop-invalid'); continue }
        }
      }
      if (data.scrollAnchors && typeof data.scrollAnchors === 'object') {
        for (const [k, v] of Object.entries(data.scrollAnchors as Record<string, unknown>)) {
          if (v && typeof v === 'object' && typeof (v as ScrollAnchor).messageId === 'string' && typeof (v as ScrollAnchor).offset === 'number') {
            out.scrollAnchors[k] = v as ScrollAnchor
          } else this.deps.countDiagnostic('draft:drop-invalid-anchor')
        }
      }
      if (typeof data.lastActiveConversationId === 'string') out.lastActiveConversationId = data.lastActiveConversationId
      return out
    })
    this.cache = await this.readFile(this.cacheFile, (raw) => {
      const data = raw as { conversations?: unknown; snapshots?: unknown }
      const out: CacheFile = { schemaVersion: 1, conversations: [], snapshots: {} }
      if (Array.isArray(data.conversations)) {
        for (const c of data.conversations as unknown[]) {
          const parsed = ConversationSchema.safeParse(c)
          if (parsed.success) out.conversations.push(parsed.data)
          else this.deps.countDiagnostic('cache:drop-invalid-conv')
        }
      }
      if (data.snapshots && typeof data.snapshots === 'object') {
        for (const [k, v] of Object.entries(data.snapshots as Record<string, unknown>)) {
          const snap = v as { messages?: unknown; updatedAt?: string; lastSyncAt?: string }
          if (snap && Array.isArray(snap.messages)) {
            const messages: Message[] = []
            for (const m of snap.messages as unknown[]) {
              const parsed = MessageSchema.safeParse(m)
              if (parsed.success) messages.push(parsed.data)
              else this.deps.countDiagnostic('cache:drop-invalid')
            }
            out.snapshots[k] = { messages, updatedAt: snap.updatedAt ?? '', lastSyncAt: snap.lastSyncAt ?? '' }
          } else this.deps.countDiagnostic('cache:drop-invalid-snapshot')
        }
      }
      return out
    })
    // HIGH-1 有界保留：整文件损坏隔离后，下次成功 load() 清同 tag 旧 `.corrupt-session-*`（只留最新一份）
    await this.isolation.pruneCorrupt(this.draftsFile, 'session')
    await this.isolation.pruneCorrupt(this.cacheFile, 'session')
  }

  private async readFile<T>(file: string, parse: (raw: unknown) => T): Promise<T> {
    let raw: unknown
    try {
      const { fd } = await openSafeFile(file, { mode: 'existing', purpose: 'read', safeRoot: this.deps.safeRoot })
      try { raw = JSON.parse(await fd.readFile('utf8')) } finally { await fd.close() }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parse({}) // 首次启动无文件 → 空
      // 整文件不可读/不可解析：隔离保留现场（不含正文），重建空
      return await this.isolateAndRebuild(file, parse, `read-failed:${(e as NodeJS.ErrnoException).code ?? 'unknown'}`)
    }
    // H-11b：JSON 可解析 ≠ schema 兼容。版本不符/非对象此前会被静默当作空态丢弃。
    const problem = describeSchemaProblem(raw)
    if (problem) return await this.isolateAndRebuild(file, parse, problem)
    return parse(raw)
  }

  /**
   * 隔离损坏文件并重建空态（H-11b）。隔离**失败**时进入降级态：保现场 + 拒绝后续一切写入。
   * 这正是此前最危险的一条路径——改名失败被吞、内存态清空，下一次击键把原文件无痕覆写。
   */
  private async isolateAndRebuild<T>(file: string, parse: (raw: unknown) => T, reason: string): Promise<T> {
    this.deps.logger.warn('persistence:corrupt-isolated', { file: basename(file), reason })
    try {
      await this.isolation.isolate(file, 'session', this.deps.safeRoot)   // countDiagnostic 在 isolate 内部（防双计数）
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      // 2026-09-13：只把**无路径**的 trigger 与原始 detail 分栏存放（详见 degraded 字段注释）——
      // detail 里是 fs 错误原文（`isolate 目标逃逸安全根: /abs/path/...`），绝不能跨 IPC。
      this.degraded = { file: basename(file), trigger: reason, detail }
      this.deps.countDiagnostic('persistence:degraded')
      this.deps.logger.error('persistence:degraded', { file: basename(file), reason, message: detail })
    }
    return parse({})
  }

  /** 降级原因（H-11b）；undefined 表示持久化正常。供诊断与测试读取。**含 fs 原文（可含绝对路径），不得跨 IPC**。 */
  getLastError(): { file: string; reason: string } | undefined {
    return this.degraded === undefined
      ? undefined
      : { file: this.degraded.file, reason: `${this.degraded.trigger}; isolate-failed:${this.degraded.detail}` }
  }

  /**
   * 降级态的可展示投影（H-11b renderer 半边，2026-09-13）。
   *
   * 与 `getLastError()` 的区别只有一处，但正是关键：**去掉 `detail`**。于是返回的 `reason` 是封闭取值
   * （形状为 `read-failed:<errno>` / `not-an-object` / `schema-version-mismatch:<n>`），不含任何本地路径，
   * 可以安全地经 `hydrate` 交给 Renderer 显示。两者同源，故不会各自漂移。
   */
  getDegradedNotice(): { file: string; reason: string } | undefined {
    return this.degraded === undefined
      ? undefined
      : { file: this.degraded.file, reason: this.degraded.trigger }
  }

  /** 写入前守卫：降级态下拒绝一切写入，绝不覆写未能隔离的原文件 */
  private assertWritable(): void {
    if (!this.degraded) return
    throw new CyreneError(
      CyreneErrorCode.PERSISTENCE_DEGRADED,
      `持久化已降级（${this.degraded.file}：${this.degraded.trigger}），已拒绝写入以保留现场`
    )
  }

  /**
   * H-11a（2026-09-11）：写序列化尾巴（**纵深防御**）。
   *
   * 本 store 有多条写**同一文件**的路径（drafts：`persistSession` × `setActiveConversation` ×
   * `purgeConversation`；cache：`cacheMessages` × `syncConversationList` × `purgeConversation`），
   * 且 `chat-service` 侧三条都是 fire-and-forget。
   *
   * 真正的并发安全已在 `atomicWriteFile` 内落地（按目标路径排队 + UUID 临时名），故此处**不是**唯一防线；
   * 保留它的价值在于把「本 store 的写是有序的」这一意图写在本地——读这段代码的人不必先去读底层writer
   * 才知道顺序有保证，且将来换 writer 实现时顺序语义不会随之丢失。
   * 同仓先例：`credential-store.ts` 的 `queue`、`character-draft-store.ts` 的 `writeTail`。
   *
   * 语义：`then(op, op)` 两个参数——任一 op reject 只影响该次调用者，不毒化后续排队者。
   */
  private writeTail: Promise<void> = Promise.resolve()

  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(op, op)
    this.writeTail = run.then(() => {}, () => {})
    return run
  }

  private async writeDrafts(): Promise<void> {
    this.assertWritable()
    // 在**调用时刻**序列化（而非排队执行时）：每次写持久化的是「它被要求写的那一刻」的状态，
    // 顺序由队列保证，故最后落盘的必然是最新一次调用的状态。
    const data = JSON.stringify(this.drafts)
    await this.enqueueWrite(() => atomicWriteFile(this.draftsFile, data, { safeRoot: this.deps.safeRoot }))
      .catch((e: unknown) => { throw toWriteFailure(e) })
  }
  private async writeCache(): Promise<void> {
    this.assertWritable()
    const data = JSON.stringify(this.cache)
    await this.enqueueWrite(() => atomicWriteFile(this.cacheFile, data, { safeRoot: this.deps.safeRoot }))
      .catch((e: unknown) => { throw toWriteFailure(e) })
  }

  /** 响应装箱：默认全量；超 MAX_IPC_MESSAGE_BYTES 时按顺序降级（spec §4.2 P1-2），降级记诊断计数、不记正文 */
  hydrate(): SessionPersistenceState {
    const drafts = Object.entries(this.drafts.entries).map(([conversationId, e]) => ({
      conversationId, text: e.text, attachmentLocalIds: [], updatedAt: e.updatedAt
    }))
    // H-11b renderer 半边（2026-09-13）：降级态随水合一次性告知 Renderer——这是用户进入应用后
    // **第一个**能知道「本地保存已停用」的时刻（此前只有 Main 日志与诊断计数知道）。
    const degradedNotice = this.getDegradedNotice()
    let state: SessionPersistenceState = {
      drafts,
      scrollAnchors: { ...this.drafts.scrollAnchors },
      lastActiveConversationId: this.drafts.lastActiveConversationId,
      conversations: this.cache.conversations,
      messageSnapshots: Object.fromEntries(Object.entries(this.cache.snapshots).map(([k, v]) => [k, v.messages])),
      ...(degradedNotice === undefined ? {} : { persistenceDegraded: degradedNotice })
    }
    if (this.stateBytes(state) <= MAX_IPC_MESSAGE_BYTES) return state
    this.deps.countDiagnostic('hydrate:degraded')
    // ① 快照只保留 lastActive + updatedAt 最近 N（N 由预算反推）
    const keys = Object.keys(state.messageSnapshots).sort((a, b) =>
      (this.cache.snapshots[b]?.updatedAt ?? '').localeCompare(this.cache.snapshots[a]?.updatedAt ?? ''))
    const lastId = state.lastActiveConversationId
    // lastId 无快照（水合时该会话无消息缓存）则不进首序，防 undefined 值入 kept 崩 stateBytes
    const otherKeys = keys.filter((k) => k !== lastId)
    const ordered = lastId && state.messageSnapshots[lastId] ? [lastId, ...otherKeys] : otherKeys
    const allSnapshots = state.messageSnapshots  // 保留原引用——不能从被替换的 state.messageSnapshots 重读（会读到 kept 自身，第二轮迭代得到 undefined）
    const kept: Record<string, Message[]> = {}
    for (const k of ordered) {
      const msgs = allSnapshots[k]
      if (!msgs) continue // 防御：键缺失跳过
      kept[k] = msgs
      const candidate: SessionPersistenceState = { ...state, messageSnapshots: kept }
      if (this.stateBytes(candidate) <= MAX_IPC_MESSAGE_BYTES) break
    }
    state = { ...state, messageSnapshots: kept }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ② 每会话截前 M + 超长正文截断保留元数据（离线可读骨架）
      for (const k of Object.keys(state.messageSnapshots)) {
        state.messageSnapshots[k] = state.messageSnapshots[k].slice(0, 50).map((m) => ({
          ...m,
          content: m.content && estBytes(m.content) > 2000 ? m.content.slice(0, 2000) : m.content,
          assistantSegments: m.assistantSegments?.map((s) => (s.text && estBytes(s.text) > 2000 ? { ...s, text: s.text.slice(0, 2000) } : s))
        }))
      }
    }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ③ 草稿裁剪（评审 P1-1，防 50×100KB=5MB 草稿破 4MiB 不变量）：快照已降级仍超 → lastActive 优先、其余按 updatedAt 最近保留，
      //    逐条入内直至预算；被裁会话的锚点一并清（该会话本地态整体放弃，连接后由后端全量调和）
      this.deps.countDiagnostic('hydrate:drafts-degraded')
      const lastId = state.lastActiveConversationId
      const orderedDrafts = [...state.drafts].sort((a, b) =>
        (a.conversationId === lastId ? -1 : b.conversationId === lastId ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt))
      const keptDrafts: ConversationDraft[] = []
      for (const d of orderedDrafts) {
        keptDrafts.push(d)
        state = { ...state, drafts: keptDrafts }
        if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
          keptDrafts.pop()
          state = { ...state, drafts: keptDrafts }
        }
      }
      const keptIds = new Set(keptDrafts.map((d) => d.conversationId))
      const anchors = { ...state.scrollAnchors }
      for (const k of Object.keys(anchors)) if (!keptIds.has(k)) delete anchors[k]
      state = { ...state, drafts: keptDrafts, scrollAnchors: anchors }
    }
    if (this.stateBytes(state) > MAX_IPC_MESSAGE_BYTES) {
      // ④ 兜底仍超 → 空草稿+空快照拒绝路径（启动不阻塞，连接后由后端全量调和；保证出参 ≤4MiB 不变量）
      this.deps.countDiagnostic('hydrate:rejected')
      return {
        drafts: [], scrollAnchors: {}, lastActiveConversationId: this.drafts.lastActiveConversationId,
        conversations: [], messageSnapshots: {},
        // 降级态**不能**被体积降级丢掉：它正是"保存已经不可用"的告知，丢了就等于又静默一次
        ...(degradedNotice === undefined ? {} : { persistenceDegraded: degradedNotice })
      }
    }
    return state
  }

  private stateBytes(state: SessionPersistenceState): number {
    let n = 1024
    if (state.persistenceDegraded) n += 256   // 降级投影（基名 + 封闭标签，实测 <200B）：纳入预算，免"降级时反而超限"
    for (const d of state.drafts) n += estBytes(d.text)
    for (const c of state.conversations) n += estBytes(c.title)
    for (const msgs of Object.values(state.messageSnapshots)) for (const m of msgs) n += msgBytes(m)
    return n
  }

  /** 草稿+锚点 upsert；配额权威执行（D4）：单条 >100KB 拒、条目 >50 淘汰最旧非激活（P2-1 淘汰项返回） */
  async persistSession(input: PersistSessionInput): Promise<PersistSessionResult> {
    if (estBytes(input.draft.text) > DRAFT_MAX_BYTES) {
      throw new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '草稿超过 100KB 上限')
    }
    this.drafts.entries[input.conversationId] = { text: input.draft.text, updatedAt: input.draft.updatedAt }
    if (input.scrollAnchor) this.drafts.scrollAnchors[input.conversationId] = input.scrollAnchor
    else delete this.drafts.scrollAnchors[input.conversationId]

    const evicted: string[] = []
    const keys = Object.keys(this.drafts.entries)
    if (keys.length > DRAFT_MAX_ENTRIES) {
      const activeId = this.deps.getActiveConversationId()
      const excess = keys.length - DRAFT_MAX_ENTRIES
      const candidates = keys
        .filter((k) => k !== activeId)
        .sort((a, b) => this.drafts.entries[a].updatedAt.localeCompare(this.drafts.entries[b].updatedAt))
      for (const k of candidates.slice(0, excess)) {
        delete this.drafts.entries[k]
        delete this.drafts.scrollAnchors[k]
        evicted.push(k)
      }
      this.deps.countDiagnostic('draft:evicted')
    }
    await this.writeDrafts() // fail-open 由调用方兜底（成功路径 throw 说明配额被拒，不影响操作）
    return evicted.length ? { evictedConversationIds: evicted } : {}
  }

  /** 已确认消息快照增量：整批字节预算校验 + 逐条 schema 校验 + 去重合并 + ≤300 封顶 + top-20 淘汰（P1-2） */
  async cacheMessages(input: { conversationId: string; messages: Message[]; updatedAt: string }): Promise<void> {
    if (input.messages.reduce((acc, m) => acc + msgBytes(m), 0) > MAX_IPC_MESSAGE_BYTES) {
      throw new CyreneError(CyreneErrorCode.IPC_MESSAGE_TOO_LARGE, '消息快照超过单条 IPC 大小上限')
    }
    const valid: Message[] = []
    for (const m of input.messages) {
      const parsed = MessageSchema.safeParse(m)
      if (parsed.success) valid.push(parsed.data)
      else this.deps.countDiagnostic('cache:drop-invalid')
    }
    const snap = this.cache.snapshots[input.conversationId] ?? { messages: [], updatedAt: '', lastSyncAt: nowIso() }
    const merged = new Map<string, Message>()
    for (const m of [...snap.messages, ...valid]) merged.set(m.messageId, m)
    snap.messages = [...merged.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1).slice(-CACHE_MESSAGES_PER_CONV)
    snap.updatedAt = input.updatedAt
    snap.lastSyncAt = nowIso()
    this.cache.snapshots[input.conversationId] = snap
    const listIdx = this.cache.conversations.findIndex((c) => c.id === input.conversationId)
    if (listIdx >= 0) this.cache.conversations[listIdx] = { ...this.cache.conversations[listIdx], updatedAt: input.updatedAt }
    else this.cache.conversations.push({ id: input.conversationId, title: '', updatedAt: input.updatedAt }) // 快照先到/列表未派生时补条，防 trimCache 按空列表误删快照
    this.trimCache()
    await this.writeCache()
  }

  /** 会话列表缓存（Main 派生，listConversations 服务时调用；无需 Renderer 推送） */
  async syncConversationList(conversations: Conversation[]): Promise<void> {
    const merged = new Map<string, Conversation>()
    for (const c of [...this.cache.conversations, ...conversations]) merged.set(c.id, c)
    this.cache.conversations = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CACHE_TOP_N)
    this.trimCache()
    await this.writeCache()
  }

  private trimCache(): void {
    this.cache.conversations = [...this.cache.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, CACHE_TOP_N)
    const ids = new Set(this.cache.conversations.map((c) => c.id))
    for (const k of Object.keys(this.cache.snapshots)) if (!ids.has(k)) delete this.cache.snapshots[k]
  }

  /** 在线 activate 成功 → 记录 lastActiveConversationId（下次启动离线水合定位目标会话） */
  async setActiveConversation(id: string): Promise<void> {
    this.drafts.lastActiveConversationId = id
    await this.writeDrafts()
  }

  /** 删除会话联动（spec §4.5.1）：purge 草稿+锚点+快照+缓存会话列表（评审 P2-1——syncConversationList 是并集合并，不 purge 会残留被删会话） */
  async purgeConversation(id: string): Promise<void> {
    delete this.drafts.entries[id]
    delete this.drafts.scrollAnchors[id]
    delete this.cache.snapshots[id]
    this.cache.conversations = this.cache.conversations.filter((c) => c.id !== id) // P2-1：缓存会话列表移除被删会话
    await this.writeDrafts()
    await this.writeCache()
  }

  /** 「清除缓存」工具实现（docs/07 §243）：删除两个文件；本批不暴露删除 IPC，由设置组接入 */
  async clearAll(): Promise<void> {
    await unlink(this.draftsFile).catch(() => {})
    await unlink(this.cacheFile).catch(() => {})
    this.drafts = { schemaVersion: 1, entries: {}, scrollAnchors: {} }
    this.cache = { schemaVersion: 1, conversations: [], snapshots: {} }
  }
}
