// tests/unit/media-utils.spec.ts
// Task 13:播放矩阵 + 媒体 URL（spec §4.6/§4.4，D9）——PLAYABLE_MEDIA 纯常量、isPlayable、formatFileSize、mediaUrlFor。
import { describe, expect, it } from 'vitest'
import { formatFileSize, isPlayable, PLAYABLE_MEDIA } from '../../src/renderer/src/utils/media'
import { mediaUrlFor } from '../../src/renderer/src/utils/media-url'

describe('PLAYABLE_MEDIA（D-03 播放矩阵，spec §4.6）', () => {
  it('video 可播 mp4/webm/ogg；mkv/mov/h265 不在列表（标暂不支持）', () => {
    expect(PLAYABLE_MEDIA.video).toContain('video/mp4')
    expect(PLAYABLE_MEDIA.video).toContain('video/webm')
    expect(PLAYABLE_MEDIA.video).toContain('video/ogg')
    expect(PLAYABLE_MEDIA.video).not.toContain('video/x-matroska')
    expect(PLAYABLE_MEDIA.video).not.toContain('video/quicktime')
  })
  it('audio 可播 mp3/wav/ogg/flac/m4a', () => {
    for (const m of ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4']) expect(PLAYABLE_MEDIA.audio).toContain(m)
  })
  it('isPlayable 按 kind 白名单', () => {
    expect(isPlayable('video', 'video/mp4')).toBe(true)
    expect(isPlayable('video', 'video/x-matroska')).toBe(false)
    expect(isPlayable('audio', 'audio/wav')).toBe(true)
    expect(isPlayable('image', 'image/png')).toBe(true)
  })
})

describe('formatFileSize / mediaUrlFor', () => {
  it('字节 → 可读大小（B/KB/MB）', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(undefined)).toBe('')
  })
  it('mediaUrlFor 构造同源媒体 URL', () => {
    expect(mediaUrlFor('attachment', 'att_1')).toBe('cyrene://renderer/__cyrene-media/attachment/att_1')
    expect(mediaUrlFor('sticker', 'st_1')).toBe('cyrene://renderer/__cyrene-media/sticker/st_1')
  })
})
