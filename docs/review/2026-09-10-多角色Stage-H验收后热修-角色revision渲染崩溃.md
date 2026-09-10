# 多角色 Stage H 验收后热修：角色 revision 渲染崩溃

**记录日期：** 2026-09-10

**文档状态：** 已修复并通过本地门禁；**真机端到端复验待执行**

**热修提交：** `2b31719`（`fix(character): stop reactive proxy clone from crashing message list`）

**Stage H 功能基线：** 前端 `d02ce15`（不变）；后端 `7d2e2b31` / `0.1.0+7d2e2b3`（不变）

**上位验收：** [多角色 Stage H 最终真实联调验收](2026-09-10-多角色Stage-H最终真实联调验收.md)

**契约影响：** 无。`character-contract-v1`、`schemaHash`、公开错误码、领域事件与 IPC 面均未改动。

---

## 1. 结论

Stage H 闭账后发现一个**渲染期崩溃**：在绑定角色的会话中发送第一条消息，assistant 消息首次渲染时抛 `DataCloneError: #<Object> could not be cloned`，异常逃逸渲染函数导致虚拟列表根元素坍缩——表现为**消息列表消失、输入框被顶到聊天区顶部**。

该缺陷与后端无关：后端会话、归档消息、generation 状态和角色绑定均正常，前端 `message-cache-v1.json` 也已落盘两条消息。热修只改前端 Renderer 一个纯函数。

**口径说明：**

- Stage H 的验收结论仍然有效，其功能基线仍是 `d02ce15`；`f4f725e` 只记录闭账文档，`2b31719` 是闭账后的独立热修。
- 本次记录**不修改**已发布的验收结论，也不把热修算作 Stage H 的验收范围。
- 本热修**只通过本地门禁**；真实 Windows Electron + 真实后端的端到端复跑尚未执行（见 §6）。

## 2. 根因

调用链：

```text
CyMessageList 渲染 assistant 消息
  → revisionIdentityFor(message)                    组件模板内，渲染函数中执行
  → characterCatalogStore.revisionIdentity(id, rev)
  → cloneValue(summary.presentation)
  → structuredClone(Vue reactive Proxy) → DataCloneError
```

`summary.presentation` 来自 Pinia `ref`，读取时是 Vue reactive Proxy。`structuredClone` 不支持 Proxy，会抛 `DataCloneError`。异常发生在渲染函数内，Vue 无法降级，虚拟列表根元素（`.cy-messages`）随之坍缩。

**关键定位：** `character-catalog.store.ts` 的 `cloneValue()` 是 Renderer 中**唯一没有异常守卫**的实现。其余五处（`conversation` / `message` / `cache` / `character-runtime` / `character-editor` store）早已采用「优先 `structuredClone`，失败回退 JSON 克隆」的同形防御。因此这是**遗漏**，不是设计分歧——catalog store 的 `revisionIdentity()` 恰好是唯一在渲染路径上被直接调用的克隆入口。

`message.character` 与 catalog 摘要的两条取用路径（列表摘要、detail/revisionIdentityCache）都会命中该调用，故三条路径都需要覆盖。

## 3. 修复

单文件、单函数最小改动：`apps/desktop/src/renderer/src/stores/character-catalog.store.ts`

```ts
function cloneValue<T>(value: T): T {
  const structured = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone
  if (structured) {
    try { return structured(value) } catch { /* Vue reactive proxies use the JSON fallback. */ }
  }
  return JSON.parse(JSON.stringify(value)) as T
}
```

**明确未改动（遵守既有不变量）：**

- 不改变角色 revision identity 的权威顺序；
- 不改变历史快照语义（返回值仍是独立副本，用后即弃）；
- 不放宽角色绑定校验，不删除历史消息的 revision identity 保护；
- 不调整聊天布局、样式或虚拟列表算法；
- 未修改 Main / Preload / IPC / 契约 / 后端；
- 未清理数据库或用户缓存。

普通数据行为不变：`structuredClone` 仍先执行，成功即胜出；仅在其抛出时回退。

## 4. 回归覆盖

### 4.1 store 层：`apps/desktop/tests/unit/character-stores.spec.ts`（+2 用例）

- 写入 Pinia 响应式状态后，**先断言 `isProxy`/`isReactive` 为真**（确认真的走 Proxy 路径，而不是继续只喂普通对象）；
- `revisionIdentity()` 不抛异常，且 `characterId` / `characterRevision` / `displayName` / `presentation` 内容正确；
- 返回副本 `isProxy === false`；修改返回值不反向污染 Store 权威数据；
- 第二条覆盖 detail 路径与 `revisionIdentityCache` 命中路径（两者存取的同样是被 reactive 包装的 Proxy）。

### 4.2 组件层：`apps/desktop/tests/unit/cy-message-list-character-revision.spec.ts`（新增）

不只验证辅助函数，而是**真实挂载** `CyMessageList` + 真实 catalog store + 携带 character ref 的 assistant 消息：

