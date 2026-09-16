// tests/unit/message-attribution.spec.ts
// `message/attribution` 的**对抗性**测试：生成事件的归属与栅栏判据。
//
// 每条用例针对一个具体的污染路径（§二十九 必测场景）：
//   · cancel → late delta           （P2-5：迟到中间事件不得复活已中断的消息）
//   · cancel → late completed       （P2-5：迟到终态不得把 interrupted 改回 completed）
//   · Generation A → cancel → B → A late final   （跨代：A 不得污染 B）
//   · Conversation A → switch B → A response     （跨会话：A 不得污染 B）
//   · connected(A) → connected(B)   （同会话不同传输转世）
//   · 重复 started 幂等（C4：不得清空已渲染分段）
//   · 角色身份不符 fail-closed（FE-E2）
import { describe, expect, it } from 'vitest'
import {
  createGenerationAttribution,
  type GenerationIdentity,
  type GenerationStore
} from '../../src/renderer/src/message/attribution'
import type { GenerationSessionIdentity } from '../../src/renderer/src/message/fencing'

const SESSION_A: GenerationSessionIdentity = { conversationId: 'conv-a', connectionEpoch: 1, connectionSignature: 'sig-1' }

/** 可变的最小 GenerationStore 假体：只实现判据真正读取的那几个字段。 */
function harness(options: { profiles?: boolean; identity?: GenerationIdentity } = {}) {
  const identity: GenerationIdentity = options.identity ?? {
    conversationId: 'conv-a',
    characterId: 'char-1',
    characterInstanceId: 'inst-1',
    characterRevision: 3,
    snapshot: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 }
  }
  const store: GenerationStore = {
    generationByConversation: {},
    generationSessionById: {},
    generationIdentityById: {},
    activeGenerationId: undefined,
    accumulatorGenerationId: undefined,
    accumulatorMessageId: undefined,
    currentSession: () => live,
    sessionIsCurrent: (session) =>
      session.conversationId === live.conversationId
      && session.connectionEpoch === live.connectionEpoch
      && session.connectionSignature === live.connectionSignature,
    profilesEnabled: () => options.profiles === true,
    identityForStarted: () => (options.profiles === true ? identity : undefined),
    terminalIdentityMatches: (event, expected) =>
      event.characterId === expected.characterId
      && event.characterInstanceId === expected.characterInstanceId
      && event.characterRevision === expected.characterRevision
  }
  let live: GenerationSessionIdentity = { ...SESSION_A }

  const attribution = createGenerationAttribution(store)

  return {
    store,
    attribution,
    /**
     * 登记一代（镜像 store 在 started 通过后写入的三张表）。
     *
     * 必须与 `message.store.rememberGeneration` 的写入纪律一致。身份台账**只有
     * `generationSessionById` 一份**（判定器直接读 store 注入的那张表），故这里没有第二处写入
     * 需要同步——早期版本还有一份模块内注册表，当时的镜像漏写就会与生产实现漂移而无人发现。
     */
    establish(generationId: string, conversationId = 'conv-a', withIdentity = options.profiles === true) {
      const session: GenerationSessionIdentity = { conversationId, connectionEpoch: live.connectionEpoch, connectionSignature: live.connectionSignature }
      store.generationByConversation[generationId] = conversationId
      store.generationSessionById[generationId] = session
      if (withIdentity) store.generationIdentityById[generationId] = identity
      store.activeGenerationId = generationId
      store.accumulatorGenerationId = generationId
      store.accumulatorMessageId = `msg-${generationId}`
    },
    /** 模拟 cancel / 断线：清 activeGenerationId 但 accumulator 仍在（P2-5 的前提）。 */
    clearActiveOnly() {
      store.activeGenerationId = undefined
    },
    /** 模拟换连接世代（connectionEpoch 递增 + 签名变化）。 */
    reconnect(signature = 'sig-2') {
      live = { ...live, connectionEpoch: live.connectionEpoch + 1, connectionSignature: signature }
    },
    /** 模拟切会话。 */
    switchConversation(conversationId: string) {
      live = { ...live, conversationId }
    },
    live,
  }
}

