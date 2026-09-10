// @vitest-environment happy-dom
// tests/unit/cy-link-attachment.spec.ts
// CyLinkAttachment：链接卡片只在 http/https 时渲染为可点击外链（target=_blank + rel=noopener noreferrer，
// 交由既有 will-navigate/setWindowOpenHandler → shell.openExternal）；其余协议（javascript:/data:/mailto:/相对路径）
// 一律降级为纯文本卡片，不产生可点击的 href。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CyLinkAttachment from '../../src/renderer/src/components/CyLinkAttachment.vue'

function mountLink(url?: string, name?: string) {
  return mount(CyLinkAttachment, { props: { url, name } })
}

describe('CyLinkAttachment 链接卡片', () => {
  it('http/https 渲染新窗口外链并带 rel 保护，标签回退为 URL', () => {
    const wrapper = mountLink('https://example.com/doc', '示例链接')
    const anchor = wrapper.get('a.cy-link-card')
    expect(anchor.attributes('href')).toBe('https://example.com/doc')
    expect(anchor.attributes('target')).toBe('_blank')
    expect(anchor.attributes('rel')).toBe('noopener noreferrer')
    expect(anchor.get('.cy-link-label').text()).toBe('示例链接')
    expect(anchor.get('.cy-link-url').text()).toBe('https://example.com/doc')
    wrapper.unmount()

    const labeled = mountLink('http://example.com/plain')
    const fallback = labeled.get('a.cy-link-card')
    expect(fallback.get('.cy-link-label').text()).toBe('http://example.com/plain')
    labeled.unmount()
  })

  it('非 http/https 或缺失 URL 时只渲染纯文本卡片，不产生可点击链接', () => {
    const cases: Array<[string | undefined, string]> = [
      ['javascript:alert(1)', '危险脚本'],
      ['data:text/html,<script>alert(1)</script>', '内联数据'],
      ['mailto:someone@example.com', '邮件'],
      ['file:///C:/secret.txt', '本地文件'],
      ['/relative/path', '相对路径'],
      [undefined, '无地址']
    ]
    for (const [url, name] of cases) {
      const wrapper = mountLink(url, name)
      expect(wrapper.find('a').exists()).toBe(false)
      const card = wrapper.get('div.cy-link-card')
      expect(card.get('.cy-link-label').text()).toBe(name)
      wrapper.unmount()
    }

    const unnamed = mountLink('javascript:void(0)')
    expect(unnamed.get('.cy-link-label').text()).toBe('链接')
    unnamed.unmount()
  })
})
