// renderer/src/message/domain.ts
// 消息领域的纯判据：character identity ↔ 契约快照的比对规则。
//
// 这些函数此前是 `message.store.ts` 的模块级 helper（`characterIdentityTuple` /
// `sameCharacterInstance`），原本就无法访问 store 状态，但只有 store 集成用例能到达。
// 原样下沉后单测可直接构造畸形 tuple（缺字段 / 非整数 revision / revision < 1）。
import type { CharacterBindingSnapshot, CharacterGenerationRef } from '@shared/contracts'

/**
 * 事件/消息携带的角色身份三元组。
 *
 * 三个字段**必须同时**成立才算一份身份：任一缺失或畸形（revision 非正整数）即返回 `undefined`
 * ——调用方据此走 fail-closed 分支，而不是拿半份身份去归属一条消息。
 */
export function characterIdentityTuple(value: {
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}): [string, string, number] | undefined {
  if (
    typeof value.characterId !== 'string' || value.characterId.length === 0
    || typeof value.characterInstanceId !== 'string' || value.characterInstanceId.length === 0
    || typeof value.characterRevision !== 'number' || !Number.isInteger(value.characterRevision) || value.characterRevision < 1
  ) return undefined
  return [value.characterId, value.characterInstanceId, value.characterRevision]
}

/**
 * 是否同一个角色实例。
 *
 * 刻意**不比对 revision**：一个会话绑定的是稳定的角色实例，而其归档消息可以引用该实例历史上
 * 用过的任意内容版本（follow_latest 会在轮次之间前进 revision）。比对 revision 会把合法的
 * 历史版本快照判成异实例数据而丢弃。
 */
export function sameCharacterInstance(
  left: Pick<CharacterGenerationRef, 'characterId' | 'characterInstanceId'>,
  right: Pick<CharacterBindingSnapshot, 'characterId' | 'characterInstanceId'>
): boolean {
  return left.characterId === right.characterId && left.characterInstanceId === right.characterInstanceId
}

/**
 * 取消码（正式 `GENERATION_CANCELLED` + legacy `CANCELLED`，D3，二次联调 §6.3）。
 *
 * 取消是**终态但不是失败**：它落 `interrupted` 且不设 `lastError`（用户主动取消不该弹「发送失败」）。
 */
export function isCancellationCode(code: string | undefined): boolean {
  return code === 'GENERATION_CANCELLED' || code === 'CANCELLED'
}
