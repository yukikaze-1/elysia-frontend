/**
 * 会话身份单例（多套 UI 基础 / 解循环依赖，2026-09-10）。
 *
 * 为什么单独存在：`conversation.store → message.store → conversation.store` 与
 * `settings.store → conversation.store → message.store → voice.store → settings.store`
 * 两组环，其**唯一成因**是「非会话模块也要读当前会话 id」。把 `currentId` 放进 conversation
 * store 就等于让它成为全应用的中枢，任何读取者都会与它成环。
 *
 * 本模块是该读需求的**最小公共下沉**：
 *   - 只有会话身份，不含列表/游标/错误/离线视图等会话业务状态；
 *   - 零依赖（不 import 任何 store），故任何模块依赖它都不会产生环；
 *   - 写方唯一：`conversation.store`（会话切换/激活/离线水合时同步）。
 *
 * 依赖方向：
 *     conversation.store ──写──▶ session ──读──▶ message / settings / voice …
 * 读方之间、读方与 conversation 之间不再需要互相 import。
 *
 * 与 Pinia 的关系：`currentId` 需要在 Vue 计算属性 / watch 中保持响应性，故仍用 `ref`
 * 承载（与仓库既有 store 同构）；但本模块**不是** Pinia store——它没有 actions，
 * 也不需要 `setActivePinia`，从而可在任何语境（含模块级、测试无 Pinia 实例时）安全读取。
 */
import { ref, type Ref } from 'vue'
import type { CharacterBindingSnapshot, Conversation } from '@shared/contracts'

const currentId = ref<string>()
const activeCharacter = ref<CharacterBindingSnapshot>()
const conversations = ref<readonly Conversation[]>([])

/** 当前会话 id；未选中任何会话时为 `undefined`。响应式，可在 computed/watch 中直接使用。 */
export function getCurrentConversationId(): string | undefined {
  return currentId.value
}

/** 响应式引用本体——供 `computed`/`watch` 依赖收集使用。 */
export function currentConversationIdRef(): Readonly<Ref<string | undefined>> {
  return currentId
}

/**
 * 当前会话绑定的角色身份（会话列表项派生）。
 * 与 currentId 同源同写方，故一并下沉——`voice.store` 的事件归属校验需要它，
 * 若仍从 conversation store 读则环无法解开。
 */
export function getActiveCharacterBinding(): CharacterBindingSnapshot | undefined {
  return activeCharacter.value
}

/**
 * 同步当前会话 id。唯一调用方为 `conversation.store`。
 * 同日重复写入是幂等的（不触发无谓的响应式派发）。
 */
export function setCurrentConversationId(next: string | undefined): void {
  if (currentId.value === next) return
  currentId.value = next
}

/** 同步当前会话角色绑定。唯一调用方为 `conversation.store`（`currentCharacter` 变更时）。 */
export function setActiveCharacterBinding(next: CharacterBindingSnapshot | undefined): void {
  if (activeCharacter.value === next) return
  activeCharacter.value = next
}

/**
 * 当前已知会话列表的**只读镜像**（同一数组引用，非拷贝——内存开销为常数）。
 * `message.store` 需要按 conversationId 反查角色绑定；若直接读 conversation store
 * 则 `conversation ↔ message` 成环。镜像后读方只见快照，写方仍唯一。
 */
export function getConversationsSnapshot(): readonly Conversation[] {
  return conversations.value
}

/** 按 id 反查会话（message 侧角色绑定查询的收口）。 */
export function findConversation(conversationId: string): Conversation | undefined {
  return conversations.value.find((item) => item.id === conversationId)
}

/** 同步会话列表镜像。唯一调用方为 `conversation.store`。 */
export function setConversationsSnapshot(next: readonly Conversation[]): void {
  if (conversations.value === next) return
  conversations.value = next
}

/** 仅供测试：重置为「无会话」。 */
export function resetCurrentConversationId(): void {
  currentId.value = undefined
  activeCharacter.value = undefined
  conversations.value = []
}
