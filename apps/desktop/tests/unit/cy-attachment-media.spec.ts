// @vitest-environment happy-dom
// tests/unit/cy-attachment-media.spec.ts
// CyAttachmentMedia：附件渲染链按 kind + playable 分发（image 内联 / video·audio 图标卡展开 / file 图标卡 / link 卡片），
// 非白名单 MIME 与未知 kind 降级为「暂不支持播放」文件卡；媒体元素 error → attachments:check 分类占位（元素与占位互斥），
// 占位重试 ok → 换 nonce 重新挂载媒体元素。API 经 setDesktopApi mock。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AttachmentCheckResult } from '@shared/contracts'
import CyAttachmentMedia from '../../src/renderer/src/components/CyAttachmentMedia.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { MEDIA_URL_BASE } from '../../src/renderer/src/utils/media-url'

let attachmentsCheck: ReturnType<typeof vi.fn>

beforeEach(() => {
  attachmentsCheck = vi.fn(async (): Promise<AttachmentCheckResult> => ({ status: 'ok' }))
  setDesktopApi({ attachmentsCheck } as never)
})

// tsconfig.node 下 .vue 为 ambient shim（DefineComponent<object, object, unknown>），`$props` 解析为 {}
// 因而每个调用点都会因未知属性报错——按仓库先例（cy-tool-approval.spec「断言为 never」）在 helper 一处放宽。
function mountMedia(props: Record<string, unknown>) {
  return mount(CyAttachmentMedia, { props: props as never })
}

