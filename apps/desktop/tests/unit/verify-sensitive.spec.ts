// tests/unit/verify-sensitive.spec.ts
// 纯函数层测试：verify:sensitive 扫描器拆分核心（spec §5.1 / D7A-14 黑名单 / 排除 / 行级 allowlist）。
// 脚本自跑（git ls-files + allowlist fail-loud 全链路）不走单测——由 Step 4 自跑验证。
import { describe, expect, it } from 'vitest'
import {
  SECRET_BLACKLIST,
  EXCLUDED_DIR_PREFIXES,
  SELF_EXCLUDED_FILES,
  RULE_FILE_EXCLUSIONS,
  isExcludedPath,
  isSelfExcludedFile,
  isRuleExcludedForPath,
  scanSecretsInText,
  allowlistEntryFor,
  allowlistEntryMatches
} from '../../scripts/verify-sensitive-core.mjs'

describe('verify:sensitive 核心（黑名单规则集，D7A-14 + review LOW①）', () => {
  it('黑名单共 8 规则（redact RULES 四条 + 赋值形态两条 + PRIVATE KEY 头 + 长串规则）', () => {
    expect(SECRET_BLACKLIST.map((r) => r.name)).toEqual([
      'bearer-token', 'jwt', 'sk-api-key', 'aws-access-key',
      'agent-access-token-assign', 'account-token-assign', 'private-key-header',
      'base64-long-string'
    ])
  })

  it('黑名单 8 规则逐一命中各自形态（redact RULES + 赋值形态 + PRIVATE KEY）', () => {
    const cases = [
      { name: 'bearer-token', trigger: 'Authorization: Bearer a1b2c3_-~+/xyz' },
      // eyJ 后 ≥20 位 [A-Za-z0-9_-] + 点 + ≥1 段
      { name: 'jwt', trigger: 'eyJ0123456789abcdefghij.x1y2' },
      // sk- 后 ≥10 位字母数字
      { name: 'sk-api-key', trigger: 'const key = "sk-abcdefghijklmnop"' },
      // AKIA + 16 位 A-Z0-9
      { name: 'aws-access-key', trigger: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' },
      { name: 'agent-access-token-assign', trigger: 'AGENT_ACCESS_TOKEN=cyrene-dev-secret' },
      { name: 'account-token-assign', trigger: 'ACCOUNT_TOKEN = "cyrene-dev-secret"' },
      { name: 'private-key-header', trigger: '-----BEGIN RSA PRIVATE KEY-----' },
      // 40+ 位 [A-Za-z0-9+/]（裸长串，redact 第 4 条原文形态——无 Bearer/sk-/AKIA 前缀也不漏检）
      // 2026-09-10 收窄后须「像秘密」：同时含大写/小写/数字（见下方 isSecretLikeBase64 专项 describe）
      { name: 'base64-long-string', trigger: 'x = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"' }
    ]
    for (const c of cases) {
      const hits = scanSecretsInText(c.trigger)
      expect(hits.map((h) => h.name), `${c.trigger} 应命中 ${c.name}`).toContain(c.name)
    }
  })

  it('脱敏输出形态与普通引用不误报', () => {
    const benign = [
      'token = "Bearer [REDACTED]"', // redact 替换型掩码输出不能回扫命中
      'const seg = eyJabc', // eyJ 后不足 20 位
      '前缀 sk-abc（不足 10 位）', // sk- 后不足
      'AKIA1234（不足 16 位）',
      'if (env.AGENT_ACCESS_TOKEN) return', // 仅引用无赋值
      'process.env.ACCOUNT_TOKEN // 读取', // 仅引用无赋值
      '-----BEGIN CERTIFICATE-----', // 证书头非私钥
      '01234567890123456789012345678901234567', // 38 位（不足 40）
      'CyToolCard/CyLiveToolCards 短词表（26 位，不足 40）' // 词表类足够短不命中（长词表按规则命中→主干允许表承接）
    ]
    for (const line of benign) {
      const hits = scanSecretsInText(line)
      expect(hits, `${line} 应无命中`).toEqual([])
    }
  })

  it('逐行扫描报告 1 基行号与整行文本', () => {
    const text = ['干净行一', 'Authorization: Bearer aaaabbbbcccc', '干净行三'].join('\n')
    const hits = scanSecretsInText(text)
    expect(hits.length).toBe(1)
    expect(hits[0]).toMatchObject({ name: 'bearer-token', line: 2, text: 'Authorization: Bearer aaaabbbbcccc' })
  })

  it('自定义黑名单可注入（扫描函数参数化）', () => {
    const custom = [{ name: 'my-secret', re: /MY_SECRET\s*=\s*\S+/ }]
    expect(scanSecretsInText('MY_SECRET=1', custom).map((h) => h.name)).toContain('my-secret')
    expect(scanSecretsInText('MY_SECRET=1', [])).toEqual([])
  })
})

// 2026-09-10 门禁漂移整改：原规则是裸 `[A-Za-z0-9+/]{40,}`，而 `/` 在字符集内 → 任何 40+ 相对 import 路径、
// camelCase 标识符串、词表串、hex 摘要都命中，命中面全靠逐文件人工 allowlist 承接 → 两周内腐烂、门禁长期全红。
// 收窄为「像秘密」后：可读长串不再命中，真实 base64 凭据仍命中（检出保真度见 core 注释的实测数据）。
describe('verify:sensitive 核心（base64-long-string 收窄：像秘密 vs 够长，2026-09-10）', () => {
  const nameOf = (line: string) => scanSecretsInText(line).map((h) => h.name)

  it('可读长串不再命中：相对 import 路径 / 斜杠连接标识符串 / hex 摘要', () => {
    const benign = [
      "import CyLive2DPanel from '../../src/renderer/src/components/CyLive2DPanel'", // 斜杠路径 + 大小写 + 数字
      'settingsLoad/settingsSave/listLive2dModels',                                  // 斜杠连接驼峰标识符串
      'const schemaHash = "c075c38c34b51c0584fcbf3ff4cdfbbf0a2ca07935a6331f2a5ef54b222ea254"', // 64 hex（无大写）
      'commit 10160fc553e601fa7c20d079c4f292c8f424be01',                             // 40 hex git SHA（无大写）
      'capabilities/transcription/command/wake/service'                              // 词表路径（无数字）
    ]
    for (const line of benign) {
      expect(nameOf(line), `${line} 应无命中`).not.toContain('base64-long-string')
    }
  })

  it('真实 base64 凭据仍命中：无 `/` 的、含 `/` 但高熵的、带 `=` 填充的', () => {
    const real = [
      'const key = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3gH5jK7mP9rS1"',       // 45 字符、无 `/`（no-slash 子句放行）
      'const key = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3gH5jK7/mP9rS1"',      // 46 字符、含 `/`、H=4.75（熵子句放行）
      'token: "Zm9vYmFyQkFSNjQxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcA=="'     // 52 字符、带 `==` 填充
    ]
    for (const line of real) {
      expect(nameOf(line), `${line} 应命中（像秘密）`).toContain('base64-long-string')
    }
  })

  it('熵阈值挡掉的是可读斜杠串、不是随机串：两条只差可读性时判定相反', () => {
    // 两条都 ≥40 字符、都含 `/`、都同时有大写/小写/数字——唯一差别是熵（4.11 vs 4.75，阈值 4.5）
    expect(nameOf('p = "apps/desktop/src/renderer/src/components/CyLive2DPanel2"')).not.toContain('base64-long-string')
    expect(nameOf('p = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3gH5jK7/mP9rS1"')).toContain('base64-long-string')
  })

  it('accept 谓词只作用于拿到的子串，同一行其余规则不被遮蔽', () => {
    // 同一行：长串被 accept 挡掉，但 Bearer 规则照常命中（规则域互不遮蔽）
    const line = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789, note = "apps/desktop/src/main/connection"'
    expect(nameOf(line)).toContain('bearer-token')
  })
})

describe('verify:sensitive 核心（按规则文件排除，2026-09-10）', () => {
  it('RULE_FILE_EXCLUSIONS 只豁免列出的规则名，其余规则照扫', () => {
    expect(RULE_FILE_EXCLUSIONS['base64-long-string']).toContain('pnpm-lock.yaml')
    expect(isRuleExcludedForPath('base64-long-string', 'pnpm-lock.yaml')).toBe(true)
    // 同一文件的其他规则不豁免（锁文件里的 token-in-URL / 赋值形态仍须检出）
    expect(isRuleExcludedForPath('bearer-token', 'pnpm-lock.yaml')).toBe(false)
    expect(isRuleExcludedForPath('agent-access-token-assign', 'pnpm-lock.yaml')).toBe(false)
    // 其他文件不受影响
    expect(isRuleExcludedForPath('base64-long-string', 'apps/desktop/src/main/index.ts')).toBe(false)
  })

  it('扫描器自身三文件仍是整文件排除（与按规则排除的区别）', () => {
    expect(isSelfExcludedFile('apps/desktop/scripts/verify-sensitive-core.mjs')).toBe(true)
    expect(isExcludedPath('pnpm-lock.yaml')).toBe(false) // 锁文件没有被整文件排除
  })
})

describe('verify:sensitive 核心（排除目录与自排除，spec §5.1 D7A-14 + review HIGH-1）', () => {
  it('third_party/ 整树前缀排除；vendored live2d 两树同级；边界前缀不误排', () => {
    expect(EXCLUDED_DIR_PREFIXES).toContain('third_party/')
    expect(isExcludedPath('third_party/CubismSdkForWeb-5-r.5/bin/live2dcubismcore.min.js')).toBe(true)
    // review LOW① 落地中实测：vendored asm.js base64 副本与 Framework 源码同 third_party 语义（lint 同款忽略）
    expect(isExcludedPath('apps/desktop/src/renderer/public/live2d/live2dcubismcore.min.js')).toBe(true)
    expect(isExcludedPath('apps/desktop/src/renderer/src/live2d/framework/model/cubismmodel.ts')).toBe(true)
    expect(isExcludedPath('notthird-party/keep.txt')).toBe(false)
    expect(isExcludedPath('apps/desktop/src/main/index.ts')).toBe(false)
  })

  it('扫描器自身三文件自排除（HIGH-1：黑名单字面量/触发器必然命中自身且非秘密）', () => {
    expect(SELF_EXCLUDED_FILES.length).toBe(3)
    expect(isSelfExcludedFile('apps/desktop/scripts/verify-sensitive.mjs')).toBe(true)
    expect(isSelfExcludedFile('apps/desktop/scripts/verify-sensitive-core.mjs')).toBe(true)
    expect(isSelfExcludedFile('apps/desktop/tests/unit/verify-sensitive.spec.ts')).toBe(true)
    expect(isSelfExcludedFile('apps/desktop/src/main/index.ts')).toBe(false)
  })
})

describe('verify:sensitive 核心（行级 allowlist：路径精确 + 锚定段 + 规则域）', () => {
  const entries = [
    { path: 'apps/desktop/tests/fixtures/leak.json', anchor: /Bearer XXXEXAMPLE/, reason: 'fixture 样例' },
    { path: 'docs/example.md', anchor: /AGENT_ACCESS_TOKEN=your-token/, reason: '文档示例' }
  ]

  it('锚定段命中返回对应条目（无 rules 域 = 全规则豁免）', () => {
    expect(allowlistEntryFor([entries[0]], '  "Authorization": "Bearer XXXEXAMPLE"', 'bearer-token')).toBe(entries[0])
  })

  it('锚定段不命中 / 行不在该路径 → null（fail-loud 依据）', () => {
    expect(allowlistEntryFor([entries[0]], 'Authorization: Bearer YYYEXAMPLE', 'bearer-token')).toBe(null)
    expect(allowlistEntryFor([], 'Bearer XXXEXAMPLE', 'bearer-token')).toBe(null)
  })

  it('R2-1：rules 限定的类别级条目不豁免规则域外的命中（通用 40+ 锚不得放行 Bearer）', () => {
    const generic = [{ path: 'x.ts', anchor: /[A-Za-z0-9+/]{40,}/, rules: ['base64-long-string'], reason: '类别' }]
    // 同时含 40+ run 与 Bearer 的行：规则 8 命中放行、规则 1 命中不放行（正是 MED-1 弱化面）
    const line = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN'
    expect(allowlistEntryFor(generic, line, 'base64-long-string')).toBe(generic[0])
    expect(allowlistEntryFor(generic, line, 'bearer-token')).toBe(null)
    // 无 rules 域条目（精确语义）对两规则均放行
    const free = [{ path: 'x.ts', anchor: /[A-Za-z0-9+/]{40,}/, reason: '类别' }]
    expect(allowlistEntryFor(free, line, 'bearer-token')).toBe(free[0])
    expect(allowlistEntryFor(free, line, 'base64-long-string')).toBe(free[0])
  })

  it('R2-1：allowlistEntryMatches 同样按规则域过滤（fired 记账与服务同规则）', () => {
    const generic = { anchor: /[A-Za-z0-9+/]{40,}/, rules: ['base64-long-string'], reason: '类别' }
    const line = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN'
    expect(allowlistEntryMatches(generic, line, 'base64-long-string')).toBe(true)
    expect(allowlistEntryMatches(generic, line, 'bearer-token')).toBe(false)
    expect(allowlistEntryMatches({ anchor: /[A-Za-z0-9+/]{40,}/, reason: 'x' }, line, 'bearer-token')).toBe(true)
  })
})
