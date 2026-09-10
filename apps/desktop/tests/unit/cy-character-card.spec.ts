// @vitest-environment happy-dom
// tests/unit/cy-character-card.spec.ts
// CyCharacterCard：目录卡片的摘要呈现（首字符头像 + 主题色、来源/归档/默认徽标、revision、
// 简介占位）与 select emit 契约（只上抛 characterId，不携带 authored 内容）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { CharacterSummary } from '@shared/contracts'
import CyCharacterCard from '../../src/renderer/src/components/characters/CyCharacterCard.vue'

function summaryFixture(patch: Partial<CharacterSummary> = {}): CharacterSummary {
  return {
    characterId: 'custom/test',
    source: 'custom',
    mutable: true,
    status: 'active',
    currentRevision: 4,
    displayName: '测试角色',
    description: '简介文本',
    aliases: [],
    presentation: {},
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...patch
  }
}

function mountCard(character: CharacterSummary, defaultCharacterId?: string) {
  return mount(CyCharacterCard, { props: { character, defaultCharacterId } })
}

describe('CyCharacterCard 角色卡片', () => {
  it('头像取名称首字符并应用主题色，无名称时回退「角」；简介与 revision 使用占位值', () => {
    const wrapper = mountCard(summaryFixture({ displayName: 'Elysia', presentation: { themeColor: '#8db7f2' } }))
    expect(wrapper.get('.cy-character-avatar').text()).toBe('E')
    expect(wrapper.get('.cy-character-avatar').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.cy-character-avatar').attributes('style')).toContain('background-color: #8db7f2')
    expect(wrapper.get('footer span').text()).toBe('revision 4')
    expect(wrapper.get('p').text()).toBe('简介文本')
    wrapper.unmount()

    const fallback = mountCard(summaryFixture({ displayName: '   ', description: '' }))
    expect(fallback.get('.cy-character-avatar').text()).toBe('角')
    expect(fallback.get('.cy-character-avatar').attributes('style')).toBeUndefined()
    expect(fallback.get('p').text()).toBe('暂无简介')
    fallback.unmount()
  })

  it('来源/归档/默认徽标按 summary 与默认角色 ID 精确出现，点击按钮只 emit characterId', async () => {
    const builtin = mountCard(summaryFixture({ source: 'builtin', mutable: false }))
    const builtinBadges = builtin.findAll('.cy-badge').map((badge) => badge.text())
    expect(builtinBadges).toEqual(['内置'])
    builtin.unmount()

    const archived = mountCard(summaryFixture({ status: 'archived' }), 'custom/test')
    const archivedBadges = archived.findAll('.cy-badge').map((badge) => badge.text())
    expect(archivedBadges).toEqual(['默认', '自定义', '已归档'])
    expect(archived.get('.cy-badge.archived').text()).toBe('已归档')

    const other = mountCard(summaryFixture(), 'custom/other')
    expect(other.findAll('.cy-badge').map((badge) => badge.text())).toEqual(['自定义'])

    const button = other.get('footer button')
    expect(button.attributes('aria-label')).toBe('查看 测试角色 详情')
    expect(button.text()).toBe('查看详情')
    await button.trigger('click')
    expect(other.emitted('select')).toEqual([['custom/test']])
    expect(other.attributes('data-character-id')).toBe('custom/test')
  })
})