describe('CyAttachmentMedia 附件分发', () => {
  it('image 内联预览：src 为同源媒体协议、alt 取名称并回退占位，缺 attachmentId 不渲染元素', () => {
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: '图片.png' })
    const img = wrapper.get('img.cy-attachment-image')
    // retryNonce 从 0 起且始终显式传入，因此首帧 URL 自带 ?t=0（重试后递增换 URL）
    expect(img.attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_1?t=0`)
    expect(img.attributes('alt')).toBe('图片.png')
    expect(wrapper.find('.cy-file-card').exists()).toBe(false)
    wrapper.unmount()

    const unnamed = mountMedia({ kind: 'image', attachmentId: 'att_2' })
    expect(unnamed.get('img').attributes('alt')).toBe('附件图片')
    unnamed.unmount()

    const withoutId = mountMedia({ kind: 'image', mediaType: 'image/png' })
    expect(withoutId.find('img').exists()).toBe(false)
    expect(withoutId.find('.cy-placeholder').exists()).toBe(false)
    withoutId.unmount()
  })

  it('video/audio 只有白名单 MIME 才渲染图标卡并在点击后展开播放器，非白名单降级文件卡', async () => {
    const video = mountMedia({ kind: 'video', attachmentId: 'att_v', mediaType: 'video/mp4', name: '片段.mp4', size: 3 * 1024 * 1024 })
    expect(video.get('.cy-media-card').attributes('aria-label')).toBe('播放视频 片段.mp4')
    expect(video.get('.cy-media-card').text()).toContain('片段.mp4 · 3.0 MB')
    expect(video.get('.cy-media-card').text()).toContain('点击播放')
    expect(video.find('video').exists()).toBe(false)
    await video.get('.cy-media-card').trigger('click')
    const videoElement = video.get('video.cy-media-video')
    expect(videoElement.attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_v?t=0`)
    expect(videoElement.attributes('controls')).toBeDefined()
    video.unmount()

    const audio = mountMedia({ kind: 'audio', attachmentId: 'att_a', mediaType: 'audio/ogg', name: '录音.ogg' })
    expect(audio.get('.cy-media-card').attributes('aria-label')).toBe('播放音频 录音.ogg')
    await audio.get('.cy-media-card').trigger('click')
    expect(audio.get('audio.cy-media-audio').attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_a?t=0`)
    audio.unmount()

    // 非白名单 MIME：仅文件卡，不给播放入口
    const unsupported = mountMedia({ kind: 'video', attachmentId: 'att_x', mediaType: 'video/x-matroska', name: '电影.mkv' })
    expect(unsupported.find('.cy-media-card').exists()).toBe(false)
    expect(unsupported.get('.cy-file-card').text()).toContain('电影.mkv')
    expect(unsupported.get('.cy-file-card').text()).toContain('此格式暂不支持播放')
    unsupported.unmount()

    const unsupportedAudio = mountMedia({ kind: 'audio', attachmentId: 'att_y', mediaType: 'audio/aac' })
    expect(unsupportedAudio.get('.cy-file-card').text()).toContain('此格式暂不支持播放')
    unsupportedAudio.unmount()

    // mediaType 未知（空串）时不误判为「不支持播放」
    const unknownMime = mountMedia({ kind: 'video', attachmentId: 'att_z', mediaType: '', name: '未知格式' })
    expect(unknownMime.find('.cy-media-card').exists()).toBe(true)
    expect(unknownMime.find('.cy-file-card').exists()).toBe(false)
    unknownMime.unmount()
  })

  it('file 与 link 各自渲染卡片，链接只在 http/https 时成为可点击外链', () => {
    const file = mountMedia({ kind: 'file', name: '报告.pdf', size: 2048, mediaType: 'application/pdf' })
    expect(file.get('.cy-file-card').attributes('title')).toBe('application/pdf')
    expect(file.get('.cy-file-card').text()).toContain('报告.pdf · 2.0 KB')
    expect(file.find('.cy-file-note').exists()).toBe(false)
    file.unmount()

    const link = mountMedia({ kind: 'link', url: 'https://example.com/doc', name: '示例链接' })
    const anchor = link.get('a.cy-link-card')
    expect(anchor.attributes('href')).toBe('https://example.com/doc')
    expect(anchor.attributes('target')).toBe('_blank')
    expect(anchor.attributes('rel')).toBe('noopener noreferrer')
    expect(anchor.text()).toContain('示例链接')
    expect(anchor.text()).toContain('https://example.com/doc')
    link.unmount()
  })

  it('媒体元素 error 后按 attachmentsCheck 结果分类：过期返回刷新入口且媒体元素被卸载', async () => {
    attachmentsCheck.mockResolvedValueOnce({ status: 'expired' })
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: '旧图片.png' })
    await wrapper.get('img.cy-attachment-image').trigger('error')
    await flushPromises()

    expect(attachmentsCheck).toHaveBeenCalledWith('att_1')
    // P2-8：占位与媒体元素互斥，出错即卸载，避免坏图残留在 DOM
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.cy-placeholder').attributes('role')).toBe('status')
    expect(wrapper.get('.cy-placeholder').text()).toContain('附件已过期')
    expect(wrapper.get('.cy-placeholder-action').text()).toBe('刷新')
    wrapper.unmount()
  })

  it('分类查询自身失败时降级为「加载失败」重试态', async () => {
    attachmentsCheck.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] 检查接口不可用'))
    const wrapper = mountMedia({ kind: 'video', attachmentId: 'att_v', mediaType: 'video/mp4', name: '片段.mp4' })
    await wrapper.get('.cy-media-card').trigger('click')
    await wrapper.get('video').trigger('error')
    await flushPromises()

    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.get('.cy-placeholder').text()).toContain('加载失败')
    expect(wrapper.get('.cy-placeholder-action').text()).toBe('重试')
    wrapper.unmount()
  })

  // pinning existing behavior：媒体元素 error 后若 attachmentsCheck 直接返回 ok，组件把 mediaStatus 置回 ok，
  // 但 nonce 不变，即用同一个 URL 立刻重新挂载媒体（与占位重试路径的 ?t=+1 不同）。
  // 若该 URL 本身持续失败，会形成 error→check→ok→重挂载 的循环；此处只锁定现状，不视为期望语义。
  it('（锁定现状）媒体 error 但分类查询返回 ok 时以同一 URL 重新挂载媒体', async () => {
    attachmentsCheck.mockResolvedValueOnce({ status: 'ok' })
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png' })
    await wrapper.get('img.cy-attachment-image').trigger('error')
    await flushPromises()

    expect(attachmentsCheck).toHaveBeenCalledWith('att_1')
    expect(wrapper.find('.cy-placeholder').exists()).toBe(false)
    expect(wrapper.get('img.cy-attachment-image').attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_1?t=0`)
    wrapper.unmount()
  })

  it('占位重试重查 ok 时换 nonce 重新挂载媒体，仍失败则更新为最新状态文案', async () => {
    attachmentsCheck.mockResolvedValueOnce({ status: 'error' })
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: '图片.png' })
    await wrapper.get('img').trigger('error')
    await flushPromises()
    expect(wrapper.get('.cy-placeholder').text()).toContain('加载失败')

    attachmentsCheck.mockResolvedValueOnce({ status: 'ok' })
    await wrapper.get('.cy-placeholder-action').trigger('click')
    await flushPromises()
    const remounted = wrapper.get('img.cy-attachment-image')
    expect(remounted.attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_1?t=1`)
    expect(wrapper.find('.cy-placeholder').exists()).toBe(false)

    attachmentsCheck.mockResolvedValueOnce({ status: 'revoked' })
    await remounted.trigger('error')
    await flushPromises()
    expect(wrapper.get('.cy-placeholder').text()).toContain('附件已撤销')
    expect(wrapper.find('.cy-placeholder-action').exists()).toBe(false)
    wrapper.unmount()
  })
})
