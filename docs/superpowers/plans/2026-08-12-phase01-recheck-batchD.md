# 阶段 0/1 整改·批次 D：阶段 0 真实性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FE-S0-P1-01（首次联调口径冻结）+ FE-S0-P1-03（MockBackend 隔离与真实性）+ FE-S0-P2-01（Node 约束）+ FE-S0-P2-02（占位命令/子 README/状态表）。

**Architecture:** `mock-backend.ts` 重构为每实例深拷贝会话状态 + 一致 CRUD + 每次 send 注入唯一 ID + 可注入 clock/ID factory + 单 generation 取消；`engines` 改 `>=22.23.0 <23` + 版本检查脚本（import.meta 锚定 + semver + predev/prebuild/pretest hooks）；`test:e2e`/`make` 改非零退出 + 子 README 真实描述 + 主 README preload 修正；README/docs16/CLAUDE.md 冻结三态口径与首次联调范围。

**Tech Stack:** Electron main（Node）+ TypeScript + vitest（node 环境）+ pnpm 11.20。

## Global Constraints

- 决策 D2（用户拍板）：Mock 清单全量——每实例深拷贝 + 一致 CRUD + 每次 send 注入唯一 ID + 可注入 clock/ID + 可取消单 generation + 并发/多实例测试。
- **默认 `idFactory` 必须全局唯一**（实例内单调计数器 + 时间前缀或 `crypto.randomUUID()`）——**禁裸 `Date.now()`**（同 ms 碰撞打爆唯一性断言）。
- `createMockConversations()` 返回与现模块级 `MOCK_CONVERSATIONS` **完全一致**的默认两会话（conv-1001 首位）——保持 mock-replay「内置 2 条 + conv-1001」断言。
- `generationTimers` 类型用 `ReturnType<typeof setTimeout>[]`；`listConversations` items 每项 `map` 新对象。
- `cancelGeneration`：未知 genId → no-op；**静默取消不补发终态事件**（schema 无 `generation.cancelled` 类型，补发被 parseBackendEvent 拒；renderer 乐观置 interrupted 兜底）。测试须先等 `generation.started` 捕获 genId 再 cancel（ClientRequestRef 无 genId）。
- 决策 D3（用户拍板）：engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出。脚本用 `import.meta.url` 锚定读 `../package.json` engines（**禁 cwd 相对路径**——pnpm `-F` 下 cwd=包目录、根跑读仓库外）；semver 加显式 devDependency；predev/prebuild/pretest hooks（pnpm 11.20 默认执行，已实测）。
- 决策 D4（用户拍板）：`test:e2e`/`make` 改明确非零退出 + 未实现消息。
- 决策 D1（用户拍板）：落文档口径——三态（已开发/已验证/已真实联调）+ 首次联调=Linux 本机文本闭环（13 项用例）+ 阶段 0「带已知豁免提前开发」+ Windows 显式「阶段 1 未通过项」+ README 真实联调启动说明章节 + **CI 版本同源声明**（CI `node-version-file: .nvmrc` + `engineStrict: true` 与 engines 一致）。
- 占位命令非零退出是**人工复跑验收**（CI 不含这两条命令）。
- 文档仍标「已开发、未联调」；FE-S0-P1-02（wire SHA）不触碰。
- **已知限制进最终报告**：spec §6 六项（渲染单活跃代并发不端到端渲染 / Mock send 不校验会话 / 占位命令勿入 CI 门禁 / 版本检查 hook 覆盖 predev/prebuild/pretest 非 test:integration / H-01/H-07/B-01 未到阶段 0 未验证 / FE-S0-P1-02 wire SHA 待 B-01）须在最终报告逐项列出。

---