describe('generation.started 归属', () => {
  it('非当前会话的 started → 丢弃，绝不覆盖当前会话的 accumulator', () => {
    const h = harness()
    const decision = h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-b', messageId: 'm1' }, 'started')
    expect(decision).toEqual({ verdict: 'drop', reason: 'generation.started' })
  })

  it('当前会话、无活动代 → 建立新代', () => {
    const h = harness()
    const decision = h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1' }, 'started')
    expect(decision).toMatchObject({ verdict: 'ready', kind: 'startedEstablish', generationId: 'g1', conversationId: 'conv-a' })
  })

  it('同一 generationId 重复 started → 幂等补身份（**不是** establish，accumulator 不得重建）', () => {
    const h = harness()
    h.establish('g1')
    const decision = h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1' }, 'started')
    expect(decision).toMatchObject({ verdict: 'ready', kind: 'startedDuplicate', generationId: 'g1', messageId: 'msg-g1' })
  })

  it('重复 started 且 accumulator 已不在 → messageId 退回事件自身（仍不重建）', () => {
    const h = harness()
    h.establish('g1')
    h.store.accumulatorMessageId = undefined
    const decision = h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'evt-msg' }, 'started')
    expect(decision).toMatchObject({ verdict: 'ready', kind: 'startedDuplicate', messageId: 'evt-msg' })
  })

  it('Generation A 在途时 B 开始 → supersede：必须带回 A 的 id 以便就地收成 interrupted', () => {
    const h = harness()
    h.establish('gA')
    const decision = h.attribution.attribute({ generationId: 'gB', conversationId: 'conv-a', messageId: 'mB' }, 'started')
    expect(decision).toMatchObject({
      verdict: 'ready',
      kind: 'startedSupersede',
      generationId: 'gB',
      previousGenerationId: 'gA',
      previousMessageId: 'msg-gA'
    })
  })

  it('profiles 开启但 started 缺完整角色身份 → 丢弃（fail-closed，不建可能被误归属的消息）', () => {
    const h = harness({ profiles: true })
    // identityForStarted 返回 undefined 表示与会话绑定不符/字段不全
    const noIdentity = harness({ profiles: true })
    noIdentity.store.identityForStarted = () => undefined
    expect(noIdentity.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1', characterId: 'x' }, 'started'))
      .toEqual({ verdict: 'drop', reason: 'generation.started.character' })
    // 对照：同一 harness 在身份可取时放行
    expect(h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1', characterId: 'char-1' }, 'started'))
      .toMatchObject({ verdict: 'ready' })
  })

  it('profiles 关闭时 identityForStarted 不参与判定（legacy 事件无身份也照常建代）', () => {
    const h = harness()
    expect(h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1' }, 'started'))
      .toMatchObject({ verdict: 'ready', kind: 'startedEstablish' })
  })
})

describe('中间事件（delta / segment.*）的会话与代际栅栏', () => {
  it('归属当前会话与世代 → 通过', () => {
    const h = harness()
    h.establish('g1')
    expect(h.attribution.attribute({ generationId: 'g1' }, 'progress'))
      .toMatchObject({ verdict: 'ready', kind: 'progress', messageId: 'msg-g1' })
  })

  it('未登记过的一代 → 丢弃（查无归属）', () => {
    const h = harness()
    expect(h.attribution.attribute({ generationId: 'unknown' }, 'progress')).toEqual({ verdict: 'drop', reason: 'session' })
  })

  it('会话 A 的请求、切到 B 后 delta 到达 → 丢弃（A 不污染 B）', () => {
    const h = harness()
    h.establish('gA')
    h.switchConversation('conv-b')
    expect(h.attribution.attribute({ generationId: 'gA' }, 'progress')).toEqual({ verdict: 'drop', reason: 'session' })
  })

  it('connected(A) → connected(B) 同一会话：连接世代变化即丢弃（不必观察到断线）', () => {
    const h = harness()
    h.establish('gA')
    h.reconnect()
    expect(h.attribution.attribute({ generationId: 'gA' }, 'progress')).toEqual({ verdict: 'drop', reason: 'session' })
  })

  it('cancel 后同代迟到 delta → 丢弃（P2-5：不得复活已中断的回复）', () => {
    const h = harness()
    h.establish('gA')
    h.clearActiveOnly()   // cancel：activeGenerationId 已清，accumulator 仍在
    expect(h.attribution.attribute({ generationId: 'gA' }, 'progress')).toEqual({ verdict: 'drop', reason: 'stale-generation' })
  })

  it('Generation A → cancel → B → A late delta → 丢弃（跨代）', () => {
    const h = harness()
    h.establish('gA')
    h.clearActiveOnly()
    h.establish('gB')                     // B 接管 accumulator
    expect(h.attribution.attribute({ generationId: 'gA' }, 'progress')).toEqual({ verdict: 'drop', reason: 'unknown-generation' })
    expect(h.attribution.attribute({ generationId: 'gB' }, 'progress')).toMatchObject({ verdict: 'ready' })
  })
})

describe('终态事件（completed / failed）', () => {
  it('归属通过且身份一致 → 通过', () => {
    const h = harness({ profiles: true })
    h.establish('g1')
    expect(h.attribution.attribute({ generationId: 'g1', characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 }, 'terminal'))
      .toMatchObject({ verdict: 'ready', kind: 'terminal' })
  })

  it('cancel 后同代迟到 completed → 丢弃（不得把 interrupted 改回 completed，P2-5）', () => {
    const h = harness()
    h.establish('g1')
    h.clearActiveOnly()
    expect(h.attribution.attribute({ generationId: 'g1' }, 'terminal')).toEqual({ verdict: 'drop', reason: 'stale-generation' })
  })

  it('Generation A → cancel → B → A late final → 丢弃（A 不得污染 B）', () => {
    const h = harness()
    h.establish('gA')
    h.clearActiveOnly()
    h.establish('gB')
    expect(h.attribution.attribute({ generationId: 'gA', characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 }, 'terminal'))
      .toEqual({ verdict: 'drop', reason: 'unknown-generation' })
  })

  it('会话 A 请求 → 切 B → A 终态到达 → 丢弃', () => {
    const h = harness()
    h.establish('gA')
    h.switchConversation('conv-b')
    expect(h.attribution.attribute({ generationId: 'gA' }, 'terminal')).toEqual({ verdict: 'drop', reason: 'session' })
  })

  it('终态身份与 started 捕获的元组不符 → identityMismatch（协议故障，非可重试流）', () => {
    const h = harness({ profiles: true })
    h.establish('g1')
    const decision = h.attribution.attribute({ generationId: 'g1', characterId: 'char-2', characterInstanceId: 'inst-1', characterRevision: 3 }, 'terminal')
    expect(decision).toMatchObject({ verdict: 'identityMismatch', generationId: 'g1' })
  })

  it('终态缺身份字段而 started 曾建立身份 → identityMismatch（永不放松为「无身份即放行」）', () => {
    const h = harness({ profiles: true })
    h.establish('g1')
    expect(h.attribution.attribute({ generationId: 'g1' }, 'terminal')).toMatchObject({ verdict: 'identityMismatch' })
  })

  it('身份校验先于 stale 校验：即使 activeGenerationId 已被 cancel 清掉，身份不符仍报协议故障', () => {
    // 顺序承重。反过来的话，这条窄路径会把身份不符当成「普通迟到事件」静默丢弃，
    // CHARACTER_GENERATION_PROTOCOL_MISMATCH 横幅再也不会出现——而那正是协议漂移最该被看见的时刻。
    const h = harness({ profiles: true })
    h.establish('g1')
    h.clearActiveOnly()   // cancel：activeGenerationId 已清，accumulator 仍在
    const decision = h.attribution.attribute(
      { generationId: 'g1', characterId: 'char-WRONG', characterInstanceId: 'inst-1', characterRevision: 3 },
      'terminal'
    )
    expect(decision).toMatchObject({ verdict: 'identityMismatch', generationId: 'g1' })
    expect(decision).not.toEqual({ verdict: 'drop', reason: 'stale-generation' })
  })

  it('started 未建立身份（legacy）时终态身份不参与判定', () => {
    const h = harness()
    h.establish('g1', 'conv-a', false)
    expect(h.attribution.attribute({ generationId: 'g1' }, 'terminal')).toMatchObject({ verdict: 'ready', kind: 'terminal' })
  })

  it('会话与世代都对、accumulator 已换成别的代 → 丢弃（accumulator 是流身份的权威）', () => {
    const h = harness()
    h.establish('g1')
    h.store.accumulatorGenerationId = 'other'
    expect(h.attribution.attribute({ generationId: 'g1' }, 'terminal')).toEqual({ verdict: 'drop', reason: 'unknown-generation' })
  })
})

describe('generation.started 的会话校验与传输世代无关（只比会话 id）', () => {
  it('同会话但传输世代已变时 started 仍按会话 id 判定（与遗留判据逐字一致，不额外加严）', () => {
    const h = harness()
    h.reconnect()
    expect(h.attribution.attribute({ generationId: 'g1', conversationId: 'conv-a', messageId: 'm1' }, 'started'))
      .toMatchObject({ verdict: 'ready', kind: 'startedEstablish' })
  })
})
