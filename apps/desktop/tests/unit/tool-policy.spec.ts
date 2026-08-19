import { describe, expect, it } from 'vitest'
import { isPathBlacklisted, normalizeToolPath, PATH_BLACKLIST_DEFAULTS, isDomainAllowed, PolicyError } from '../../src/main/tools/tool-policy'

describe('isPathBlacklisted（段边界匹配）', () => {
  it('/etc 前缀含子目录', () => {
    expect(isPathBlacklisted('/etc/passwd')).toBe(true)
    expect(isPathBlacklisted('/etc/ssl/certs/ca.crt')).toBe(true)
  })
  it('段边界：/var2 不误伤、/var 命中', () => {
    expect(isPathBlacklisted('/var2/x')).toBe(false)
    expect(isPathBlacklisted('/var/log')).toBe(true)
  })
  it('/tmp 入黑名单（D6B-02/M-1）', () => { expect(isPathBlacklisted('/tmp/x')).toBe(true) })
  it('/opt 命中（A5）', () => { expect(isPathBlacklisted('/opt/app')).toBe(true) })
  it('dot-secret 精确项 basename 匹配 .env', () => { expect(isPathBlacklisted('/home/u/proj/.env')).toBe(true) })
  it('.kube/config 路径段精确项（L5）', () => { expect(isPathBlacklisted('/home/u/.kube/config')).toBe(true) })
  it('/home/* 其它用户 home 命中、当前用户 home 不命中', () => {
    expect(isPathBlacklisted('/home/other/secret.txt', PATH_BLACKLIST_DEFAULTS, { currentHome: '/home/me' })).toBe(true)
    expect(isPathBlacklisted('/home/me/secret.txt', PATH_BLACKLIST_DEFAULTS, { currentHome: '/home/me' })).toBe(false)
  })
  it('非黑名单路径放行（当前用户 home 下普通项目文件）', () => {
    // /home/* 规则：其它用户 home 黑名单——以 currentHome=/home/u 固定归属，普通项目文件放行
    expect(isPathBlacklisted('/home/u/proj/notes.md', PATH_BLACKLIST_DEFAULTS, { currentHome: '/home/u' })).toBe(false)
  })
})
describe('normalizeToolPath（H-3 full realpath；注入 realPath 桩，M7 语义：桩收到的输入是 resolve 后的绝对路径）', () => {
  it('相对路径解析为绝对（桩透传）', () => {
    const r = normalizeToolPath('notes.md', { realPath: (p) => p })
    expect(r.realPath.endsWith('/notes.md')).toBe(true)
  })
  it('中间组件 symlink 逃逸被拒（H-3）', () => {
    // fake realpath 返回 /etc/passwd（linkdir→/etc）→ 黑名单命中
    const r = normalizeToolPath('/home/me/linkdir/passwd', { realPath: () => '/etc/passwd' })
    expect(isPathBlacklisted(r.realPath)).toBe(true)
  })
  it('逃逸/非法 → PATH_UNSAFE 抛错', () => {
    expect(() => normalizeToolPath('', { realPath: (p) => p })).toThrow(PolicyError)
    // 桩模拟 full realpath：目标或其父链不可解析（/parent-only 不存在）→ PATH_UNSAFE
    expect(() => normalizeToolPath('/parent-only/x', { realPath: (p) => { if (p.startsWith('/parent-only')) throw new Error('ENOENT'); return p } })).toThrow(PolicyError)
  })
  it('Windows：盘符路径放行、ADS 拒、\\?\ 拒（A-9 平台注入；实现用 path.win32 处理）', () => {
    expect(normalizeToolPath('C:\\Users\\me\\f.txt', { platform: 'windows', realPath: (p) => p }).realPath).toBe('C:\\Users\\me\\f.txt')
    expect(() => normalizeToolPath('C:\\Users\\me\\f.txt:stream', { platform: 'windows', realPath: (p) => p })).toThrow(PolicyError)
    expect(() => normalizeToolPath('\\\\?\\C:\\x', { platform: 'windows', realPath: (p) => p })).toThrow(PolicyError)
  })
})
describe('isDomainAllowed', () => {
  it('同源放行 / 异源拒', () => {
    expect(isDomainAllowed('https://api.example.com/up', 'https://api.example.com')).toBe(true)
    expect(isDomainAllowed('https://evil.example.com/up', 'https://api.example.com')).toBe(false)
  })
})
