// tests/unit/attachment-policy.spec.ts
// Task 6:纯校验策略（spec §4.5/§3.2 D-04）——kind 矩阵、魔数嗅探、数量/聚合/单文件限额预检。env=node 无 fs。
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX_BYTES_BY_KIND } from '../../src/shared/contracts/attachments'
import { isKindAcceptable, kindFromMime, precheckFiles, sniffKind, wireKindHint } from '../../src/main/attachments/attachment-policy'

describe('kindFromMime / isKindAcceptable（D-03 矩阵）', () => {
  it('白名单 MIME → 对应 kind', () => {
    expect(kindFromMime('image/png')).toBe('image')
    expect(kindFromMime('video/mp4')).toBe('video')
    expect(kindFromMime('audio/mpeg')).toBe('audio')
  })
  it('列表外 → file', () => {
    expect(kindFromMime('application/pdf')).toBe('file')
    expect(kindFromMime('application/octet-stream')).toBe('file')
  })
  it('isKindAcceptable 按 kind 白名单；file 恒真', () => {
    expect(isKindAcceptable('image', 'image/png')).toBe(true)
    expect(isKindAcceptable('image', 'video/mp4')).toBe(false)
    expect(isKindAcceptable('file', 'anything/x')).toBe(true)
  })
})

describe('sniffKind（轻量魔数嗅探）', () => {
  const head = (bytes: number[]) => new Uint8Array(bytes)
  it('PNG / JPEG / GIF / WebP', () => {
    expect(sniffKind(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image')
    expect(sniffKind(head([0xff, 0xd8, 0xff, 0xe0]))).toBe('image')
    expect(sniffKind(head([0x47, 0x49, 0x46, 0x38]))).toBe('image')
    // P1-4：RIFF 分支按 bytes[8..11] 判 WEBP/WAVE——测试用真实 12 字节 RIFF+WEBP 头（裸 RIFF 无法判 kind）
    expect(sniffKind(head([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))).toBe('image')
  })
  it('MP4（ftyp）/ WebM / OGG', () => {
    expect(sniffKind(head([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe('video')
    expect(sniffKind(head([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video')   // EBML → webm
    expect(sniffKind(head([0x4f, 0x67, 0x67, 0x53]))).toBe('audio')   // OggS → ogg（video/audio 以 kind 区分）
  })
  it('MP3（ID3）/ WAV / FLAC / 未知', () => {
    expect(sniffKind(head([0x49, 0x44, 0x33, 0x03]))).toBe('audio')
    expect(sniffKind(head([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe('audio')
    expect(sniffKind(head([0x66, 0x4c, 0x61, 0x43]))).toBe('audio')
    expect(sniffKind(head([0x00, 0x11, 0x22, 0x33]))).toBe('file')
  })
})

describe('precheckFiles（数量/聚合/单文件限额）', () => {
  it('数量 > 10 → too_many', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1, mediaType: 'image/png' }))
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('too_many')
  })
  it('聚合 > 64MB → too_large_aggregate', () => {
    const files = [{ name: 'a', size: 40 * 1024 * 1024, mediaType: 'video/mp4' }, { name: 'b', size: 30 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('too_large_aggregate')
  })
  it('单文件超 kind 限额 → size_limit', () => {
    const files = [{ name: 'a', size: ATTACHMENT_MAX_BYTES_BY_KIND.image + 1, mediaType: 'image/png' }]
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('size_limit')
  })
  it('视频超 50MB → size_limit（kind 按 MIME 判定）', () => {
    const files = [{ name: 'v', size: 51 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(precheckFiles(files).ok).toBe(false)
  })
  it('全部通过 → ok:true，无 issues', () => {
    expect(precheckFiles([{ name: 'a', size: 1024, mediaType: 'image/png' }]).ok).toBe(true)
  })
})

describe('wireKindHint（webm 魔数无法区分 audio/video，特例回退 MIME）', () => {
  it('audio/webm：video → audio', () => {
    expect(wireKindHint('video', 'audio/webm')).toBe('audio')
  })
  it('video/webm：保持 video', () => {
    expect(wireKindHint('video', 'video/webm')).toBe('video')
  })
  it('非 webm 不受影响（image png / 无 kind 默认）', () => {
    expect(wireKindHint('image', 'image/png')).toBe('image')
    expect(wireKindHint('file', 'audio/webm')).toBe('file')   // 非 video 魔数结果不触发回退
  })
})
