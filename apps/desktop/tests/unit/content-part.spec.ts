// tests/unit/content-part.spec.ts
// Task 4:媒体 ContentPart 建模（spec §4.2/§4.4，D7）——content(unknown) 数组 → 有序文本/媒体条目 + 消息级附件。
import { describe, expect, it } from 'vitest'
import { mapContentMedia, mapContentToEntries, parseAttachmentIdFromSrc } from '../../src/main/transport/protocol-v2/content-part'

describe('parseAttachmentIdFromSrc', () => {
  it('稳定路径尾段解析 att_ ID（校验格式）', () => {
    expect(parseAttachmentIdFromSrc('/api/attachments/att_abc')).toBe('att_abc')
    expect(parseAttachmentIdFromSrc('att_abc')).toBe('att_abc')      // 纯 ID 也可
    expect(parseAttachmentIdFromSrc('/api/attachments/other')).toBeUndefined()  // 非 att_ 前缀拒
    expect(parseAttachmentIdFromSrc(undefined)).toBeUndefined()
    expect(parseAttachmentIdFromSrc('/api/attachments/att_1/extra')).toBeUndefined()  // 尾段必须恰一个
  })
})

describe('mapContentToEntries（有序文本/媒体，供 segmentIndex 分配）', () => {
  it('字符串 content → 单一文本条目', () => {
    expect(mapContentToEntries('你好')).toEqual([{ type: 'text', text: '你好' }])
  })
  it('媒体 ContentPart 数组 → 文本与媒体交错保留顺序', () => {
    const content = [
      { type: 'text', text: '见图：' },
      { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', width: 100, height: 80, attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024 },
      { type: 'video', src: '/api/attachments/att_2', mime: 'video/mp4', duration_ms: 5000 },
      { type: 'file', src: '/api/attachments/att_3', mime: 'application/pdf', attachment_id: 'att_3', filename: 'doc.pdf', size_bytes: 2048 }
    ]
    const entries = mapContentToEntries(content)
    expect(entries[0]).toEqual({ type: 'text', text: '见图：' })
    expect(entries[1]).toMatchObject({ type: 'media', media: { kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 } })
    expect(entries[2]).toMatchObject({ type: 'media', media: { kind: 'video', attachmentId: 'att_2', durationMs: 5000 } })
    expect(entries[3]).toMatchObject({ type: 'media', media: { kind: 'file', attachmentId: 'att_3' } })
  })
  it('attachment_id 缺失时从 src 尾段解析（兜底）', () => {
    const entries = mapContentToEntries([{ type: 'audio', src: '/api/attachments/att_9', mime: 'audio/mpeg' }])
    expect(entries[0]).toMatchObject({ type: 'media', media: { kind: 'audio', attachmentId: 'att_9' } })
  })
  it('sticker ContentPart 不产媒体条目/附件（G4 边界）', () => {
    expect(mapContentToEntries([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }])).toEqual([])
  })
  it('未知 type / 非对象元素 → 忽略（宽容）', () => {
    expect(mapContentToEntries([{ type: 'bogus' }, 'x', null])).toEqual([])
  })
})

describe('mapContentMedia（消息级附件）', () => {
  it('媒体 ContentPart → MessageAttachment[]（name/size/尺寸/时长映射）', () => {
    const atts = mapContentMedia([
      { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024, width: 100, height: 80 },
      { type: 'audio', src: '/api/attachments/att_2', mime: 'audio/mpeg', duration_ms: 3000 }
    ])
    expect(atts).toEqual([
      { attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 },
      { attachmentId: 'att_2', kind: 'audio', mediaType: 'audio/mpeg', durationMs: 3000 }
    ])
  })
  it('无 attachmentId（src 也解析不到）→ 不产附件（媒体缺身份不进领域）', () => {
    expect(mapContentMedia([{ type: 'image', src: '/other/path.png', mime: 'image/png' }])).toEqual([])
  })
  it('纯文本/空 → []', () => {
    expect(mapContentMedia('文本')).toEqual([])
    expect(mapContentMedia(undefined)).toEqual([])
  })
})
