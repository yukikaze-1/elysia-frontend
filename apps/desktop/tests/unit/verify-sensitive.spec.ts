// tests/unit/verify-sensitive.spec.ts
// 纯函数层测试：verify:sensitive 扫描器拆分核心（spec §5.1 / D7A-14 黑名单 / 排除 / 行级 allowlist）。
// 脚本自跑（git ls-files + allowlist fail-loud 全链路）不走单测——由 Step 4 自跑验证。
import { describe, expect, it } from 'vitest'
import {
  SECRET_BLACKLIST,
  EXCLUDED_DIR_PREFIXES,
  isExcludedPath,
  scanSecretsInText,
  allowlistEntryFor
} from '../../scripts/verify-sensitive-core.mjs'

describe('verify:sensitive 核心（黑名单规则集，D7A-14）', () => {
  it('黑名单共 7 规则（redact RULES 四条 + 赋值形态两条 + PRIVATE KEY 头）', () => {
    expect(SECRET_BLACKLIST.map((r) => r.name)).toEqual([
      'bearer-token', 'jwt', 'sk-api-key', 'aws-access-key',
      'agent-access-token-assign', 'account-token-assign', 'private-key-header'
    ])
  })

  it('黑名单 7 规则逐一命中各自形态（redact RULES + 赋值形态 + PRIVATE KEY）', () => {
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
      { name: 'private-key-header', trigger: '-----BEGIN RSA PRIVATE KEY-----' }
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
      '-----BEGIN CERTIFICATE-----' // 证书头非私钥
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

describe('verify:sensitive 核心（排除目录，spec §5.1 D7A-14）', () => {
  it('third_party/ 整树前缀排除；边界前缀不误排', () => {
    expect(EXCLUDED_DIR_PREFIXES).toContain('third_party/')
    expect(isExcludedPath('third_party/CubismSdkForWeb-5-r.5/bin/live2dcubismcore.min.js')).toBe(true)
    expect(isExcludedPath('notthird-party/keep.txt')).toBe(false)
    expect(isExcludedPath('apps/desktop/src/main/index.ts')).toBe(false)
  })
})

describe('verify:sensitive 核心（行级 allowlist：路径精确 + 锚定段）', () => {
  const entries = [
    { path: 'apps/desktop/tests/fixtures/leak.json', anchor: /Bearer XXXEXAMPLE/, reason: 'fixture 样例' },
    { path: 'docs/example.md', anchor: /AGENT_ACCESS_TOKEN=your-token/, reason: '文档示例' }
  ]

  it('锚定段命中返回对应条目', () => {
    expect(allowlistEntryFor(
      [entries[0]],
      '  "Authorization": "Bearer XXXEXAMPLE"'
    )).toBe(entries[0])
  })

  it('锚定段不命中 / 行不在该路径 → null（fail-loud 依据）', () => {
    expect(allowlistEntryFor([entries[0]], 'Authorization: Bearer YYYEXAMPLE')).toBe(null)
    expect(allowlistEntryFor([], 'Bearer XXXEXAMPLE')).toBe(null)
  })
})
