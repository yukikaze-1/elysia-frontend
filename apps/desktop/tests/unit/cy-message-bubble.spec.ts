// @vitest-environment happy-dom
// tests/unit/cy-message-bubble.spec.ts —— UII-QQ 时间戳批次：气泡内时间戳。
// assistant 名称行轻头部一次 / user 气泡外右下一次；<time datetime>=原始 createdAt、title/aria=完整本地时间；
// 非法 createdAt 安全隐藏；流式→completed 时间不变；tool 占位无时间。
// 子组件 stub；组件用 host 本地时区格式化——断言与组件同源（同一 format* 函数 + 正则口径），
// 不依赖测试机时区/日期；时区精确转换由 message-time.spec 以显式 timeZone 锁定。
import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import type { Message } from '@shared/contracts'
import CyMessageBubble from '../../src/renderer/src/components/CyMessageBubble.vue'
import { formatFullTime, formatMessageTime } from '../../src/renderer/src/utils/message-time'

const CREATED_AT = '2026-08-30T01:42:17.000Z'

function baseMsg(partial: Partial<Message>): Message {
  return { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hello', status: 'completed', createdAt: CREATED_AT, ...partial }
}

function mountBubble(message: Message, props: Record<string, unknown> = {}) {
  return mount(CyMessageBubble, {
    props: { message, ...props },
    global: { stubs: { CyMarkdown: true, CyAttachmentMedia: true, CyToolCard: true } },
  })
}

describe('CyMessageBubble 时间戳（UII-QQ 时间戳批次）', () => {
  it('assistant：名称行轻头部显示一次 HH:mm；inner_voice + 多 public_reply segment 不重复时间', () => {
    const message = baseMsg({
      role: 'assistant',
      content: undefined,
      status: 'streaming',
      assistantSegments: [
        { segmentId: 'i1', segmentIndex: 0, channel: 'inner_voice', kind: 'text', text: 'think...', completed: true },
        { segmentId: 'p1', segmentIndex: 1, channel: 'public_reply', kind: 'text', text: '第一段', completed: true },
        { segmentId: 'p2', segmentIndex: 2, channel: 'public_reply', kind: 'markdown', text: '**第二段**', completed: true },
      ],
    })
    const w = mountBubble(message)
    const times = w.findAll('time')
    expect(times).toHaveLength(1)
    expect(times[0].text()).toBe(formatMessageTime(CREATED_AT))
    expect(times[0].text()).toMatch(/^\d{2}:\d{2}$/)
    expect(w.find('.cy-msg-name').text()).toContain('角色')
    // emotion/toolCalls 等其余区块不另带 time（整行恒 1 个 time 元素）
    w.unmount()
  })

  it('user：时间在内容上方头部行（.cy-user-msg-head）、气泡外部；内容之后无底部时间', () => {
    const w = mountBubble(baseMsg({}))
    const col = w.find('.cy-user-col')
    const head = w.find('.cy-user-msg-head')
    expect(head.exists()).toBe(true)
    // 头部行是 col 的首个子元素，位于正文气泡之前
    const children = Array.from(col.element.children)
    expect(children[0]).toBe(head.element)
    expect(children.indexOf(w.find('.cy-bubble').element)).toBeGreaterThan(0)
    // 全条消息仅一个 time（在头部行内），不入蓝色气泡
    const times = w.findAll('time')
    expect(times).toHaveLength(1)
    expect(times[0].element.parentElement).toBe(head.element)
    expect(w.find('.cy-bubble time').exists()).toBe(false)
    expect(head.text()).toBe(formatMessageTime(CREATED_AT))
    w.unmount()
  })

  it('user：贴图（stickerOnly）与附件消息同样使用顶部时间（一次，位于贴图/附件之前）', () => {
    const sticker = mountBubble(baseMsg({ content: undefined, stickerId: 'st1' }))
    expect(sticker.findAll('time')).toHaveLength(1)
    const sChildren = Array.from(sticker.find('.cy-user-col').element.children)
    expect(sChildren[0]).toBe(sticker.find('.cy-user-msg-head').element)   // 头部行在最前（贴图之前）
    sticker.unmount()
    const att = mountBubble(baseMsg({ content: undefined, attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png' }] }))
    expect(att.findAll('time')).toHaveLength(1)
    att.unmount()
  })

  // S7-C2（2026-09-15 评审）：`completing` = 「有缺口的不完整回复」。StreamAccumulator 明写
  // 「有缺口时进入 completing，不伪装完整」，但渲染层此前对它返回空串 ⇒ 截断的回复按完整回复渲染。
  // 判别力：去掉 terminalNote 里的 completing 分支 ⇒ 本条红。
  it('completing（有缺口的回复）显示"可能不完整"提示，不再伪装成完整回复', () => {
    const w = mountBubble(baseMsg({ status: 'completing', role: 'assistant', content: '被截断的正文' }))
    expect(w.find('.cy-status-note').exists()).toBe(true)
    expect(w.find('.cy-status-note').text()).toContain('不完整')
    w.unmount()
  })

  it('completed 不显示状态提示（正常回复不加噪音，与上面成对照）', () => {
    const w = mountBubble(baseMsg({ status: 'completed', role: 'assistant', content: '完整正文' }))
    expect(w.find('.cy-status-note').exists()).toBe(false)
    w.unmount()
  })

  it('user 发送失败：错误角标之外仍显示一次时间（顶部头部行）', () => {
    const w = mountBubble(baseMsg({ status: 'failed' }))
    expect(w.find('.cy-user-error-badge').exists()).toBe(true)
    expect(w.findAll('time')).toHaveLength(1)
    expect(w.find('.cy-user-msg-head').exists()).toBe(true)
    w.unmount()
  })

  it('<time datetime> 保留原始 createdAt；title/aria-label 为完整本地时间（YYYY年M月D日 HH:mm:ss）', () => {
    const w = mountBubble(baseMsg({}))
    const t = w.find('time')
    expect(t.attributes('datetime')).toBe(CREATED_AT)
    const full = formatFullTime(CREATED_AT)
    expect(t.attributes('title')).toBe(full)
    expect(t.attributes('aria-label')).toBe(full)
    expect(full).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}$/)
    w.unmount()
  })

  it('非法 createdAt：不抛错、不渲染 time（无 Invalid Date 文本）', () => {
    const w = mountBubble(baseMsg({ createdAt: 'not-a-date' }))
    expect(w.find('time').exists()).toBe(false)
    expect(w.find('.cy-user-col').text()).not.toContain('Invalid')
    w.unmount()
  })

  it('流式 → completed：时间文本保持不变（同一 createdAt，不随状态跳动）', async () => {
    const message = reactive(baseMsg({
      role: 'assistant',
      content: undefined,
      status: 'streaming',
      assistantSegments: [{ segmentId: 'p1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '回复中', completed: false }],
    }))
    const w = mountBubble(message)
    const before = w.find('time').text()
    message.status = 'completed'   // 就地变异（同真实 store 语义）：props 对象引用不变
    await w.vm.$nextTick()
    expect(w.find('time').text()).toBe(before)
    w.unmount()
  })

  it('tool 占位消息：不渲染时间', () => {
    const w = mountBubble(baseMsg({ role: 'tool', content: undefined }))
    expect(w.find('time').exists()).toBe(false)
    w.unmount()
  })

  it('assistant：优先使用消息自身角色快照，并把身份放进头像 title/aria-label', () => {
    const w = mountBubble(baseMsg({
      role: 'assistant',
      content: undefined,
      character: {
        characterId: 'custom/elysia',
        characterInstanceId: 'instance-elysia-v2',
        characterRevision: 2,
        displayName: 'Elysia',
        presentation: { themeColor: '#88aaff' }
      },
      assistantSegments: [{ segmentId: 'p1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi', completed: true }]
    }))
    expect(w.find('.cy-msg-name').text()).toContain('Elysia')
    const avatar = w.find('.cy-avatar-assistant')
    expect(avatar.text()).toBe('E')
    expect(avatar.attributes('aria-label')).toBe('Elysia')
    expect(avatar.attributes('title')).toBe('Elysia')
    w.unmount()
  })

  it('assistant：缺显示名时只接受 exact revision cache，不能用不同 revision 的当前目录身份', () => {
    const message = baseMsg({
      role: 'assistant',
      content: undefined,
      character: { characterId: 'custom/a', characterInstanceId: 'inst-a', characterRevision: 3 },
      assistantSegments: []
    })
    const exact = mount(CyMessageBubble, {
      props: {
        message,
        revisionIdentity: { characterId: 'custom/a', characterRevision: 3, displayName: '旧版本 A', presentation: {} },
        characterBinding: { characterId: 'custom/a', characterInstanceId: 'inst-a', characterRevision: 4, displayName: '当前版本 A', presentation: {} }
      },
      global: { stubs: { CyMarkdown: true, CyAttachmentMedia: true, CyToolCard: true } }
    })
    expect(exact.find('.cy-msg-name').text()).toContain('旧版本 A')
    exact.unmount()

    const mismatched = mount(CyMessageBubble, {
      props: {
        message,
        revisionIdentity: { characterId: 'custom/a', characterRevision: 2, displayName: '错误版本', presentation: {} },
        characterBinding: { characterId: 'custom/a', characterInstanceId: 'inst-a', characterRevision: 4, displayName: '当前版本 A', presentation: {} }
      },
      global: { stubs: { CyMarkdown: true, CyAttachmentMedia: true, CyToolCard: true } }
    })
    expect(mismatched.find('.cy-msg-name').text()).toContain('角色')
    mismatched.unmount()
  })

  it('user：视觉仍显示“我”，但 aria/title 使用身份档案显示名', () => {
    const w = mount(CyMessageBubble, { props: { message: baseMsg({}), userDisplayName: 'Yomu' } })
    const avatar = w.find('.cy-avatar-user')
    expect(avatar.text()).toBe('我')
    expect(avatar.attributes('role')).toBe('img')
    expect(avatar.attributes('aria-label')).toBe('Yomu')
    expect(avatar.attributes('title')).toBe('Yomu')
    w.unmount()
  })
})

// —— H-02（2026-09-11）：消息级复制。此前 `body { user-select: none }` + 无操作行 + 无右键菜单，
// 「复制回答」三条路全断。此处确定性覆盖「复制什么内容」与「是否真的调用了剪贴板」。 ——
describe('CyMessageBubble 复制按钮（H-02）', () => {
  async function mountWithClipboard(message: Message) {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountBubble(message)
    return { w, writeText }
  }

  it('assistant：复制 public_reply 正文，且**不含**内心独白与工具元数据', async () => {
    const { w, writeText } = await mountWithClipboard(baseMsg({
      role: 'assistant',
      content: undefined,
      assistantSegments: [
        { segmentId: 'i1', segmentIndex: 0, channel: 'inner_voice', kind: 'text', text: '内心独白不该被复制', completed: true },
        { segmentId: 'p1', segmentIndex: 1, channel: 'public_reply', kind: 'text', text: '第一段回答', completed: true },
        { segmentId: 'p2', segmentIndex: 2, channel: 'public_reply', kind: 'markdown', text: '第二段回答', completed: true }
      ]
    }))
    await w.find('[data-testid="message-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('第一段回答')
    expect(copied).toContain('第二段回答')
    expect(copied, '内心独白不是「回答」本身，不应外带').not.toContain('内心独白不该被复制')
    w.unmount()
  })

  it('user：复制自己的消息正文', async () => {
    const { w, writeText } = await mountWithClipboard(baseMsg({ role: 'user', content: '我的问题' }))
    await w.find('[data-testid="message-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('我的问题')
    w.unmount()
  })

  it('复制成功后按钮切到「已复制」，1.5s 后复位', async () => {
    vi.useFakeTimers()
    const { w } = await mountWithClipboard(baseMsg({ role: 'user', content: 'x' }))
    const btn = w.find('[data-testid="message-copy"]')
    expect(btn.text()).toBe('复制')
    await btn.trigger('click')
    await nextTick()
    expect(btn.text()).toBe('已复制')
    vi.advanceTimersByTime(1500)
    await nextTick()
    expect(btn.text()).toBe('复制')
    w.unmount()
    vi.useRealTimers()
  })

  it('无可复制正文（如纯 tool 消息）→ 不渲染复制按钮', () => {
    const w = mountBubble(baseMsg({ role: 'tool', content: undefined }))
    expect(w.find('[data-testid="message-copy"]').exists()).toBe(false)
    w.unmount()
  })
})

// —— doc 03 §7.5（2026-09-13）：消息操作行补「重新发送」/「重新生成」——
// 本组件只负责**可用性与事件**（动作本身由 CyMessageList 调 store；理由见组件内注释）。
describe('CyMessageBubble 重发/重新生成入口（doc 03 §7.5）', () => {
  it('user 消息：复制 + 重新发送；不带重新生成', () => {
    const w = mountBubble(baseMsg({ role: 'user', content: '我的问题' }))
    expect(w.find('[data-testid="message-copy"]').exists()).toBe(true)
    expect(w.find('[data-testid="message-resend"]').exists()).toBe(true)
    expect(w.find('[data-testid="message-regenerate"]').exists(), '重新生成只属于助手回复').toBe(false)
    w.unmount()
  })

  it('assistant 消息：复制 + 重新生成；不带重新发送', () => {
    const w = mountBubble(baseMsg({ role: 'assistant', content: undefined, assistantSegments: [{ segmentId: 'p1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '回答', completed: true }] }))
    expect(w.find('[data-testid="message-copy"]').exists()).toBe(true)
    expect(w.find('[data-testid="message-regenerate"]').exists()).toBe(true)
    expect(w.find('[data-testid="message-resend"]').exists()).toBe(false)
    w.unmount()
  })

  it('点击各发各的事件，且带本条 messageId（父层据此定位）', async () => {
    const user = mountBubble(baseMsg({ role: 'user', content: 'x', messageId: 'u-42' }))
    await user.find('[data-testid="message-resend"]').trigger('click')
    expect(user.emitted('resend')).toEqual([['u-42']])
    user.unmount()

    const assistant = mountBubble(baseMsg({ role: 'assistant', content: undefined, messageId: 'a-42', assistantSegments: [{ segmentId: 'p1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '答', completed: true }] }))
    await assistant.find('[data-testid="message-regenerate"]').trigger('click')
    expect(assistant.emitted('regenerate')).toEqual([['a-42']])
    assistant.unmount()
  })

  it('生成中（busy）：两个动作都禁用并给出原因（不做静默 no-op）', () => {
    const w = mountBubble(baseMsg({ role: 'user', content: 'x' }), { busy: true })
    const btn = w.find('[data-testid="message-resend"]').element as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('生成中')
    // 复制不受 busy 影响（它不触碰生成链）
    expect((w.find('[data-testid="message-copy"]').element as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })

  it('带附件或贴图的用户消息不提供重新发送（重发要重走上传/贴图校验，属独立范围）', () => {
    const withAttachment = mountBubble(baseMsg({ role: 'user', content: 'x', attachments: [{ attachmentId: 'att-1', kind: 'image', mediaType: 'image/png' }] }))
    expect(withAttachment.find('[data-testid="message-resend"]').exists()).toBe(false)
    withAttachment.unmount()

    const withSticker = mountBubble(baseMsg({ role: 'user', content: '', stickerId: 'st-1' }))
    expect(withSticker.find('[data-testid="message-resend"]').exists()).toBe(false)
    withSticker.unmount()
  })
})