### Task 1: MockBackend 隔离与真实性（FE-S0-P1-03，D2 全量）

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`
- Test: `apps/desktop/tests/unit/mock-replay.spec.ts`（追加新 describe）

**Interfaces:**
- Produces: `MockBackendOptions` 增 `idFactory?`/`now?`（向后兼容，index.ts:135 消费方不受影响）
- Consumes: 无。

- [ ] **Step 1: 写失败测试**——`mock-replay.spec.ts` 追加 `describe('MockBackend 隔离与多次发送（FE-S0-P1-03）')`：

```ts
describe('MockBackend 隔离与多次发送（FE-S0-P1-03）', () => {
  it('两次发送的 generationId/eventId 互不相同（无 ID 冲突）', async () => {
    backend = new MockBackend({ emitDelayMs: 1 }) // 复用模块级 backend（afterEach 自动 dispose）
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    await new Promise((r) => setTimeout(r, 60))
    const gens = received.map((e) => (e as { generationId?: string }).generationId).filter(Boolean)
    expect(new Set(gens).size).toBeGreaterThan(1)
    const evtIds = received.map((e) => e.eventId)
    expect(new Set(evtIds).size).toBe(evtIds.length)
  })
  it('并发发送：两代均 completed 且 ID 唯一', async () => {
    backend = new MockBackend({ emitDelayMs: 1 })
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    const p1 = backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    const p2 = backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    await Promise.all([p1, p2])
    await new Promise((r) => setTimeout(r, 60))
    expect(received.filter((e) => e.event === 'generation.completed')).toHaveLength(2)
    const gens = new Set(received.map((e) => (e as { generationId?: string }).generationId).filter(Boolean))
    expect(gens.size).toBe(2)
    const evtIds = received.map((e) => e.eventId)
    expect(new Set(evtIds).size).toBe(evtIds.length)
  })
  it('两实例隔离：A CRUD 不影响 B', async () => {
    const a = new MockBackend()
    const b = new MockBackend()
    const created = await a.createConversation({ title: 'A 新建' })
    await a.renameConversation('conv-1001', 'A 改名')
    const aList = await a.listConversations({})
    const bList = await b.listConversations({})
    expect(aList.items.some((c) => c.id === created.id)).toBe(true)
    expect(bList.items.some((c) => c.id === created.id)).toBe(false)
    expect(bList.items[0]?.title).toBe('流式回复演示')
    a.dispose(); b.dispose()
  })
  it('完整 CRUD：create/rename/activate/delete 一致且可观测', async () => {
    const b = new MockBackend()
    const created = await b.createConversation({ title: '新会话' })
    const renamed = await b.renameConversation(created.id, '改名')
    expect(renamed.title).toBe('改名')
    expect((await b.listConversations({})).items.find((c) => c.id === created.id)?.title).toBe('改名')
    await b.activateConversation(created.id)
    await b.deleteConversation(created.id)
    expect((await b.listConversations({})).items.some((c) => c.id === created.id)).toBe(false)
    await expect(b.deleteConversation(created.id)).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
    await expect(b.activateConversation('nope')).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
    b.dispose()
  })
  it('可取消单 generation：仅取消目标 gen，另一 gen 正常 complete', async () => {
    backend = new MockBackend({ emitDelayMs: 30 }) // 30ms 间隔：11 事件全触发需 300ms，给 cancel 留窗口
    const received: BackendEvent[] = []
    backend.subscribe((e) => received.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'a', clientRequestId: 'c1' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'b', clientRequestId: 'c2' })
    // 等两个 started（t=0 双发均已触发）捕获注入后的 genId
    await new Promise((r) => setTimeout(r, 40))
    const started = received.filter((e) => e.event === 'generation.started')
    expect(started.length).toBe(2)
    const target = (started[0] as { generationId: string }).generationId
    await backend.cancelGeneration({ generationId: target })
    // 幸存 gen 第 11 事件 = 10×30=300ms；等 400ms 越过（防 cancel 后等待过短）
    await new Promise((r) => setTimeout(r, 400))
    expect(received.filter((e) => e.event === 'generation.completed')).toHaveLength(1)
    expect(received.some((e) => e.event === 'generation.completed' && e.generationId === target)).toBe(false)
    await backend.cancelGeneration({ generationId: 'unknown-gen' }) // no-op 不抛
  })
  it('可注入 clock/ID factory：确定性（含跨实例共享工厂递增）', async () => {
    let n = 0
    const fixed = new Date('2026-08-12T00:00:00.000Z')
    const factory = () => `id-${++n}`
    const a = new MockBackend({ idFactory: factory, now: () => fixed })
    const b = new MockBackend({ idFactory: factory, now: () => fixed })
    expect((await a.createConversation({ title: 'x' })).id).toBe('id-1')
    expect((await b.createConversation({ title: 'y' })).id).toBe('id-2') // 共享工厂计数器递增（确定性）
    expect((await a.createConversation({ title: 'z' })).updatedAt).toBe(fixed.toISOString())
    a.dispose(); b.dispose()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-replay.spec.ts`
Expected: 任务失败——现状 create 不入列表/delete no-op/ID 相同/无 idFactory，新例红。

- [ ] **Step 3: 重构 `mock-backend.ts`**

```ts
export interface MockBackendOptions {
  emitDelayMs?: number
  fixtureRaw?: string
  onConnectionStateChange?: (state: ConnectionState) => void
  /** 唯一 ID 工厂（测试确定性）：默认实例内单调计数器+时间前缀（禁裸 Date.now 同 ms 碰撞） */
  idFactory?: () => string
  /** 时钟（测试确定性）：默认 new Date() */
  now?: () => Date
}

const MOCK_SESSION: BackendSession = { sessionId: 'mock-session-1', protocolVersion: '0.1', serverUrl: 'mock://local' }

/** 默认会话模板：与旧模块级 MOCK_CONVERSATIONS 完全一致（conv-1001 首位），每次调用返回全新数组 */
function createMockConversations(): Conversation[] {
  return [
    { id: 'conv-1001', title: '流式回复演示', updatedAt: '2026-08-08T08:00:00.000Z', preview: '好的，我来回答…' },
    { id: 'conv-1002', title: '历史会话示例', updatedAt: '2026-08-07T10:30:00.000Z' }
  ]
}

export class MockBackend implements BackendAdapter {
  private handler?: BackendEventHandler
  private connected = false
  private readonly fixture: BackendEvent[]
  private readonly emitDelayMs: number
  private readonly onConnectionStateChange?: (state: ConnectionState) => void
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly conversations: Conversation[] = createMockConversations()
  private activeConversationId?: string
  private generationTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private idCounter = 0

  constructor(options: MockBackendOptions = {}) {
    this.emitDelayMs = options.emitDelayMs ?? 30
    this.onConnectionStateChange = options.onConnectionStateChange
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `mock-${Date.now()}-${++this.idCounter}`)
    const raw = options.fixtureRaw ?? fixtureRaw
    this.fixture = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        const parsed = parseBackendEvent(JSON.parse(line))
        if (!parsed.success) {
          throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, `MockBackend 夹具第 ${index + 1} 行不符合事件 Schema`, { line: index + 1, issues: parsed.error.issues })
        }
        return parsed.data
      })
  }
  // subscribe/connect/disconnect/getConnectionState 保持原样

  async listConversations(_input: PageQuery): Promise<Page<Conversation>> {
    return { items: this.conversations.map((c) => ({ ...c })), hasMore: false }
  }
  async getConversation(input: GetConversationQuery): Promise<ConversationDetail> {
    const conv = this.conversations.find((c) => c.id === input.conversationId)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${input.conversationId}`)
    return { ...conv }
  }
  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conv: Conversation = { id: this.idFactory(), title: input.title ?? '新会话', updatedAt: this.now().toISOString() }
    this.conversations.push(conv)
    return { ...conv }
  }
  async activateConversation(conversationId: string): Promise<ActivateConversationResult> {
    if (!this.conversations.some((c) => c.id === conversationId)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${conversationId}`)
    this.activeConversationId = conversationId
    return { conversationId }
  }
  async renameConversation(id: string, title: string): Promise<Conversation> {
    const conv = this.conversations.find((c) => c.id === id)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    conv.title = title
    conv.updatedAt = this.now().toISOString()
    return { ...conv }
  }
  async deleteConversation(id: string): Promise<void> {
    const idx = this.conversations.findIndex((c) => c.id === id)
    if (idx < 0) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    this.conversations.splice(idx, 1)
    if (this.activeConversationId === id) this.activeConversationId = undefined
  }
  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (!this.connected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    this.scheduleReplay(input.conversationId)
    return { clientRequestId: input.clientRequestId }
  }
  async cancelGeneration(input: CancelGenerationInput): Promise<void> {
    const genTimers = this.generationTimers.get(input.generationId)
    if (!genTimers) return // 未知 genId no-op
    genTimers.forEach((timer) => clearTimeout(timer))
    this.generationTimers.delete(input.generationId)
  }
  // 其余方法（listModelProfiles/testModelProfile/...）保持原样

  dispose(): void { this.clearTimers() }

  private scheduleReplay(conversationId: string): void {
    const genId = this.idFactory()
    const msgId = this.idFactory()
    const rspId = this.idFactory()
    const segmentMap = new Map<string, string>()
    const genTimers: ReturnType<typeof setTimeout>[] = []
    this.fixture.forEach((event, index) => {
      const fresh: Record<string, unknown> = { ...event }
      fresh.eventId = this.idFactory()
      if ('generationId' in event) fresh.generationId = genId
      if ('messageId' in event) fresh.messageId = msgId
      if ('responseId' in event) fresh.responseId = rspId
      if ('conversationId' in event) fresh.conversationId = conversationId
      if ('segmentId' in event && typeof event.segmentId === 'string') {
        let mapped = segmentMap.get(event.segmentId)
        if (!mapped) { mapped = this.idFactory(); segmentMap.set(event.segmentId, mapped) }
        fresh.segmentId = mapped
      }
      const timer = setTimeout(() => { this.emit(fresh as unknown as BackendEvent) }, index * this.emitDelayMs) // BackendEvent 是接口联合，需 as unknown as 双转（TS2352）
      genTimers.push(timer)
    })
    this.generationTimers.set(genId, genTimers)
  }
  private clearTimers(): void {
    this.generationTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)))
    this.generationTimers.clear()
  }
  private emit(event: BackendEvent): void { this.handler?.(event) }
}
```
（注意：删旧 `private timers` 平铺数组与旧 `scheduleReplay`/`clearTimers`。）

- [ ] **Step 4: 跑测试确认通过 + 消费方回归**

Run: `pnpm -F @cyrene/desktop test tests/unit/mock-replay.spec.ts tests/unit/mock-backend-state.spec.ts tests/unit/chat-service.spec.ts`
Expected: 既有（回放顺序/schema/list/状态回调/chat-service）+ 新增 6 例全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/tests/unit/mock-replay.spec.ts
git commit -m "fix(阶段0/1批次D T1): MockBackend 隔离与真实性——每实例状态/一致CRUD/唯一ID注入/单generation取消/可注入clock-ID(FE-S0-P1-03)"
```

