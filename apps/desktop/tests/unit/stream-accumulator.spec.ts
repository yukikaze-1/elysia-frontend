import { describe, expect, it } from 'vitest'
import { StreamAccumulator } from '@shared/domain'
import type { BackendEvent } from '@shared/contracts'
import { ProtocolWarningCode } from '@shared/contracts/protocol'

function started(): BackendEvent {
  return {
    eventId: 'e1',
    sequence: 1,
    event: 'generation.started',
    generationId: 'gen-1',
    messageId: 'msg-1',
    responseId: 'rsp-1',
    conversationId: 'conv-1'
  }
}

function delta(segmentId: string, index: number, seq: number, text: string, channel: 'inner_voice' | 'public_reply' = 'public_reply'): BackendEvent {
  return {
    eventId: `e-${segmentId}-${seq}`,
    sequence: 0,
    event: 'generation.delta',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel,
    kind: 'text',
    deltaSequence: seq,
    text
  }
}

function segmentCompleted(segmentId: string, index: number): BackendEvent {
  return {
    eventId: `ec-${segmentId}`,
    sequence: 0,
    event: 'generation.segment.completed',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel: 'public_reply',
    kind: 'text'
  }
}

function completed(over: Partial<Extract<BackendEvent, { event: 'generation.completed' }>> = {}): BackendEvent {
  return {
    eventId: 'e-done',
    sequence: 99,
    event: 'generation.completed',
    generationId: 'gen-1',
    responseId: 'rsp-1',
    usage: { input: 10, output: 20, total: 30, source: 'provider_reported' },
    model: 'm1',
    emotion: 'happy',
    ...over
  }
}

function generationStarted(generationId: string, messageId: string, responseId: string, conversationId: string): BackendEvent {
  return {
    eventId: `started-${generationId}`,
    sequence: 1,
    event: 'generation.started',
    generationId,
    messageId,
    responseId,
    conversationId
  }
}

function generationDelta(generationId: string, segmentId: string, text: string): BackendEvent {
  return {
    eventId: `delta-${generationId}`,
    sequence: 2,
    event: 'generation.delta',
    generationId,
    segmentId,
    segmentIndex: 0,
    channel: 'public_reply',
    kind: 'text',
    deltaSequence: 0,
    text
  }
}

function generationCompleted(generationId: string, responseId: string): BackendEvent {
  return {
    eventId: `completed-${generationId}`,
    sequence: 3,
    event: 'generation.completed',
    generationId,
    responseId
  }
}

describe('StreamAccumulator 流式归组', () => {
  it('A/B generation 交错时各自按 generation 身份收口，terminal 缺 conversationId 不串会话', () => {
    const accumulatorA = new StreamAccumulator()
    const accumulatorB = new StreamAccumulator()

    // The transport can interleave two independent streams.  The terminal
    // events intentionally omit conversationId: started is the only event
    // that establishes that identity, while each accumulator owns one
    // generationId.
    accumulatorA.apply(generationStarted('generation-a', 'message-a', 'response-a', 'conversation-a'))
    accumulatorB.apply(generationStarted('generation-b', 'message-b', 'response-b', 'conversation-b'))
    accumulatorA.apply(generationDelta('generation-a', 'segment-a', 'A'))
    accumulatorB.apply(generationDelta('generation-b', 'segment-b', 'B'))
    accumulatorB.apply(generationCompleted('generation-b', 'response-b'))
    accumulatorA.apply(generationCompleted('generation-a', 'response-a'))

    expect(accumulatorA.getState()).toMatchObject({
      generationId: 'generation-a', messageId: 'message-a', responseId: 'response-a',
      conversationId: 'conversation-a', status: 'completed'
    })
    expect(accumulatorA.toAssistantSegments().map((segment) => segment.text)).toEqual(['A'])
    expect(accumulatorB.getState()).toMatchObject({
      generationId: 'generation-b', messageId: 'message-b', responseId: 'response-b',
      conversationId: 'conversation-b', status: 'completed'
    })
    expect(accumulatorB.toAssistantSegments().map((segment) => segment.text)).toEqual(['B'])
  })

  it('按 responseId 归组多个分段,segmentIndex 全局排序', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 1, 0, '第一句。'))
    acc.apply(delta('seg-0', 0, 0, '内心独白。', 'inner_voice'))
    acc.apply(delta('seg-2', 2, 0, '第三句。'))
    acc.apply(completed())

    const segs = acc.toAssistantSegments()
    expect(segs.map((s) => s.segmentIndex)).toEqual([0, 1, 2])
    expect(segs.map((s) => s.channel)).toEqual(['inner_voice', 'public_reply', 'public_reply'])
  })

  it('连续增量合并到一个分段', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '你好，'))
    acc.apply(delta('seg-1', 0, 1, '世界。'))
    acc.apply(completed())

    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('你好，世界。')
  })

  it('重复增量被忽略,不产生重复文字', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '只出现一次'))
    acc.apply(delta('seg-1', 0, 0, '只出现一次'))
    acc.apply(delta('seg-1', 0, 1, '，追加'))
    acc.apply(completed())

    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('只出现一次，追加')
  })

  it('乱序增量进入缺口缓冲,补块到达后连续刷出', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 2, '后段'))
    acc.apply(delta('seg-1', 0, 0, '前段'))
    acc.apply(delta('seg-1', 0, 1, '中段'))
    acc.apply(completed())

    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('前段中段后段')
  })

  it('segment.completed 不结束父回复,generation.completed 才完成', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '第一句'))
    acc.apply(segmentCompleted('seg-1', 0))
    expect(acc.getState().status).toBe('streaming')
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
  })

  it('父完成事件先到但仍有缺口时进入 completing,不伪装完整', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '第一块'))
    acc.apply(delta('seg-1', 0, 2, '第三块')) // 序号 1 缺失
    acc.apply(completed())
    expect(acc.getState().status).toBe('completing')
  })

  // C7（2026-09-15 契约评审）：段内 deltaSequence 无缺口、但**整段**丢失（由 mapper 经 segmentGap 告知）
  // 时同样必须落 completing——否则一条少了整段的回复会被当作完整回复。
  // 判别力：去掉 applyCompleted 里的 `|| event.segmentGap === true` ⇒ 本条红（状态会是 completed）。
  it('C7：segmentGap（整段缺失，由 mapper 判定）→ 终态同样落 completing', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '完整的这一段'))
    acc.apply(completed({ segmentGap: true }))
    expect(acc.getState().status).toBe('completing')
    expect(acc.toAssistantSegments()[0].text).toContain('完整的这一段')   // 已有的正文不丢
  })

  it('C7：无 segmentGap 的正常完成仍是 completed（对照，避免误报）', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '完整'))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
  })

  it('中断保留已提交文本,状态为 interrupted', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '已生成内容'))
    acc.markInterrupted()
    expect(acc.getState().status).toBe('interrupted')
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('已生成内容')
  })

  it('父完成写入 usage/model/emotion', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(delta('seg-1', 0, 0, '正文'))
    acc.apply(completed())
    const s = acc.getState()
    expect(s.usage?.total).toBe(30)
    expect(s.model).toBe('m1')
    expect(s.emotion).toBe('happy')
  })
})

