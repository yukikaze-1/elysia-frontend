// apps/desktop/tests/unit/sanitize.spec.ts
import { describe, expect, it } from 'vitest'
import { createSanitizePublicMessage } from '../../src/main/diagnostics/sanitize'

const roots = { home: '/home/alice', userData: '/home/alice/.config/Cyrene' }
const sanitize = createSanitizePublicMessage(roots)

describe('createSanitizePublicMessage', () => {
  it('userData 先替换再 home（先长后短）', () => {
    expect(sanitize('open /home/alice/.config/Cyrene/logs/x.log')).toBe('open <userData>/logs/x.log')
  })
  it('路径边界：/home/alice2 不被 /home/alice 误替换', () => {
    expect(sanitize('open /home/alice2/x')).toBe('open <path>')
  })
  it('file:// 绝对路径被掩', () => {
    expect(sanitize('load file:///tmp/secret 失败')).toBe('load <path> 失败')
  })
  it('win32 大小写不敏感 + 分隔符归一（盘符带左边界，不误伤 http://）', () => {
    const win = createSanitizePublicMessage({ home: 'C:\\Users\\Alice', userData: 'C:\\Users\\Alice\\AppData\\Roaming\\Cyrene' })
    expect(win('C:\\Users\\Alice\\AppData\\Roaming\\Cyrene\\logs\\a.log')).toBe('<userData>\\logs\\a.log')
    expect(win('curl http://127.0.0.1:8080/api')).toBe('curl http://127.0.0.1:8080/api') // 不误伤 URL
  })
  it('不改写 message 中非路径内容（\\d 不被当路径）', () => {
    expect(sanitize('无法匹配 \\d+ 表达式')).toBe('无法匹配 \\d+ 表达式')
  })
})
