import { describe, expect, it } from 'vitest'
import { StreamAccumulator } from '@shared/domain'
import type { BackendEvent } from '@shared/contracts'

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
    channel: 'public_reply'
  }
}

function completed(): BackendEvent {
  return {
    eventId: 'e-done',
    sequence: 99,
    event: 'generation.completed',
    generationId: 'gen-1',
    responseId: 'rsp-1',
    usage: { input: 10, output: 20, total: 30, source: 'provider_reported' },
    model: 'm1',
    emotion: 'happy'
  }
}

describe('StreamAccumulator 流式归组', () => {
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
