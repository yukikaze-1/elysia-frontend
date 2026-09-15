<!--
  CySessionUsage —— 会话级 token 条（C2 展示半边，2026-09-15）。

  位置：Composer 容器**下方**（输入框外、页脚区内），与输入框同为 `.cy-composer` 的子元素。
  为什么在框外而不是框内底栏：底栏已被「实时语音 / 提示 / 转写 / 停止 / 发送」占满，
  且这条是**只读统计**，不该与操作控件争夺主视线（窄 Composer 下也不参与 `@container` 让位规则）。

  两个数字，两种口径，**都不是前端算的**：
  · 「本会话累计」= 后端 `session.token_stats` / `generation.completed.conversationUsage`
    （服务端按会话 id 聚合的 total；按模型拆分放 title）。无记录 → 整条不显示（不写 0）。
  · 「最近一轮」= 该会话最后一条带 `usage` 的助手消息（后端上报的 provider 口径）。

  诚实边界（刻意不做）：
  · 不做"轮次/步数""tok/s"——前者后端无会话级聚合、后者是客户端计时口径；
  · 不做会话级缓存命中率——后端会话累计只有 `{total, byModel}`，算不出来（那需要每轮
    cached/input 全量留存），故命中率只按**本轮**显示，且任一轮缺 `cached_tokens` 就整项隐藏。

  无障碍：整条 `role="status"`（内容异步到达），数字本身有 `aria-label` 语义；
  精确值与拆分只放在 `title`（鼠标悬浮），键盘/读屏用户读到的是同一句话的主干。
-->
<template>
  <div v-if="hasAny" class="cy-session-usage" role="status" aria-label="Token 用量" data-testid="session-usage">
    <span v-if="session" class="cy-usage-item" data-testid="session-usage-total" :title="sessionTitle">
      <svg class="cy-usage-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="5.5" rx="7" ry="3" /><path d="M5 5.5v13c0 1.7 3.1 3 7 3s7-1.3 7-3v-13" /><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
      </svg>
      <span>本会话累计 {{ totalText }} tokens</span>
    </span>
    <span v-if="turn" class="cy-usage-item" data-testid="session-usage-last-turn" :title="turnTitle">
      <span>最近一轮 {{ turnText }} tokens</span>
      <span v-if="cacheText"> · 缓存命中 {{ cacheText }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMessageStore } from '../stores/message.store'
import { cacheHitRateOf, formatExactTokens, formatTokenCount, usageModelLabel } from '../utils/token-format'

const messageStore = useMessageStore()

/** 服务端按会话累计（`undefined` = 后端无该会话记录，与"累计 0"不同义） */
const session = computed(() => messageStore.currentSessionUsage)
/** 该会话最后一条带用量的助手消息（回放/重启后同样可得） */
const turn = computed(() => messageStore.lastTurnUsage)
const hasAny = computed(() => !!session.value || !!turn.value)

const totalText = computed(() => (session.value ? formatTokenCount(session.value.total) : ''))
const turnText = computed(() => (turn.value ? formatTokenCount(turn.value.total) : ''))
const cacheText = computed(() => cacheHitRateOf(turn.value))

/** 悬浮详情：精确值 + 拆分 + 来源标签（"服务端累计"不是修饰语，是口径声明） */
const sessionTitle = computed(() => {
  const usage = session.value
  if (!usage) return ''
  const models = Object.entries(usage.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([model, total]) => `${model} ${formatExactTokens(total)}`)
  return [
    `本会话累计 ${formatExactTokens(usage.total)} tokens（服务端按会话聚合）`,
    models.length > 0 ? `按模型：${models.join('，')}` : ''
  ].filter(Boolean).join('\n')
})

const turnTitle = computed(() => {
  const usage = turn.value
  if (!usage) return ''
  const model = usageModelLabel(usage)
  const parts = [
    `最近一轮 ${formatExactTokens(usage.total)} tokens（后端上报）`,
    `输入 ${formatExactTokens(usage.input)} / 输出 ${formatExactTokens(usage.output)}`,
    model ? `模型：${model}` : ''
  ]
  // 命中率缺失时把原因写清楚，而不是留一个空位让人以为"没有缓存"
  if (usage.rounds && usage.rounds.length > 0) {
    parts.push(cacheText.value ? `缓存命中：${cacheText.value}（缓存读取 / 输入）` : '缓存命中：后端未完整上报 cached_tokens')
  }
  return parts.filter(Boolean).join('\n')
})
</script>

<style scoped>
.cy-session-usage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--cy-space-3) var(--cy-space-6);
  margin-top: var(--cy-space-3);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  font-variant-numeric: tabular-nums;
}

.cy-usage-item {
  display: inline-flex;
  align-items: center;
  gap: var(--cy-space-2-5);
  white-space: nowrap;
}

.cy-usage-icon {
  flex: 0 0 auto;
  opacity: 0.75;
}
</style>