---

### Task 2: Node engines + 版本检查脚本（FE-S0-P2-01，D3）

**Files:**
- Modify: `package.json`、`apps/desktop/package.json`
- Create: `apps/desktop/scripts/node-version-ok.mjs`、`apps/desktop/scripts/check-node-version.mjs`
- Test: `apps/desktop/tests/unit/node-version-ok.spec.ts`

**Interfaces:**
- Produces: `nodeVersionOk(version, range)`（纯函数，vitest 可 import .mjs）
- Consumes: `semver`（加显式 devDependency）

- [ ] **Step 1: 写失败测试**——`tests/unit/node-version-ok.spec.ts`（新）：

```ts
import { describe, expect, it } from 'vitest'
import { nodeVersionOk } from '../../scripts/node-version-ok.mjs'

describe('nodeVersionOk（FE-S0-P2-01）', () => {
  const RANGE = '>=22.23.0 <23'
  it('22.23.0 → true（.nvmrc 基准）', () => { expect(nodeVersionOk('22.23.0', RANGE)).toBe(true) })
  it('22.22.0 / 23.0.0 / 24.0.0 → false', () => {
    expect(nodeVersionOk('22.22.0', RANGE)).toBe(false)
    expect(nodeVersionOk('23.0.0', RANGE)).toBe(false)
    expect(nodeVersionOk('24.0.0', RANGE)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/node-version-ok.spec.ts`
