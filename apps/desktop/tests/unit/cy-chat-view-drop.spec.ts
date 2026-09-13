// @vitest-environment happy-dom
// tests/unit/cy-chat-view-drop.spec.ts
// docs/03 §8.3：拖拽进入**聊天区域**时显示覆盖式投放区；松开后只创建待发送附件条目，不得自动上传或发送。
//
// 本用例只覆盖**接线与状态机交互**（happy-dom 不做布局，几何归集成层 chat-drop-zone.spec.ts）：
//   ① 落区是聊天区根而不是输入条——拖到消息列表上也要出现投放区，且覆盖层不挂在 composer 内
//   ② 拖动非文件内容不触发
//   ③ 嵌套 dragenter/dragleave 按层配平（覆盖层不会因进入子元素而闪断）
//   ④ 松开后：附件入队 source='drag_drop'、覆盖层收起、**不发送也不上传**
//
// 注：子组件除 CyDropOverlay 外全 stub；刻意**不**关闭 VTU 对 <Transition> 的默认 stub——
// 真 Transition 的离场要等 transitionend，而 happy-dom 不派发过渡事件，元素会一直留在 DOM 里，
// 会把"已收起"误判成"仍在显示"（本轮实测踩到）。默认 stub 下 v-if=false 立即移出 DOM。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyChatView from '../../src/renderer/src/components/CyChatView.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useAttachmentStore } from '../../src/renderer/src/stores/attachment.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { createDesktopApiMock } from './helpers/desktop-api'

const mockApi = createDesktopApiMock()

const MOUNT_OPTIONS = {
  global: {
    stubs: { CyMessageList: true, CyChatInput: true, CyLiveToolCards: true, CyTtsPlayer: true },
  },
}

/** 构造带 dataTransfer 的拖拽事件（happy-dom 的 DragEvent/DataTransfer 形态不稳，显式注入最可靠） */
function dragEvent(type: string, opts: { files?: File[]; types?: string[] } = {}): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', {
    value: { types: opts.types ?? ['Files'], files: opts.files ?? [] },
  })
  return ev
}

function makeFile(name: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

function mountView(): ReturnType<typeof mount> {
  return mount(CyChatView, MOUNT_OPTIONS)
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(mockApi)
  vi.clearAllMocks()
  useConnectionStore().state = { status: 'connected', connectionId: 'cid-1' }
  useConversationStore().$patch({ currentId: 'conv-1', ready: true })
})

describe('CyChatView 拖拽落区（docs/03 §8.3）', () => {
  it('拖到**消息列表**上也出现投放区，且覆盖层挂在聊天区根（不在 composer 内）', async () => {
    const w = mountView()
    expect(w.find('.cy-chat cy-message-list-stub').exists()).toBe(true)

    w.find('cy-message-list-stub').element.dispatchEvent(dragEvent('dragenter'))
    await nextTick()

    const overlay = w.find('.cy-drop-overlay')
    expect(overlay.exists(), '拖到消息列表上必须出现投放区').toBe(true)
    // 覆盖层的容器是聊天区根，而不是 composer——这就是"覆盖整个聊天区域"与"只盖输入条"的区别
    expect(overlay.element.closest('cy-chat-input-stub'), '覆盖层不得挂在 composer 内').toBeNull()
    expect(overlay.element.closest('.cy-chat')).toBe(w.find('.cy-chat').element)

    // 输入区仍是有效落区（落区是超集而非替换）
    w.find('cy-chat-input-stub').element.dispatchEvent(dragEvent('dragenter'))
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists()).toBe(true)
  })

  it('拖动非文件内容（没有 Files 类型）不显示投放区', async () => {
    const w = mountView()
    w.find('.cy-chat').element.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }))
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists()).toBe(false)
  })

  it('嵌套 dragenter/dragleave 按层配平：进入子元素不会让投放区闪断，真正离开才收起', async () => {
    const w = mountView()
    const root = w.find('.cy-chat').element as HTMLElement
    const child = w.find('cy-message-list-stub').element as HTMLElement

    root.dispatchEvent(dragEvent('dragenter'))
    child.dispatchEvent(dragEvent('dragenter'))   // 进入子元素：又一层
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists()).toBe(true)

    child.dispatchEvent(dragEvent('dragleave'))    // 离开子元素：只减一层
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists(), '子元素的 dragleave 不得直接收起覆盖层').toBe(true)

    root.dispatchEvent(dragEvent('dragleave'))
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists()).toBe(false)
  })

  it('松开后只创建待发送附件（source=drag_drop）并收起覆盖层，不自动上传也不自动发送', async () => {
    const w = mountView()
    const store = useAttachmentStore()

    w.find('cy-message-list-stub').element.dispatchEvent(dragEvent('dragenter'))
    await nextTick()
    expect(w.find('.cy-drop-overlay').exists()).toBe(true)

    w.find('cy-message-list-stub').element.dispatchEvent(dragEvent('drop', { files: [makeFile('a.png'), makeFile('b.png')] }))
    await nextTick()

    expect(store.order.length).toBe(2)
    expect(store.items.map((i) => (i.kind === 'attachment' ? i.source : ''))).toEqual(['drag_drop', 'drag_drop'])
    expect(w.find('.cy-drop-overlay').exists()).toBe(false)
    // §8.3 红线：不得自动上传或发送（校验属附件状态机，不算上传）
    expect(mockApi.send).not.toHaveBeenCalled()
    expect(store.uploading).toBe(false)
  })
})