function segmentStarted(segmentId: string, index: number, channel: 'inner_voice' | 'public_reply' = 'public_reply', kind: 'text' | 'markdown' = 'text'): BackendEvent {
  return {
    eventId: `es-${segmentId}`,
    sequence: 0,
    event: 'generation.segment.started',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel,
    kind
  }
}

function segmentCompletedWithContent(segmentId: string, index: number, content: string, channel: 'inner_voice' | 'public_reply' = 'public_reply', kind: 'text' | 'markdown' = 'text'): BackendEvent {
  return {
    eventId: `ec-${segmentId}`,
    sequence: 0,
    event: 'generation.segment.completed',
    generationId: 'gen-1',
    segmentId,
    segmentIndex: index,
    channel,
    kind,
    content
  }
}

function completedWithConversationUsage(): BackendEvent {
  return {
    eventId: 'e-done2',
    sequence: 100,
    event: 'generation.completed',
    generationId: 'gen-1',
    responseId: 'rsp-1',
    conversationUsage: { total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' }
  }
}

describe('StreamAccumulator 权威 content 规则(docs/18 §4.4)', () => {
  it('① inner voice 只有 started+completed(content),零 delta,最终有文字', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-iv', 0, 'inner_voice'))
    acc.apply(segmentCompletedWithContent('seg-iv', 0, '内心独白', 'inner_voice'))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('内心独白')
    expect(seg?.channel).toBe('inner_voice')
  })

  it('② public reply 仅 completed(content),零 delta,最终有文字', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-pr', 0, 'public_reply', 'markdown'))
    acc.apply(segmentCompletedWithContent('seg-pr', 0, '完整回复', 'public_reply', 'markdown'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('完整回复')
  })

  it('③ delta 只到一半,completed(content) 覆盖为完整文本', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '前'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '完整文本'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('完整文本')
  })

  it('④ delta 乱序/有缺口,completed(content) 清除缺口并完成父', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 2, '后')) // 序号 0/1 缺失
    acc.apply(segmentCompletedWithContent('seg-1', 0, '权威完整'))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed') // 缺口被权威 content 清除
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('权威完整')
  })

  it('⑤ completed 不带 content 保留 delta 拼接结果', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '你好，'))
    acc.apply(delta('seg-1', 0, 1, '世界。'))
    acc.apply(segmentCompleted('seg-1', 0))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('你好，世界。')
  })

  it('⑥ content 空串正确覆盖(不 truthy 判断)', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '将被覆盖'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, ''))
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
    // 空段不出现在可见分段(空内容不显示)
    expect(acc.toAssistantSegments()).toHaveLength(0)
  })

  it('⑦ completed 后迟到 delta 忽略并告警', () => {
    const warnings: { code: string }[] = []
    const acc = new StreamAccumulator({ onProtocolWarning: (w) => warnings.push(w) })
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '权威'))
    acc.apply(delta('seg-1', 0, 1, '迟到'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.text).toBe('权威') // 不被迟到 delta 污染
    expect(warnings.some((w) => w.code === ProtocolWarningCode.ACCUMULATOR_LATE_DELTA_AFTER_AUTHORITATIVE)).toBe(true)
  })

  it('⑧ kind=markdown 不被改成 text', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0, 'public_reply', 'markdown'))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '**加粗**', 'public_reply', 'markdown'))
    acc.apply(completed())
    const [seg] = acc.toAssistantSegments()
    expect(seg?.kind).toBe('markdown')
  })

  it('权威 content 落地后父回复仍未完成,generation.completed 才完成', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(segmentCompletedWithContent('seg-1', 0, '段'))
    expect(acc.getState().status).toBe('streaming') // segment.completed 不结束父回复
    acc.apply(completed())
    expect(acc.getState().status).toBe('completed')
  })

  it('conversationUsage 新形状写入', () => {
    const acc = new StreamAccumulator()
    acc.apply(started())
    acc.apply(segmentStarted('seg-1', 0))
    acc.apply(delta('seg-1', 0, 0, '正文'))
    acc.apply(completedWithConversationUsage())
    expect(acc.getState().conversationUsage).toEqual({ total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' })
  })
})
