// @vitest-environment happy-dom
// tests/unit/cy-attachment-placeholder.spec.ts
// CyAttachmentPlaceholder：spec §4.7 状态占位文案表、expired/error 才给「刷新/重试」、
// 无 attachmentId 时不得发起查询、重试结果原样 emit 给父组件（ok → 重挂载；失败 → 降级 error）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { AttachmentCheckResult, AttachmentMediaStatus } from '@shared/contracts'
import CyAttachmentPlaceholder from '../../src/renderer/src/components/CyAttachmentPlaceholder.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

let attachmentsCheck: ReturnType<typeof vi.fn>

beforeEach(() => {
  attachmentsCheck = vi.fn(async (): Promise<AttachmentCheckResult> => ({ status: 'ok' }))
  setDesktopApi({ attachmentsCheck } as never)
})

function mountPlaceholder(props: { status?: AttachmentMediaStatus; attachmentId?: string }) {
  return mount(CyAttachmentPlaceholder, { props })
}

describe('CyAttachmentPlaceholder 附件状态占位', () => {
  it('每个非 ok 状态显示对应文案，ok/缺省状态不渲染占位', () => {
    const expected: Array<[AttachmentMediaStatus, string]> = [
      ['expired', '附件已过期'],
      ['not_found', '附件不存在'],
      ['revoked', '附件已撤销'],
      ['error', '加载失败']
    ]
    for (const [status, text] of expected) {
      const wrapper = mountPlaceholder({ status, attachmentId: 'att_1' })
      expect(wrapper.get('.cy-placeholder').attributes('role')).toBe('status')
      expect(wrapper.get('.cy-placeholder span').text()).toBe(text)
      wrapper.unmount()
    }

    const ok = mountPlaceholder({ status: 'ok', attachmentId: 'att_1' })
    expect(ok.find('.cy-placeholder').exists()).toBe(false)
    ok.unmount()

    const empty = mountPlaceholder({})
    expect(empty.find('.cy-placeholder').exists()).toBe(false)
    empty.unmount()
  })

  it('只有 error/expired 提供重试入口，not_found/revoked 不可重试', () => {
    const expired = mountPlaceholder({ status: 'expired', attachmentId: 'att_1' })
    expect(expired.get('.cy-placeholder-action').text()).toBe('刷新')
    expired.unmount()

    const error = mountPlaceholder({ status: 'error', attachmentId: 'att_1' })
    expect(error.get('.cy-placeholder-action').text()).toBe('重试')
    error.unmount()

    for (const status of ['not_found', 'revoked'] as AttachmentMediaStatus[]) {
      const wrapper = mountPlaceholder({ status, attachmentId: 'att_1' })
      expect(wrapper.find('.cy-placeholder-action').exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('缺少 attachmentId 时点击不查询也不 emit', async () => {
    const wrapper = mountPlaceholder({ status: 'error' })
    expect(wrapper.find('.cy-placeholder-action').exists()).toBe(true)
    await wrapper.get('.cy-placeholder-action').trigger('click')
    await flushPromises()
    expect(attachmentsCheck).not.toHaveBeenCalled()
    expect(wrapper.emitted('retry')).toBeUndefined()
    wrapper.unmount()
  })

  it('重试期间按钮禁用防重复请求，成功后把查询结果 emit 给父组件', async () => {
    let resolveCheck!: (value: AttachmentCheckResult) => void
    attachmentsCheck.mockImplementationOnce(() => new Promise<AttachmentCheckResult>((resolve) => { resolveCheck = resolve }))
    const wrapper = mountPlaceholder({ status: 'expired', attachmentId: 'att_1' })
    await wrapper.get('.cy-placeholder-action').trigger('click')
    await wrapper.vm.$nextTick()

    expect(attachmentsCheck).toHaveBeenCalledWith('att_1')
    const button = wrapper.get('.cy-placeholder-action')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(attachmentsCheck).toHaveBeenCalledTimes(1)

    resolveCheck({ status: 'ok' })
    await flushPromises()
    expect(wrapper.emitted('retry')).toEqual([[{ status: 'ok' }]])
    expect(wrapper.get('.cy-placeholder-action').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('查询抛错时 emit 可解释的降级结果而不是让占位卡死', async () => {
    attachmentsCheck.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] 检查失败'))
    const wrapper = mountPlaceholder({ status: 'error', attachmentId: 'att_1' })
    await wrapper.get('.cy-placeholder-action').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('retry')).toEqual([[{ status: 'error', reason: 'check_failed' }]])
    expect(wrapper.get('.cy-placeholder-action').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})
