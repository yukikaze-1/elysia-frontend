// tests/unit/sticker-url.spec.ts
// Task 2:历史资源 URL → stickerId 解析 + 渲染 URL 构造（spec §4.6 P3-3）。
// env=node：纯函数，无 Electron。
import { describe, expect, it } from 'vitest'
import { stickerIdFromResourceUrl, stickerRenderUrl } from '../../src/shared/domain/sticker-url'

describe('stickerIdFromResourceUrl', () => {
  it('绝对路径末段提取 st_ ID（.png 后缀）', () => {
    expect(stickerIdFromResourceUrl('http://127.0.0.1:9000/static/stickers/st_abc.png')).toBe('st_abc')
  })
  it('相对路径末段提取（与配置后端 origin 拼接等价）', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc.png')).toBe('st_abc')
  })
  it('带 query 参数容忍', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc.png?v=2')).toBe('st_abc')
  })
  it('无 .png 后缀也可', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/st_abc')).toBe('st_abc')
  })
  it('非 st_ 前缀拒', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/foo.png')).toBeUndefined()
  })
  it('畸形 id（大小写/非法字符/路径穿越）拒——不注入任意 URL', () => {
    expect(stickerIdFromResourceUrl('/static/stickers/ST_ABC.png')).toBeUndefined()      // 白名单 ^st_[A-Za-z0-9-]+$（小写 st_）
    expect(stickerIdFromResourceUrl('/static/stickers/st_.._x.png')).toBeUndefined()
    expect(stickerIdFromResourceUrl('/static/stickers/../secret.png')).toBeUndefined()   // URL 归一化后末段 secret.png
    expect(stickerIdFromResourceUrl('/static/stickers/st_1/x.png')).toBeUndefined()      // 末段 x.png
  })
  it('空/畸形 URL → undefined', () => {
    expect(stickerIdFromResourceUrl('')).toBeUndefined()
    expect(stickerIdFromResourceUrl('::::')).toBeUndefined()
  })
})

describe('stickerRenderUrl', () => {
  it('构造通用媒体代理 URL（G3 协议，D9）', () => {
    expect(stickerRenderUrl('st_abc')).toBe('cyrene://renderer/__cyrene-media/sticker/st_abc')
  })
})