Expected: 任务失败——`node-version-ok.mjs` 不存在 → import 报错。

- [ ] **Step 3: 实现**

`apps/desktop/scripts/node-version-ok.mjs`：
```js
// 纯函数：版本是否满足 range（vitest node 环境可 import；semver 须为显式 devDependency）
import semver from 'semver'
export function nodeVersionOk(version, range) {
  return semver.satisfies(version, range)
}
```

`apps/desktop/scripts/check-node-version.mjs`：
```js
// 启动前 Node 版本检查（FE-S0-P2-01）：engines 单一来源 = 本脚本旁的 package.json（import.meta 锚定，
// 禁 cwd 相对路径——pnpm -F 下 cwd=包目录、根跑读仓库外，双二义）。不匹配非零退出。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nodeVersionOk } from './node-version-ok.mjs'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const range = pkg.engines?.node
if (!range) {
  console.error('package.json 缺少 engines.node')
  process.exit(1)
}
if (!nodeVersionOk(process.version, range)) {
  console.error(`Node 版本需满足 ${range}（当前 ${process.version}）。请用 fnm 切换：fnm install 22.23.0 && fnm default 22.23.0`)
  process.exit(1)
}
```

`package.json`（根）：
- `engines.node` → `">=22.23.0 <23"`；
- scripts 增 `"check:node": "node apps/desktop/scripts/check-node-version.mjs"`——**复用桌面脚本**（其 `import.meta` 锚定 `apps/desktop/package.json` 的 engines；根与 desktop 两处 engines 同值 `>=22.23.0 <23`，检查任一等价——叙事如此，勿另造读根脚本）。

