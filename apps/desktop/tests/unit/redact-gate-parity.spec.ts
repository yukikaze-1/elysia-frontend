// tests/unit/redact-gate-parity.spec.ts
// 门禁规则 ↔ 产品脱敏的**交叉校验**（2026-09-16 审计 P2「密钥形态规则四份独立副本且已分叉」）。
//
// 本轮逐处读码复核的事实：
//   · 四份规则互不 import：产品侧 `src/main/diagnostics/redact.ts`、门禁侧 `scripts/verify-sensitive-core.mjs`、
//     产物扫描 `scripts/verify-artifact.cjs`、取证脚本 `scripts/integration/stage-h/lib/redact.ts`；
//   · 且**形态已经不同**：JWT 产品是三段 `{10,}\.{5,}\.{5,}`／门禁是两段 `{20,}\.{1,}`；`sk-`/`AKIA` 产品
//     合并一条带 `\b`／门禁拆两条无 `\b`；40+ 长串产品是裸规则／门禁多一道 `isSecretLikeBase64` 收窄。
//
// 后果**不是**"门禁会红"，而是"门禁永远不会红"：`verify:sensitive` 扫的是仓库源码文本、用它自己那份规则，
// 产品那份改窄到只剩 4 个固定样本能过，它也照旧全绿。所以这里补的是缺失的那一环——
// **凡门禁认得的秘密形状，产品脱敏都必须把它消掉**：判据 = 用产品脱敏后的文本再跑门禁规则，必须零命中。
// 它同时压住两侧：产品规则收窄 → 红；门禁新增规则而没人想过产品侧要不要跟 → 归属完备断言红。
import { describe, expect, it } from 'vitest'
import { SECRET_BLACKLIST, scanSecretsInText } from '../../scripts/verify-sensitive-core.mjs'
import { redactSensitiveValues } from '../../src/main/diagnostics/redact'

/**
 * 「共享家族」：门禁规则 ↔ 产品脱敏必须同进同退的五条。
 * 样本按**门禁规则的字符类与长度门槛**构造（不抄产品侧测试的样本——抄样本会让两侧一起漂移而互不发觉）。
 */
const SHARED_SAMPLES: Record<string, string> = {
  'bearer-token': 'log line: Authorization: Bearer a1b2c3_-~+/xyz',
  'jwt': 'log line: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  'sk-api-key': 'log line: const key = "sk-abcdefghijklmnop"',
  'aws-access-key': 'log line: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  'base64-long-string': 'log line: x = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"'
}

/**
 * 门禁独有（**不**属共享家族）的规则与理由。新增任何门禁规则都必须在这里显式归类，
 * 否则下面的「归属完备」断言会红——"新加一条规则但没人想过产品侧要不要跟着做"正是本缺陷的成因。
 */
const GATE_ONLY: Record<string, string> = {
  'agent-access-token-assign':
    '仓库卫生形态（shell 赋值语法）：它检的是"有没有把 token 写进仓库"，不是"日志里有没有秘密"。'
    + '应用日志不产生该语法（用户 shell 环境不外泄），故产品脱敏刻意不掩赋值语法——否则会把 `X=Y` 这类正常配置行也掩掉。',
  'account-token-assign': '同上（ACCOUNT_TOKEN）。',
  'private-key-header':
    '仓库卫生形态：PEM 私钥是**多行块**，产品侧只掩表头会留下正文——半掩比不掩更误导，故刻意不做。'
}

describe('门禁规则集 ↔ 产品脱敏（2026-09-16 审计 P2）', () => {
  it('归属完备：门禁每条规则要么在共享家族里、要么被显式归类为门禁独有（新增规则必须做这个决定）', () => {
    const declared = new Set([...Object.keys(SHARED_SAMPLES), ...Object.keys(GATE_ONLY)])
    const actual = SECRET_BLACKLIST.map((r) => r.name)
    expect(actual.filter((n) => !declared.has(n)), '新增的门禁规则未归类：它该不该同时落进产品脱敏？').toEqual([])
    expect([...declared].filter((n) => !actual.includes(n)), '这里声明了门禁并不存在的规则').toEqual([])
    expect(actual).toHaveLength(8)   // 规则集规模钉住（顺序是承重的：Bearer 必须先于 40+ 长串，见 core 头注）
  })

  it('共享家族：门禁认得的每一类秘密，产品脱敏都必须消掉（否则产品侧回归而门禁照旧全绿）', () => {
    for (const [name, sample] of Object.entries(SHARED_SAMPLES)) {
      // 前置：门禁确实命中这个样本（否则下面的断言会因为"样本本身不触发"而恒真）
      expect(scanSecretsInText(sample).map((h) => h.name), `样本未触发门禁规则 ${name}`).toContain(name)
      const redacted = redactSensitiveValues(sample)
      expect(redacted, `产品脱敏未改动样本 ${name}`).not.toBe(sample)
      // 判据：脱敏之后**任何**门禁规则都不该再命中（不只是同名那条——长串规则可能接住漏下的残段）
      expect(scanSecretsInText(redacted).map((h) => `残留命中 ${h.name}`)).toEqual([])
    }
  })

  it('已记录的分叉（方向一：门禁更宽）——门禁认得的 JWT 形状里，产品不掩那种短尾段形态', () => {
    // 门禁的 jwt 是 `eyJ{20,}\.[…]+`（只要一段尾），产品是三段 `{10,}\.{5,}\.{5,}`。
    // 于是"eyJ + 20 位 + 点 + 4 位"这种形态会被门禁判为秘密、而被产品原样放过。
    // 记录它（而不是把产品规则放宽到门禁的松口径）：放宽产品规则会把 `eyJ…x.y` 这类非秘密串也掩掉，
    // 而真实 JWT 的段长远超此门槛——真实形态在下面的共享家族里两侧一致。
    const gateOnlyJwt = 'eyJ0123456789abcdefghij.x1y2.payload'
    expect(scanSecretsInText(gateOnlyJwt).map((h) => h.name)).toContain('jwt')
    expect(redactSensitiveValues(gateOnlyJwt)).toBe(gateOnlyJwt)
  })

  it('已记录的分叉（方向二：产品更宽）——产品认得的 JWT，门禁不认（掩得更多，方向安全）', () => {
    // 样本取自产品侧既有用例 tests/unit/redact.spec.ts:10：首段在 eyJ 之后只有 16 字符 < 门禁的 {20,}
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aGVsbG8td29ybGQtZGF0YQ'
    expect(scanSecretsInText(`token=${jwt}`).map((h) => h.name)).not.toContain('jwt')
    expect(redactSensitiveValues(`token=${jwt}`)).toBe('token=[REDACTED]')
    // 两侧**不是同一份规则**这件事必须留痕：将来若有人"统一"这两份规则，上面两条方向断言会红，
    // 逼他先确认收窄/放宽各自的影响面，而不是顺手改一份了事。
  })

  it('反向哨兵：命中与掩码都是可观测的（防"检查器失效"式假绿）', () => {
    const raw = SHARED_SAMPLES['sk-api-key']
    expect(scanSecretsInText(raw).map((h) => h.name)).toContain('sk-api-key')
    expect(redactSensitiveValues(raw)).toContain('[REDACTED]')
    // 若产品 RULES 被清空（redactSensitiveValues 恒等），第二行会红；若门禁规则被换成不匹配的形态，
    // 第一行会红。两行都不依赖对方的状态，故"检查器失效"不会被读成通过。
  })
})