- 断言 `.cy-messages` 存在、`.cy-vlist-row` 数量正确、`.cy-empty` 不出现；
- 断言用户消息与 assistant 正文均可见，且使用精确 revision 的 `displayName`；
- 断言 `console.warn` / `console.error` 零调用（渲染期无异常逃逸）；
- 第二条覆盖「catalog 无该 revision → 不伪造历史身份，渲染仍不崩」。

### 4.3 红绿验证（关键证据）

临时回退热修（恢复裸 `structuredClone`）后：

- store 层两条用例**失败**，报错为 `DataCloneError: #<Object> could not be cloned`；
- 组件层第一条**在 mount 阶段抛出同一个 DataCloneError**，复现真机崩溃形态。

恢复热修后全部转绿。即回归用例确实锚定了本缺陷，而非事后附和。

## 5. 验证证据

| 门禁 | 结果 |
|---|---|
| `vitest run --config vitest.config.mts character-stores` | 1 file / **36 passed** |
| `vitest run --config vitest.config.mts cy-message` | 2 files / **13 passed**（含新增组件回归） |
| `pnpm -F @cyrene/desktop test`（全量单测） | **193 files / 2515 passed + 7 expected-fail + 20 skipped** |
| `pnpm -F @cyrene/desktop typecheck` | 通过（Node + Web） |
| `pnpm -F @cyrene/desktop lint` | 通过，0 warning |
| `pnpm -F @cyrene/desktop build` | 通过 |
| `pnpm test:integration` | **9 failed / 115 passed / 9 skipped**——经基线对照确认为 HEAD 既有失败，与本热修无关（见下） |

**指令口径修正：** `pnpm -F @cyrene/desktop test` 等于 `vitest run`，**不支持** `-- <filter>` 过滤参数；且不存在名为 `character-catalog` 的测试文件。故上表按等价文件 `character-stores` 与模式 `cy-message` 执行。

### 5.1 集成测试既有失败（基线对照）

为避免把既有失败误记为本热修引入，使用 `git stash` 在**未打补丁的 HEAD 工作区**复跑对照：`ipc-security` 与 `perf-gate` 的失败形态与打补丁后**完全一致**。九项失败全部属于既有问题：

| 失败位置 | 性质 |
|---|---|
| `ipc-security.spec.ts`：`desktopApi` 白名单 `expected 91 to deeply equal 90` | 硬编码键表未同步 `resetCharacterEvolution`（preload/types 已有）；基线复现「91 vs 90」 |
| `perf-gate.spec.ts`：套件级崩溃、0 用例执行 | `process.env.HOME!` 在 Windows 为 `undefined`，`join(undefined, …)` 抛错；该 spec 面向 Linux CI，未做跨平台守卫 |
| `electron-live2d.spec.ts`：6 项，均卡在 `openCharacterPane` | 按名点击 `角色与外观`，而 `CySettingsView` 导航已改为 `外观与 Live2D`；选择器未随角色域批次同步 |
| `electron-tools.spec.ts` / `electron-voice.spec.ts`：各 1 项 | 同类既有 spec 漂移 |

这些失败**不在本热修范围内**，本次未修改它们以避免混入无关改动；建议另立批次收敛（否则会持续掩盖真实回归）。

## 6. 仍然开放的边界

1. **真机端到端复验未执行。** 本热修在本机只能验证到「渲染路径不再抛异常、列表与消息正常挂载、无 DataCloneError」。以下场景需在真实 Windows Electron + 真实后端上按原步骤复跑确认：
   - 新建并绑定 Elysia 的 default 会话，发送第一条文本消息；
   - 用户消息立即显示、assistant 流式与最终回复正常；
   - 消息列表不消失、输入框固定在聊天区底部；
   - 切换会话再回来，缓存消息仍可正常显示；
   - 控制台不再出现 `DataCloneError`；
   - 会话列表不错误显示「暂无消息」。
2. **同源风险未消除。** 其余五处 `cloneValue` 依赖同一「失败回退 JSON」约定，目前靠各 store 自律；建议后续统一抽取 JSON-safe clone 工具并加统一测试，避免再次遗漏（本次按范围限制未展开重构）。
3. **Stage H 的验收证据不因本热修刷新。** 阶段 8 恢复前复核发布基线时，应把 `2b31719` 一并计入前端提交历史，而不是只引用 `d02ce15`。

## 7. 完成定义

本热修视为完成的条件：

- [x] 根因定位到具体函数与调用链；
- [x] 修复为最小改动，未触碰契约、Main/Preload、布局与虚拟列表算法；
- [x] store 层与组件层回归均存在，且经红绿验证确认能锚定缺陷；
- [x] typecheck / lint / build / 全量单测通过，数字带日期与前缀 commit 记录；
- [ ] 真实 Windows Electron + 真实后端端到端复跑并留下脱敏证据（§6.1）；
- [ ] 是否把集成测试既有失败另立批次收敛作出明确决定。