`apps/desktop/package.json`：
- `engines.node` → `">=22.23.0 <23"`；
- `semver` 加入 devDependencies（实现者执行 `pnpm -F @cyrene/desktop add -D semver`，锁文件更新；不必固定版本号）；
- scripts 增 `"check:node": "node scripts/check-node-version.mjs"`，`predev`/`prebuild`/`pretest` 各加 `"node scripts/check-node-version.mjs"`（直接 node 形式，省一层嵌套；pnpm 11.20 默认执行 pre/post hooks，已实测 pre exit 非零会 fail-fast 拦截主脚本）。

- [ ] **Step 4: 验证**

Run: `node apps/desktop/scripts/check-node-version.mjs`（exit 0）与 `node -e "const {nodeVersionOk}=await import('./apps/desktop/scripts/node-version-ok.mjs'); console.log(nodeVersionOk('23.0.0','>=22.23.0 <23'))"`（false）；`pnpm -F @cyrene/desktop test tests/unit/node-version-ok.spec.ts` 全绿；`pnpm -F @cyrene/desktop typecheck` 绿。

- [ ] **Step 5: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/scripts/node-version-ok.mjs apps/desktop/scripts/check-node-version.mjs apps/desktop/tests/unit/node-version-ok.spec.ts pnpm-lock.yaml
git commit -m "fix(阶段0/1批次D T2): Node engines >=22.23.0 <23 + 启动前版本检查脚本非零退出(FE-S0-P2-01)"
```

---

### Task 3: 占位命令 + 子 README + 主 README preload（FE-S0-P2-02，D4）

**Files:**
- Modify: `apps/desktop/package.json`、`apps/desktop/src/main/credentials/README.md`、`apps/desktop/src/main/diagnostics/README.md`、`README.md`（目录树 preload 行）

**Interfaces:**
- 无跨任务接口。

- [ ] **Step 1: 改占位命令**（`apps/desktop/package.json`）

```json
    "test:e2e": "echo 'E2E(Playwright) 留待阶段 3 配置——本命令未实现，非零退出防假绿' && exit 1",
    "make": "echo 'Forge 打包留待阶段 8 配置——本命令未实现，非零退出防假绿' && exit 1",
