import { describe, expect, it } from 'vitest'
import { mimeOf } from '../../src/main/protocol/mime'

describe('mimeOf', () => {
  it('常见扩展名命中', () => {
    expect(mimeOf('/assets/index.html')).toContain('text/html')
    expect(mimeOf('/assets/app-abc123.js')).toContain('javascript')
    expect(mimeOf('/assets/style.css')).toContain('text/css')
    expect(mimeOf('/assets/logo.svg')).toContain('image/svg')
  })
  it('大小写不敏感', () => {
    expect(mimeOf('/assets/APP.JS')).toContain('javascript')
  })
  it('未命中 → null（保留 net.fetch 推断，不无条件覆盖）', () => {
    expect(mimeOf('/assets/data.bin')).toBeNull()
    expect(mimeOf('/assets/noext')).toBeNull()
  })
})
