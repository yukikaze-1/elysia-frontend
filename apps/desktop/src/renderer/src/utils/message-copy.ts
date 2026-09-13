// src/renderer/src/utils/message-copy.ts
// 「复制这条消息」的可复制正文判定（H-02，2026-09-11；2026-09-13 抽出为单一来源）。
//
// 抽出的理由：同一判据现在有**两个入口**——消息操作行的「复制」按钮与消息右键菜单的复制项。
// 两处各写一份必然漂移（本仓库已经吃过"判据有两份副本、反应还不同"的亏，见 character-identity 收敛）。
//
// 语义（H-02 定下的，未变）：只复制**用户可读正文**——user 取 content；assistant 取 public_reply
// 的文本/正文分段拼接（内心独白不是「回答」本身，技术元数据也不是），分段之间空行分隔。
import type { AssistantSegment, Message } from '@shared/contracts'

function isTextSegment(segment: AssistantSegment): boolean {
  return segment.kind === 'text' || segment.kind === 'markdown'
}

export function messageCopyableText(message: Message): string {
  if (message.role === 'user') return message.content ?? ''
  const publicSegments = (message.assistantSegments ?? [])
    .filter((s) => s.channel === 'public_reply')
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
  return publicSegments.filter(isTextSegment).map((s) => s.text ?? '').join('\n\n').trim()
}