```

- [ ] **Step 2: 改子 README**

`credentials/README.md` 全文替换为真实描述（中文，约 8-12 行）：safeStorage 加密 `credentials.json`（0600/原子写/多 key 加密块）+ 白名单 key 单一来源（`shared/contracts/credentials.ts`）+ 4 值 `credentialStatus`（unavailable/locked/empty/available）+ token-origin 绑定（`connection-config` 特判委派）+ 串行队列 + `close()/drain`（批次 A）；Renderer 只经 IPC 见 status 绝不明文。

`diagnostics/README.md` 全文替换为真实描述（中文，约 8-12 行）：rotate 日志（`app.log` 5MB×3 + 定时 flush + 退出 flush）+ daily append-only 审计（`audit-YYYY-MM-DD.jsonl` sync 逐行 fsync + 30 天清理）+ `sanitize`/`redact` 双净化（敏感值永不落盘/不进出诊断导出）+ 退出有序关闭（凭据→adapter→diagnostics，批次 A/C）；运行日志与审计用途区分（可改删 vs 合规证据）。

- [ ] **Step 3: 主 README 目录树 preload 行 + 命令表非零语义**

`README.md` 目录树 `├── src/preload/   具名 DesktopApi 占位(contextBridge)` → `├── src/preload/   具名窄 desktopApi(contextBridge, schema 校验)`（preload 已是真实实现，含 `desktop-api.ts`/`index.ts`/`index.d.ts`）。

`README.md` 命令表 `test:e2e`/`make` 行：把「仍为占位，留后续阶段」改为「占位命令，**未实现，非零退出防假绿**」（与 package.json 的 `exit 1` 语义一致；`test:e2e`/`make` 两行）。

- [ ] **Step 4: 验证**

Run: `pnpm -F @cyrene/desktop test:e2e; echo "exit=$?"` 与 `pnpm -F @cyrene/desktop make; echo "exit=$?"`（均 exit=1）；`grep -c "占位" apps/desktop/src/main/credentials/README.md apps/desktop/src/main/diagnostics/README.md`（= 0）；README 目录树 preload 无「占位」。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/main/credentials/README.md apps/desktop/src/main/diagnostics/README.md README.md
git commit -m "fix(阶段0/1批次D T3): 占位命令非零退出 + credentials/diagnostics 子 README 真实化 + 主 README preload 修正(FE-S0-P2-02)"
```

---

### Task 4: 阶段 0 门禁口径冻结（FE-S0-P1-01，D1）

**Files:**
- Modify: `README.md`、`CLAUDE.md`、`docs/16-Cyrene-前端实施任务清单与进度跟踪.md`

**Interfaces:**
- 无跨任务接口（纯文档）。

- [ ] **Step 1: 冻结三态口径与首次联调范围**

