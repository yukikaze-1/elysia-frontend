import { describe, expect, it } from 'vitest'
import { computeLocalRisk, isPathBlacklisted, isPathWithinRoot, isPathWithinSandbox, normalizeReportedRisk, normalizeToolPath, PATH_BLACKLIST_DEFAULTS, isDomainAllowed, PolicyError } from '../../src/main/tools/tool-policy'

const posixPlatform = { platform: 'posix' as const }

describe('isPathBlacklisted（段边界匹配）', () => {
  it('/etc 前缀含子目录', () => {
    expect(isPathBlacklisted('/etc/passwd', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true)
    expect(isPathBlacklisted('/etc/ssl/certs/ca.crt', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true)
  })
  it('段边界：/var2 不误伤、/var 命中', () => {
    expect(isPathBlacklisted('/var2/x', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(false)
    expect(isPathBlacklisted('/var/log', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true)
  })
  it('/tmp 入黑名单（D6B-02/M-1）', () => { expect(isPathBlacklisted('/tmp/x', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true) })
  it('/opt 命中（A5）', () => { expect(isPathBlacklisted('/opt/app', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true) })
  it('dot-secret 精确项 basename 匹配 .env', () => { expect(isPathBlacklisted('/home/u/proj/.env', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true) })
  it('.kube/config 路径段精确项（L5）', () => { expect(isPathBlacklisted('/home/u/.kube/config', PATH_BLACKLIST_DEFAULTS, posixPlatform)).toBe(true) })
  it('/home/* 其它用户 home 命中、当前用户 home 不命中', () => {
    expect(isPathBlacklisted('/home/other/secret.txt', PATH_BLACKLIST_DEFAULTS, { ...posixPlatform, currentHome: '/home/me' })).toBe(true)
    expect(isPathBlacklisted('/home/me/secret.txt', PATH_BLACKLIST_DEFAULTS, { ...posixPlatform, currentHome: '/home/me' })).toBe(false)
  })
  it('非黑名单路径放行（当前用户 home 下普通项目文件）', () => {
    // /home/* 规则：其它用户 home 黑名单——以 currentHome=/home/u 固定归属，普通项目文件放行
    expect(isPathBlacklisted('/home/u/proj/notes.md', PATH_BLACKLIST_DEFAULTS, { ...posixPlatform, currentHome: '/home/u' })).toBe(false)
  })
  it('Windows 大小写不敏感，且用户 AppData 命中', () => {
    const windowsPlatform = { platform: 'windows' as const, currentHome: 'C:\\Users\\me' }
    expect(isPathBlacklisted('c:\\WINDOWS\\System32', PATH_BLACKLIST_DEFAULTS, windowsPlatform)).toBe(true)
    expect(isPathBlacklisted('C:\\Users\\ME\\AppData\\Roaming', PATH_BLACKLIST_DEFAULTS, windowsPlatform)).toBe(true)
    expect(isPathBlacklisted('C:\\Users\\me\\project\\notes.md', PATH_BLACKLIST_DEFAULTS, windowsPlatform)).toBe(false)
  })
})

describe('isPathWithinRoot（平台语义下的真实目录包含性）', () => {
  it('POSIX 子路径命中，同前缀兄弟目录不命中', () => {
    expect(isPathWithinRoot('/tmp/root/file.txt', '/tmp/root', 'posix')).toBe(true)
    expect(isPathWithinRoot('/tmp/rooted/file.txt', '/tmp/root', 'posix')).toBe(false)
  })
  it('Windows 包含性忽略大小写，不接受同前缀兄弟目录', () => {
    expect(isPathWithinRoot('c:\\TEMP\\Fixture\\child.txt', 'C:\\temp\\fixture', 'windows')).toBe(true)
    expect(isPathWithinRoot('C:\\temp\\fixture-other\\child.txt', 'C:\\temp\\fixture', 'windows')).toBe(false)
  })
  it('Windows 尾分隔符、盘符根与跨盘语义正确', () => {
    expect(isPathWithinRoot('C:\\temp\\fixture\\child.txt', 'C:\\temp\\fixture\\', 'windows')).toBe(true)
    expect(isPathWithinRoot('C:\\Users\\me\\file.txt', 'C:\\', 'windows')).toBe(true)
    expect(isPathWithinRoot('D:\\file.txt', 'C:\\', 'windows')).toBe(false)
  })
})

describe('normalizeToolPath（H-3 full realpath；注入 realPath 桩，M7 语义：桩收到的输入是 resolve 后的绝对路径）', () => {
  it('相对路径解析为绝对（桩透传）', () => {
    const r = normalizeToolPath('notes.md', { platform: 'posix', realPath: (p) => p })
    expect(r.realPath.endsWith('/notes.md')).toBe(true)
  })
  it('中间组件 symlink 逃逸被拒（H-3）', () => {
    // fake realpath 返回 /etc/passwd（linkdir→/etc）→ 黑名单命中
    const r = normalizeToolPath('/home/me/linkdir/passwd', { platform: 'posix', realPath: () => '/etc/passwd' })
    expect(isPathBlacklisted(r.realPath, undefined, posixPlatform)).toBe(true)
  })
  it('逃逸/非法 → PATH_UNSAFE 抛错', () => {
    expect(() => normalizeToolPath('', { platform: 'posix', realPath: (p) => p })).toThrow(PolicyError)
    // 桩模拟 full realpath：目标或其父链不可解析（/parent-only 不存在）→ PATH_UNSAFE
    expect(() => normalizeToolPath('/parent-only/x', { platform: 'posix', realPath: (p) => { if (p.startsWith('/parent-only')) throw new Error('ENOENT'); return p } })).toThrow(PolicyError)
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

// —— D4-1（2026-09-15）：本地风险重算 ——
describe('normalizeReportedRisk（wire 上报值归一）', () => {
  it('合法三档原样返回', () => {
    expect(normalizeReportedRisk('safe')).toBe('safe')
    expect(normalizeReportedRisk('medium')).toBe('medium')
    expect(normalizeReportedRisk('high')).toBe('high')
  })
  it('缺省（undefined/null/空串）→ undefined（视为未上报，不参与抬升）', () => {
    expect(normalizeReportedRisk(undefined)).toBeUndefined()
    expect(normalizeReportedRisk(null)).toBeUndefined()
    expect(normalizeReportedRisk('')).toBeUndefined()
  })
  it('**未知/畸形值一律归 high**（不做静默降级，也不忽略）', () => {
    expect(normalizeReportedRisk('critical')).toBe('high')
    expect(normalizeReportedRisk('SAFE')).toBe('high')
    expect(normalizeReportedRisk(3)).toBe('high')
    expect(normalizeReportedRisk({ level: 'high' })).toBe('high')
    expect(normalizeReportedRisk([])).toBe('high')
  })
})

describe('computeLocalRisk（本地重算：只升不降）', () => {
  it('无上报值时取注册表常量', () => {
    expect(computeLocalRisk({ base: 'medium' })).toBe('medium')
    expect(computeLocalRisk({ base: 'safe' })).toBe('safe')
  })
  it('后端上报更高 → 抬升到上报值（本地风险覆盖后端风险，但不低于它）', () => {
    expect(computeLocalRisk({ base: 'safe', reported: 'high' })).toBe('high')
    expect(computeLocalRisk({ base: 'medium', reported: 'high' })).toBe('high')
  })
  it('后端上报更低 → **不降级**（绝不因为后端说低就降低本地等级）', () => {
    expect(computeLocalRisk({ base: 'high', reported: 'safe' })).toBe('high')
    expect(computeLocalRisk({ base: 'medium', reported: 'safe' })).toBe('medium')
  })
  it('畸形上报值按 high 参与抬升', () => {
    expect(computeLocalRisk({ base: 'safe', reported: 'nonsense' })).toBe('high')
  })
  it('黑名单命中 → 恒 high（压过一切，含 base=safe）', () => {
    expect(computeLocalRisk({ base: 'safe', blacklisted: true })).toBe('high')
    expect(computeLocalRisk({ base: 'safe', reported: 'safe', blacklisted: true })).toBe('high')
  })
  it('**参数参与判定**：带 content 的路径工具（写覆盖）→ high（此前只看工具名）', () => {
    expect(computeLocalRisk({ base: 'medium', realPath: '/tmp/cyrene-fixtures/a.txt', args: { path: '/tmp/cyrene-fixtures/a.txt', content: 'x' } })).toBe('high')
  })
  it('参数不影响判定时退化为「注册表常量与上报值的较大者」', () => {
    expect(computeLocalRisk({ base: 'safe', args: { region: null } })).toBe('safe')
    expect(computeLocalRisk({ base: 'medium', args: { path: '/x' } })).toBe('medium')
  })
  it('沙盒命中不改变等级（本函数不降级；沙盒只影响授权默认策略）', () => {
    expect(computeLocalRisk({ base: 'medium', realPath: '/srv/sandbox/a.txt', args: { path: '/srv/sandbox/a.txt' }, sandboxRoots: ['/srv/sandbox'], platform: 'posix' })).toBe('medium')
  })
})

// —— D4-15（2026-09-15）：沙盒目录层 ——
describe('isPathWithinSandbox', () => {
  it('F-06 拍板值：空集 ⇒ 恒 false（零预授权不产生新的自动执行路径）', () => {
    expect(isPathWithinSandbox('/srv/sandbox/a.txt', [], 'posix')).toBe(false)
  })
  it('段边界包含性：目录内命中、同前缀兄弟目录不命中', () => {
    expect(isPathWithinSandbox('/srv/sandbox/a.txt', ['/srv/sandbox'], 'posix')).toBe(true)
    expect(isPathWithinSandbox('/srv/sandbox', ['/srv/sandbox'], 'posix')).toBe(true)
    expect(isPathWithinSandbox('/srv/sandbox2/a.txt', ['/srv/sandbox'], 'posix')).toBe(false)
  })
  it('空串根被忽略（不因畸形配置把「所有路径」放行）', () => {
    expect(isPathWithinSandbox('/etc/passwd', [''], 'posix')).toBe(false)
  })
  it('Windows 大小写语义一致', () => {
    expect(isPathWithinSandbox('C:\\Work\\Sb\\a.txt', ['c:\\work\\sb'], 'windows')).toBe(true)
  })
})
