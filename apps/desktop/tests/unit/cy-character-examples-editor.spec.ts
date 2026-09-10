// @vitest-environment happy-dom
// tests/unit/cy-character-examples-editor.spec.ts
// CyCharacterExamplesEditor：示例对话（authored 内容）的纯 emit 契约——新增/删除/排序/编辑都以
// 克隆后的新数组 emit（绝不原地改 props），上限 20 组，并在新增/移动后把焦点请求交给父组件。
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { CharacterExample } from '@shared/contracts'
import CyCharacterExamplesEditor from '../../src/renderer/src/components/characters/CyCharacterExamplesEditor.vue'

function examples(...items: Array<[string, string]>): CharacterExample[] {
  return items.map(([user, assistant]) => ({ user, assistant }))
}

function mountEditor(value: CharacterExample[]) {
  return mount(CyCharacterExamplesEditor, { props: { examples: value } as never })
}

function updates(wrapper: ReturnType<typeof mountEditor>): CharacterExample[][] {
  return wrapper.emitted('update')!.map((event) => event[0] as CharacterExample[])
}

describe('CyCharacterExamplesEditor 示例对话编辑', () => {
  it('空态提示与计数，新增示例以克隆数组 emit，并在微任务后请求聚焦新条目', async () => {
    const wrapper = mountEditor(examples(['你好', '你也好']))
    expect(wrapper.find('.cy-empty-example').exists()).toBe(false)
    expect(wrapper.get('.cy-examples-footer span').text()).toBe('1/20')

    await wrapper.findAll('button').find((button) => button.text() === '添加示例')!.trigger('click')
    await flushPromises()
    expect(updates(wrapper)).toEqual([[{ user: '你好', assistant: '你也好' }, { user: '', assistant: '' }]])
    expect(wrapper.emitted('focus')![0]).toEqual([1, 'user'])
    // 不原地修改 props（父组件才是 draft 的唯一写入方）
    expect(wrapper.props('examples' as never)).toHaveLength(1)
    wrapper.unmount()

    const empty = mountEditor([])
    expect(empty.get('.cy-empty-example').text()).toBe('还没有示例对话。')
    expect(empty.get('.cy-examples-footer span').text()).toBe('0/20')
    empty.unmount()
  })

  it('达到 20 组上限后禁用添加且不再产生更新', async () => {
    const wrapper = mountEditor(examples(...Array.from({ length: 20 }, (_, index) => [`用户${index}`, `角色${index}`] as [string, string])))
    expect(wrapper.get('.cy-examples-footer span').text()).toBe('20/20')
    const addButton = wrapper.findAll('button').find((button) => button.text() === '添加示例')!
    expect(addButton.attributes('disabled')).toBeDefined()
    await addButton.trigger('click')
    expect(wrapper.emitted('update')).toBeUndefined()
    wrapper.unmount()
  })

  it('编辑单个示例只替换该条目，其余条目保持原值（受控组件：以 props 为唯一事实源）', async () => {
    const wrapper = mountEditor(examples(['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']))
    await wrapper.get('#character-example-1-user').setValue('b1-改')
    expect(updates(wrapper).at(-1)).toEqual([
      { user: 'a1', assistant: 'a2' },
      { user: 'b1-改', assistant: 'b2' },
      { user: 'c1', assistant: 'c2' }
    ])
    // 模拟父组件把 emit 结果回填成新 props 后再编辑另一字段：先前修改必须保留
    await wrapper.setProps({ examples: updates(wrapper).at(-1)! } as never)
    await wrapper.get('#character-example-1-assistant').setValue('b2-改')
    expect(updates(wrapper).at(-1)).toEqual([
      { user: 'a1', assistant: 'a2' },
      { user: 'b1-改', assistant: 'b2-改' },
      { user: 'c1', assistant: 'c2' }
    ])

    await wrapper.get('#character-example-2-user').trigger('focus')
    expect(wrapper.emitted('focus')!.at(-1)).toEqual([2, 'user'])
    wrapper.unmount()
  })

  it('删除指定示例按下标移除，删除按钮带无障碍标签', async () => {
    const wrapper = mountEditor(examples(['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']))
    const removeButton = wrapper.get('[aria-label="删除示例 2"]')
    expect(removeButton.text()).toBe('删除')
    await removeButton.trigger('click')
    expect(updates(wrapper)).toEqual([[
      { user: 'a1', assistant: 'a2' },
      { user: 'c1', assistant: 'c2' }
    ]])
    wrapper.unmount()
  })

  it('上下移动重排顺序并请求聚焦目标位置，首尾方向按钮禁用', async () => {
    const wrapper = mountEditor(examples(['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']))
    expect(wrapper.get('[aria-label="示例 1 上移"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="示例 3 下移"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="示例 1 下移"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[aria-label="示例 1 下移"]').trigger('click')
    await flushPromises()
    expect(updates(wrapper).at(-1)).toEqual([
      { user: 'b1', assistant: 'b2' },
      { user: 'a1', assistant: 'a2' },
      { user: 'c1', assistant: 'c2' }
    ])
    expect(wrapper.emitted('focus')!.at(-1)).toEqual([1, 'user'])

    // 父组件回填第一次重排结果后再上移最后一项
    await wrapper.setProps({ examples: updates(wrapper).at(-1)! } as never)
    await wrapper.get('[aria-label="示例 3 上移"]').trigger('click')
    await flushPromises()
    expect(updates(wrapper).at(-1)).toEqual([
      { user: 'b1', assistant: 'b2' },
      { user: 'c1', assistant: 'c2' },
      { user: 'a1', assistant: 'a2' }
    ])
    expect(wrapper.emitted('focus')!.at(-1)).toEqual([1, 'user'])
    wrapper.unmount()
  })
})
