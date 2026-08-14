// tests/unit/content-part.spec.ts
// Task 4:媒体 ContentPart 建模（spec §4.2/§4.4，D7）——content(unknown) 数组 → 有序文本/媒体条目 + 消息级附件。
import { describe, expect, it } from 'vitest'
import { extractStickerId, mapContentMedia, mapContentToEntries, parseAttachmentIdFromSrc, STICKER_ID_PATTERN, stickerIdOf, toOptionalNonNegativeNumber } from '../../src/main/transport/protocol-v2/content-part'

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
  it('sticker ContentPart → sticker 条目（assistant 分段）；mapContentMedia 不产附件（P0-03）', () => {
    expect(mapContentToEntries([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }]))
      .toEqual([{ type: 'sticker', stickerId: 'st_1' }])
    expect(mapContentMedia([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }])).toEqual([])
  })
  it('未知 type / 非对象元素 → 忽略（宽容）', () => {
    expect(mapContentToEntries([{ type: 'bogus' }, 'x', null])).toEqual([])
  })
})

describe('sticker 恢复 helpers（P0-03，spec §4.3）', () => {
  it('stickerIdOf：sticker_id 优先；src 经 stickerIdFromResourceUrl 兜底（真实 /static/stickers/{id}.png）；非法拒绝', () => {
    expect(stickerIdOf({ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' })).toBe('st_1')
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/st_2.png' })).toBe('st_2')        // src 兜底（真实形态）
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/bad.png' })).toBeUndefined()      // 非 st_ 前缀拒
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/st_1.jpeg' })).toBeUndefined()    // 非 .png 拒
    expect(stickerIdOf({ type: 'sticker' })).toBeUndefined()
    expect(stickerIdOf(null)).toBeUndefined()
    expect(stickerIdOf({ type: 'image' })).toBeUndefined()
  })
  it('extractStickerId：整数组扫描 first-wins；单 part 亦可；无 → undefined', () => {
    expect(extractStickerId([{ type: 'text', text: '见图' }, { type: 'sticker', sticker_id: 'st_1', src: '/s.png' }, { type: 'sticker', sticker_id: 'st_2', src: '/s.png' }])).toBe('st_1')
    expect(extractStickerId({ type: 'sticker', sticker_id: 'st_3' })).toBe('st_3')
    expect(extractStickerId([{ type: 'text', text: 'x' }])).toBeUndefined()
    expect(extractStickerId('plain')).toBeUndefined()
    expect(extractStickerId(undefined)).toBeUndefined()
  })
  it('STICKER_ID_PATTERN 单一来源：@shared/domain re-export 与媒体代理一致', () => {
    expect(STICKER_ID_PATTERN.test('st_abc-1')).toBe(true)
    expect(STICKER_ID_PATTERN.test('ST_1')).toBe(false)
    expect(STICKER_ID_PATTERN.test('st_1.png')).toBe(false)
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

describe('toOptionalNonNegativeNumber（P0-02：可空数字归一化，spec §4.2）', () => {
  it('合法数字与 0 保留；undefined 缺省', () => {
    expect(toOptionalNonNegativeNumber(100)).toBe(100)
    expect(toOptionalNonNegativeNumber(0)).toBe(0)
    expect(toOptionalNonNegativeNumber(undefined)).toBeUndefined()
  })
  it('null/负/NaN/Infinity/字符串 → undefined', () => {
    expect(toOptionalNonNegativeNumber(null)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(-1)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(NaN)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(Infinity)).toBeUndefined()
    expect(toOptionalNonNegativeNumber('100')).toBeUndefined()
  })
})

describe('mapContentMedia / mapContentToEntries 可空数字（P0-02）', () => {
  it('image width:null,height:null → 领域不含两字段且媒体保留', () => {
    const atts = mapContentMedia([{ type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', width: null, height: null }])
    expect(atts).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }])
  })
  it('audio duration_ms:null、file size_bytes:null → 条目不含该字段', () => {
    const entries = mapContentToEntries([
      { type: 'audio', src: '/api/attachments/att_2', mime: 'audio/mpeg', attachment_id: 'att_2', duration_ms: null },
      { type: 'file', src: '/api/attachments/att_3', mime: 'application/pdf', attachment_id: 'att_3', size_bytes: null }
    ])
    expect(entries[0]).toMatchObject({ type: 'media', media: { kind: 'audio', attachmentId: 'att_2' } })
    expect(entries[1]).toMatchObject({ type: 'media', media: { kind: 'file', attachmentId: 'att_3' } })
    expect((entries[0] as { media: { durationMs?: number } }).media.durationMs).toBeUndefined()
  })
})
