// tests/unit/live2d-path.spec.ts
// Task 3（A4）Step 1:parseLive2dPath 合法/非法矩阵（spec §3.4/D5A-08）。env=node。
import { describe, expect, it } from 'vitest'
import { LIVE2D_PATH_PREFIX, parseLive2dPath } from '../../src/main/protocol/live2d-path'

describe('parseLive2dPath', () => {
  it('常量前缀', () => {
    expect(LIVE2D_PATH_PREFIX).toBe('/__cyrene-live2d/')
  })

  it('合法：ASCII slug + 单段/多段 relPath + Unicode 段（percent 编码）', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru/model3.json')).toEqual({ modelId: 'haru', relPath: 'model3.json' })
    expect(parseLive2dPath('/__cyrene-live2d/haru/textures/texture_00.png')).toEqual({ modelId: 'haru', relPath: 'textures/texture_00.png' })
    // Vietnamese/中文段（构建 URL 时按 encodeURIComponent 编码，parse 侧 percent-decode 还原，与 Task 5 适配器对齐）
    expect(parseLive2dPath('/__cyrene-live2d/liel/%E8%A7%92%E8%89%B2.png')).toEqual({ modelId: 'liel', relPath: '角色.png' })
    // 未编码的 Unicode 段也应放行（纯展示/本地路径，无编码要求）
    expect(parseLive2dPath('/__cyrene-live2d/haru/角色.png')).toEqual({ modelId: 'haru', relPath: '角色.png' })
  })

  it('modelId 支持点/下划线/连字符并允许内部点（非单点/双点）', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru-2/model3.json')).toEqual({ modelId: 'haru-2', relPath: 'model3.json' })
    expect(parseLive2dPath('/__cyrene-live2d/_x.1/model3.json')).toEqual({ modelId: '_x.1', relPath: 'model3.json' })
  })

  it('非法：空段（连续斜杠/尾斜杠/仅 modelId 根路径）', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru//model3.json')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/model3.json/')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d//model3.json')).toBeNull() // modelId 段空
  })

  it('非法：点段（字面与 percent 编码）', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru/./model3.json')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/..')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/../secret')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/%2e/secret')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/haru/%2e%2e/secret')).toBeNull()
  })

  it('非法：modelId 超字符集 / 恰为点', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru%20x/model3.json')).toBeNull() // % 不在 ASCII slug 字符集
    expect(parseLive2dPath('/__cyrene-live2d/修女莉尔/model3.json')).toBeNull() // Unicode 非 slug
    expect(parseLive2dPath('/__cyrene-live2d/haru?x/model3.json')).toBeNull() // '?' 非 slug 字符（modelId 段正则拒）
    expect(parseLive2dPath('/__cyrene-live2d/./model3.json')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2d/..')).toBeNull()
  })

  it('非法：解码走私段（%2F / %5C / %00）', () => {
    expect(parseLive2dPath('/__cyrene-live2d/haru/model%2Fsecret')).toBeNull()       // 解码后含 '/'
    expect(parseLive2dPath('/__cyrene-live2d/haru/model3.json%2f')).toBeNull()       // 尾斜杠走私
    expect(parseLive2dPath('/__cyrene-live2d/haru/textures%5Ctexture.png')).toBeNull() // 解码后含 '\'
    expect(parseLive2dPath('/__cyrene-live2d/haru/a%00b.png')).toBeNull()              // NUL
    expect(parseLive2dPath('/__cyrene-live2d/haru/bad%')).toBeNull()                   // 孤立 '%'
  })

  it('非法：未知前缀 / 非 live2d 前缀', () => {
    expect(parseLive2dPath('/foo/bar')).toBeNull()
    expect(parseLive2dPath('/__cyrene-live2dx/haru/model3.json')).toBeNull() // 前缀需含尾斜杠，相邻前缀不误配
    expect(parseLive2dPath('')).toBeNull()
  })

  it('互斥：/__cyrene-media/... 不被 live2d parse（media 分支在前，parse 前缀不相交）', () => {
    expect(parseLive2dPath('/__cyrene-media/attachment/att_1')).toBeNull()
    expect(parseLive2dPath('/__cyrene-media/sticker/st_1')).toBeNull()
    expect(parseLive2dPath('/__cyrene-media/tts-live/live-1')).toBeNull()
  })
})