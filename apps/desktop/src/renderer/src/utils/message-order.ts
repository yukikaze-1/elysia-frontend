// 消息排序比较器（spec §4.3.3 P0-1）：(createdAt, messageId) 升序。
// message.store 有序插入 / loadPage 防御性排序 / loadSnapshot 排序 / 虚拟列表锚点前缀和共用。
import type { Message } from '@shared/contracts'

export function cmpMsg(a: Message, b: Message): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  if (a.messageId < b.messageId) return -1
  if (a.messageId > b.messageId) return 1
  return 0
}
