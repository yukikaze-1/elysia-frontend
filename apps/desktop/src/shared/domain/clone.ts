/**
 * JSON-safe 深拷贝（全仓唯一实现）。
 *
 * 背景（2026-09-10 抽取）：本函数此前在 Main 与 Renderer 各自复制了 10 份
 * （6 个 Renderer store：message / character-editor / conversation / character-catalog /
 * cache / character-runtime；4 处 Main：character-service / mock-character-backend /
 * transport/mock-backend / character-draft-store）。其中 **Renderer 的 6 份必须带异常守卫、
 * Main 的 4 份当时没有**——`character-catalog.store.ts` 的那一份恰好是 Renderer 里唯一缺守卫的实现，
 * 于是 `revisionIdentityFor() → revisionIdentity() → cloneValue(summary.presentation)` 在
 * CyMessageList 渲染路径上对 Pinia 的 reactive Proxy 调用 `structuredClone`，
 * 抛 `DataCloneError` 并逃逸渲染函数，导致**消息列表坍缩、输入框被顶到聊天区顶部**
 * （真机事故，修复见 docs/review/2026-09-10-多角色Stage-H验收后热修-角色revision渲染崩溃.md）。
 *
 * 因此本实现**统一带守卫**：结构化克隆可用且成功时走结构化克隆（保真 Date/Map/Set 等），
 * 失败时回退 JSON 快照——Pinia/Vue 的 reactive Proxy 会命中回退分支，而不是把克隆错误抛给调用方。
 *
 * 使用约束：
 * - 回退分支会丢失非 JSON 值（`undefined` 字段、`Date`、`Map`/`Set`、函数）——本仓用它的场景
 *   都是「后端 DTO / 持久化快照」这类纯数据，回退语义可接受；**不要**用它克隆含 Date 的领域对象
 *   并依赖其类型保真，那种场景应在调用点显式序列化。
 * - 值必须可被 JSON 序列化（循环引用会在回退分支抛错，这是有意 fail-loud）。
 */
export function cloneValue<T>(value: T): T {
  const structured = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone
  if (structured) {
    try {
      return structured(value)
    } catch {
      /* Vue reactive Proxy（DataCloneError）或结构化克隆不支持的值 → JSON 回退 */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}
