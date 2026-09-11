// src/renderer/src/utils/character-identity.ts
// 角色状态身份的**唯一**判据（H-06/H-07 结构性修法之一，2026-09-11）。
//
// 只读侦察发现「三方身份相等」这条规则在本仓库被抄了 **两份**，且各自的**反应**不同：
//   · character-runtime.store.ts:272-281 —— 不匹配则 `throw stateIdentityError()`（fail-closed）
//   · CyCharacterPublicState.vue:72-74   —— 不匹配则 `return undefined`（渲染空，静默）
// 两份各自演化 ⇒ 任何一份漏掉某个字段，就会出现「一个入口拦截、另一个入口放行」的裂缝，
// 而这类裂缝正是本项两个确定性缺陷（修订号不跟随、自建角色无状态）得以长期潜伏的土壤。
//
// **注意（我自己的第一版判断有误，此处如实改正）**：侦察原始结论说"三份"。实际核对后，
// 第三处（store 的事件应用路径 `:358-365`）**不是同一条规则**——它在修订号不等之外还带一个例外
// （非活跃会话可以填充另一修订号的键）。把那个例外硬塞进本判据会**改变行为**，故刻意**不动它**。
// 收敛只针对真正的重复，不追求"看起来统一"。
//
// 本模块把**规则**收敛为一处；**反应**仍由调用方决定（throw / undefined）——
// 因为那两种反应在各自语境下都是对的，不该被强行统一。
//
// 刻意不自建类型：直接复用契约里的 `CharacterPublicState` 与绑定快照字段，
// 避免再抄一份镜像（本项目已多次被"手抄的镜像"咬过）。
import type { CharacterPublicState } from '@shared/contracts'

/** 身份比较所需的绑定侧字段（取自 CharacterBindingSnapshot 的子集） */
export interface CharacterIdentityExpectation {
  characterId: string
  characterInstanceId: string
  characterRevision: number
}

/** 身份不匹配的字段名；全部匹配时为 undefined */
export type CharacterIdentityMismatch = 'characterId' | 'characterInstanceId' | 'characterRevision'

/**
 * 返回第一个不匹配的字段（顺序固定：id → instance → revision，便于稳定断言与诊断）。
 * 全部匹配返回 `undefined`。纯函数、无副作用——三方（store/组件/事件路径）共用同一判据。
 */
export function characterIdentityMismatch(
  state: Pick<CharacterPublicState, 'characterId' | 'characterInstanceId' | 'characterRevision'>,
  expected: CharacterIdentityExpectation
): CharacterIdentityMismatch | undefined {
  if (state.characterId !== expected.characterId) return 'characterId'
  if (state.characterInstanceId !== expected.characterInstanceId) return 'characterInstanceId'
  if (state.characterRevision !== expected.characterRevision) return 'characterRevision'
  return undefined
}

/** 便捷布尔形式（供只需"是否匹配"的调用点使用，语义与上面的判据完全同源） */
export function characterIdentityMatches(
  state: Pick<CharacterPublicState, 'characterId' | 'characterInstanceId' | 'characterRevision'>,
  expected: CharacterIdentityExpectation
): boolean {
  return characterIdentityMismatch(state, expected) === undefined
}