按 spec §4.4 修改三处文档：
1. **三态状态**：引入「已开发 / 已验证 / 已真实联调」三态；README/docs16/CLAUDE.md 引用同一状态源；阶段 0 标「**带已知豁免提前开发**」（非「已验证」）；
2. **首次联调范围**：`首次联调 = Linux 本机文本聊天最小闭环`——13 项用例（启动/设置 Token/连接/列会话/激活新建/发送/ACK/双通道流式/completed/取消/断线重连/错误展示/日志定位）；后端 SHA/URL/认证方式/`SERVE_CHAT`（保持 0，`/` 404 ≠ Electron API 不可用）留 B-01 填；
3. **Windows 显式「阶段 1 未通过项」**（真 Windows 运行证据未到，构建级 CI 已有但不替代真机冒烟）；
4. **外部依赖清单**：B-01/H-01/H-07/G-01/G-02/H-04 为阶段通过门禁输入；
5. **README 真实联调启动说明章节**：Real/Mock 装配（打包恒 Real、未打包默认 Real、`CYRENE_BACKEND=mock` 显式 Mock）、Endpoint/Profile/Token 设置流程、B-01 联调门禁（≥3 条真实 raw frame 过 parseRawFrame+mapper+parseBackendEvent）——README 已有「真实模式联调」小节（批次 A 加），在既有基础上补口径；
6. **CI 版本同源声明**：README/CLAUDE.md 补一句——CI 各 job 用 `actions/setup-node node-version-file: .nvmrc`（22.23.0）+ `engineStrict: true`，与 engines `>=22.23.0 <23` 一致（单一版本来源）；
7. docs/16 阶段标题与 README 状态同步为三态口径（**含 docs/16 既有「已完成/已开发未联调」两态规则段改为三态**，避免内部两态三态并存）。

- [ ] **Step 2: 验证口径一致**

Run: `grep -n "带已知豁免提前开发\|已真实联调" README.md CLAUDE.md "docs/16-Cyrene-前端实施任务清单与进度跟踪.md"`（三处一致）；确认无「阶段 0 已完成」残留（README 旧「阶段 0 已完成」改为「带已知豁免提前开发」）；`grep -c "首次联调 = Linux 本机文本聊天最小闭环" README.md`（≥1）。

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md "docs/16-Cyrene-前端实施任务清单与进度跟踪.md"
git commit -m "docs(阶段0/1批次D T4): 阶段0门禁口径冻结——三态状态/首次联调范围/Windows未通过项/外部依赖(FE-S0-P1-01)"
```

---

### Task 5: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`（应 ≥493 + Mock 新增 6）、`xvfb-run -a pnpm -F @cyrene/desktop test:integration`（应 23+）、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`（11/11）、`pnpm -F @cyrene/desktop package`、`xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke`；**人工复跑**：`pnpm -F @cyrene/desktop test:e2e; echo $?` 与 `pnpm -F @cyrene/desktop make; echo $?` 均非零；`pnpm -F @cyrene/desktop predev` exit 0（当前 Node 22.23.0 通过）；**predev 非零路径**：`node apps/desktop/scripts/check-node-version.mjs` 以 `node-version-ok` 验证（单测已覆盖 23.0.0/22.22.0 false），或临时 `NODE_OPTIONS` 不可行时以单测 2/2 为凭据（版本不符 → nodeVersionOk false → 脚本 exit 1 逻辑由单测+代码路径证明）。
Expected: 全部绿；占位命令非零；predev 零退出 + 非零路径由单测覆盖。

- [ ] **Step 2: 确认无代码变更**

Run: `git status --short`
Expected: 无本任务产生的改动；不 commit。

---

## 自审（对照 spec）

- §4.1 Mock（每实例状态/CRUD/唯一 ID/可注入 clock-ID/单 gen 取消/测试）→ T1；默认 idFactory 唯一、createMockConversations 与旧一致、cancel no-op + 静默、测试先等 started → T1 Step 1/3。
- §4.2 Node（engines/版本脚本 import.meta 锚定/semver devDep/pre-post hooks/CI 同源）→ T2。
- §4.3 占位命令 + 子 README + 主 README preload → T3。
- §4.4 阶段 0 口径（三态/范围/Windows 未通过/外部依赖/启动说明）→ T4。
- §5 门禁（含占位命令人工复跑 + predev exit 0）→ T5。
- 已知限制（渲染单活跃代、Mock send 不校验会话、占位命令勿入 CI 门禁、hook 覆盖范围）→ T1/T2 注释 + 最终报告。

> **注**：文档同步（README/CLAUDE.md/docs16 批次 D 落地数字 + 落地行）属 SDD 工作流后续步骤，实施完成后由控制器执行；T4 已做结构性口径冻结，后续文档同步只补数字与落地行。
