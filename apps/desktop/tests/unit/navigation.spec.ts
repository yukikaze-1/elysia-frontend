// apps/desktop/tests/unit/navigation.spec.ts
import { describe, expect, it } from 'vitest'
import { classifyNavigation, sameOrigin } from '../../src/main/windows/navigation'

const dev = new URL('http://localhost:5173')

describe('sameOrigin', () => {
  it('protocol+host（含端口）相等 → true', () => {
    expect(sameOrigin(new URL('http://localhost:5173/x'), dev)).toBe(true)
  })
  it('端口不同 → false', () => {
    expect(sameOrigin(new URL('http://localhost:5174/x'), dev)).toBe(false)
  })
})

describe('classifyNavigation', () => {
  it('非 dev server：cyrene://renderer/* → app', () => {
    expect(classifyNavigation('cyrene://renderer/index.html', undefined, false)).toBe('app')
    expect(classifyNavigation('cyrene://renderer/assets/app.js', undefined, false)).toBe('app')
  })
  it('非 dev server：cyrene 但 host 错 → deny', () => {
    expect(classifyNavigation('cyrene://evil/index.html', undefined, false)).toBe('deny')
  })
  it('非 dev server：file:/其他 → deny（file: 不再放行）', () => {
    expect(classifyNavigation('file:///etc/passwd', undefined, false)).toBe('deny')
    expect(classifyNavigation('javascript:alert(1)', undefined, false)).toBe('deny')
  })
  it('非 dev server：外部 http/https → external', () => {
    expect(classifyNavigation('https://example.com/x', undefined, false)).toBe('external')
  })
  it('dev server 同源非 @fs/@vite → app', () => {
    expect(classifyNavigation('http://localhost:5173/src/App.vue', dev, true)).toBe('app')
  })
  it('dev server 同源 @fs/@vite 前缀 → deny（不开外部浏览器）；%40fs 编码绕过也 deny', () => {
    expect(classifyNavigation('http://localhost:5173/@fs/home/user/secret', dev, true)).toBe('deny')
    expect(classifyNavigation('http://localhost:5173/@vite/client', dev, true)).toBe('deny')
    expect(classifyNavigation('http://localhost:5173/%40fs/home/user/secret', dev, true)).toBe('deny')
  })
  it('dev server 跨源 http → external', () => {
    expect(classifyNavigation('http://localhost:5174/x', dev, true)).toBe('external')
  })
  it('畸形 URL → deny（fail-closed）', () => {
    expect(classifyNavigation('not a url', dev, true)).toBe('deny')
  })
  it('非 dev server：cyrene://renderer/__cyrene-media/* 前缀 deny（防媒体字节作顶层文档，spec §4.4/§4.9）', () => {
    expect(classifyNavigation('cyrene://renderer/__cyrene-media/attachment/att_1', undefined, false)).toBe('deny')
    expect(classifyNavigation('cyrene://renderer/__cyrene-media/sticker/st_1', undefined, false)).toBe('deny')
    expect(classifyNavigation('cyrene://renderer/index.html', undefined, false)).toBe('app')  // 普通渲染根文件仍 app
  })
})
