// @vitest-environment happy-dom
// tests/unit/cy-attachment-media.spec.ts
// CyAttachmentMedia：附件渲染链按 kind + playable 分发（image 内联 / video·audio 图标卡展开 / file 图标卡 / link 卡片），
// 非白名单 MIME 与未知 kind 降级为「暂不支持播放」文件卡；媒体元素 error → attachments:check 分类占位（元素与占位互斥），
// 分类 ok 但元素仍损坏时按「本机渲染失败」给出可重试占位；占位重试 ok → 换 nonce 重新挂载媒体元素。API 经 setDesktopApi mock。
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

  // 2026-09-10 复核更正：本用例初版标题为「以同一 URL 重新挂载媒体」，**该表述不准确**——
  // 实测（临时探针：error 前后 DOM 节点同一、src 不变、attachmentsCheck 调用次数恰等于手动触发次数）
  // 证明 mediaStatus 由 loading 变 ok 时两者同处媒体分支，子组件**不重挂载**，因此不存在自循环。
  // 真实缺陷是：元素已损坏却把状态置成 ok → 占位永不出现 → 用户面对静默损坏的媒体元素，
  // 既无解释也无法重试（附件其实完好，只是本机解不开：截断图片 / 不支持的容器）。
  // 2026-09-10 修复：ok 只表示「附件可用」，渲染失败由独立的 mediaRenderFailed 表达并渲染可重试占位。
  it('分类查询返回 ok 但元素已损坏时给出可重试的失败占位，而不是保留坏元素', async () => {
    attachmentsCheck.mockResolvedValueOnce({ status: 'ok' })
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png' })
    await wrapper.get('img.cy-attachment-image').trigger('error')
    await flushPromises()

    expect(attachmentsCheck).toHaveBeenCalledWith('att_1')
    // 附件本身可用，因此不谎报「附件不存在/已过期」，而是表达本机无法渲染
    expect(wrapper.get('.cy-placeholder').text()).toContain('无法显示该附件')
    expect(wrapper.get('.cy-placeholder-action').text()).toBe('重试')
    // 坏元素被卸载，不再残留
    expect(wrapper.find('img').exists()).toBe(false)
    wrapper.unmount()
  })

  it('渲染失败占位的重试会真正重新请求媒体（换 nonce），成功后才让位给媒体元素', async () => {
    attachmentsCheck.mockResolvedValueOnce({ status: 'ok' })
    const wrapper = mountMedia({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png' })
    await wrapper.get('img.cy-attachment-image').trigger('error')
    await flushPromises()
    expect(wrapper.get('.cy-placeholder').text()).toContain('无法显示该附件')

    // 重查仍 ok → 重挂载：nonce 递增、状态回 loading、占位让位给媒体元素
    attachmentsCheck.mockResolvedValueOnce({ status: 'ok' })
    await wrapper.get('.cy-placeholder-action').trigger('click')
    await flushPromises()
    const remounted = wrapper.get('img.cy-attachment-image')
    expect(remounted.attributes('src')).toBe(`${MEDIA_URL_BASE}/attachment/att_1?t=1`)
    expect(wrapper.find('.cy-placeholder').exists()).toBe(false)

    // 重新请求再次失败 → 仍回到渲染失败占位（不退化为静默坏元素）
    await remounted.trigger('error')
    await flushPromises()
    expect(wrapper.get('.cy-placeholder').text()).toContain('无法显示该附件')
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
