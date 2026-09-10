<!-- src/renderer/src/components/CySecurityPane.vue -->
<!-- 阶段 6 批次 C（Task 7）：设置中心「安全与权限」真页——三分区：
  ① 授权管理（活动/已撤销 grant 卡片 + 撤销；空态提示）
  ② 审批历史（工具过滤 + 摘要搜索；allow_scoped 条目跳转撤销）
  ③ 命令模板空态（F-08 关闭：desktop.command.run 未注册）
  布局纪律同 CyLive2DPane（.cy-l2d-pane/.cy-l2d-group/.cy-l2d-sub 卡片式；内部滚动归父级 .cy-settings-body）。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { HistoryEntry, PermissionGrant } from '@shared/contracts/tool'
import { useToolStore } from '../stores/tool.store'

const toolStore = useToolStore()
const grants = ref<PermissionGrant[]>([])
const history = ref<HistoryEntry[]>([])
const toolFilter = ref('all')
const resultFilter = ref('all')   // LOW-4（Task 7 review）：审批历史结果筛选（spec §3.4——全部/允许/拒绝/执行成功/执行失败/已取消）
const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim()
  return history.value.filter((h) => {
    if (toolFilter.value !== 'all' && h.toolName !== toolFilter.value) return false
    if (resultFilter.value !== 'all' && !matchResult(h, resultFilter.value)) return false
    if (!q) return true
    return (h.summary ?? '').includes(q) || (h.callId ?? '').includes(q)
  })
})
/** 结果筛选映射（LOW-4）：permissionDecision/status 组合 → 结果语义（spec §3.4 结果枚举） */
function matchResult(h: { permissionDecision?: string; status?: string }, f: string): boolean {
  switch (f) {
    case 'allow': return h.permissionDecision === 'allow_once' || h.permissionDecision === 'allow_scoped'
    case 'deny': return h.permissionDecision === 'deny'
    case 'success': return h.status === 'completed' || h.status === 'succeeded'
    case 'failed': return h.status === 'failed'
    case 'cancelled': return h.status === 'cancelled' || h.status === 'timeout' || h.status === 'rejected'
    default: return true
  }
}

onMounted(async () => {
  // FINAL-LOW：IPC 失败兜底——授权管理/审批历史分区 fail-open 空态（不阻塞设置页；unhandled rejection 消除）
  try {
    grants.value = await toolStore.listGrants()
  } catch { grants.value = [] }
  try {
    history.value = await toolStore.listHistory(200)
  } catch { history.value = [] }
})

/** 活动 grant 判定：未撤销且未过期（历史条目「撤销此授权」跳转依据，F-21） */
function isExpired(g: PermissionGrant): boolean {
  return !g.revokedAt && g.expiresAt <= Date.now()
}
function activeGrant(id?: string): boolean {
  return !!id && grants.value.some((g) => g.id === id && !g.revokedAt && !isExpired(g))
}
async function revoke(id: string): Promise<void> {
  await toolStore.revokeGrant(id)
  grants.value = await toolStore.listGrants()   // 撤销后刷新授权列表
}
function expiryLabel(g: PermissionGrant): string {
  if (g.revokedAt) return g.revokeSource === 'expired' ? '已过期' : '已撤销'
  return `至 ${fmtTs(new Date(g.expiresAt).toISOString())}`
}
function fmtTs(ts: string): string {
  return ts.slice(0, 19).replace('T', ' ')
}
</script>

<template>
  <section class="cy-l2d-pane" aria-label="安全与权限">
    <h3 class="cy-l2d-title">安全与权限</h3>

    <!-- ① 授权管理 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">授权管理</h4>
      <p v-if="!grants.length" class="cy-security-empty" data-testid="grants-empty">暂无长期授权。在工具权限确认时选择「允许指定目录」可添加。授权存储在本机，可随时撤销。</p>
      <ul v-else class="cy-security-grants" data-testid="grants-list">
        <li v-for="g in grants" :key="g.id" class="cy-security-grant" :class="{ 'is-revoked': !!g.revokedAt }" :data-testid="`grant-${g.id}`">
          <span class="cy-security-grant-name">{{ g.toolName.replace('desktop.file.', '') }}</span>
          <span class="cy-security-grant-dir">{{ g.scope.directory }}</span>
          <span class="cy-security-grant-backend" data-testid="grant-backend">{{ g.backendIdentity }}</span>
          <span class="cy-security-grant-exp">{{ expiryLabel(g) }}</span>
          <span v-if="g.revokedAt" class="cy-security-grant-revoked" data-testid="grant-revoked-source">{{ g.revokeSource === 'expired' ? '已过期' : '已撤销' }}</span>
          <button v-else type="button" class="cy-security-btn" data-testid="grant-revoke" @click="revoke(g.id)">撤销</button>
        </li>
      </ul>
    </div>

    <!-- ② 审批历史 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">审批历史</h4>
      <div class="cy-security-filters">
        <select v-model="toolFilter" class="cy-security-filter" data-testid="history-tool-filter">
          <option value="all">全部工具</option>
          <option value="desktop.file.read">读取</option>
          <option value="desktop.file.write">写入</option>
          <option value="desktop.screen.capture">截图</option>
        </select>
        <select v-model="resultFilter" class="cy-security-filter" data-testid="history-result-filter">
          <option value="all">全部结果</option>
          <option value="allow">允许</option>
          <option value="deny">拒绝</option>
          <option value="success">执行成功</option>
          <option value="failed">执行失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <input v-model="search" class="cy-security-search" data-testid="history-search" placeholder="搜索摘要/ID" />
      </div>
      <p v-if="!filtered.length" class="cy-security-empty" data-testid="history-empty">暂无审批历史。桌面工具执行记录将在此显示。</p>
      <ul v-else class="cy-security-history" data-testid="history-list">
        <li v-for="(h, i) in filtered" :key="h.ts + h.callId + (h.toolId ?? '') + (h.permissionGrantId ?? '') + i" class="cy-security-history-item">
          <span class="cy-security-history-ts">{{ fmtTs(h.ts) }}</span>
          <span class="cy-security-history-name">{{ h.toolName ?? h.type }}</span>
          <span class="cy-security-history-status">{{ h.status ?? '' }}</span>
          <span class="cy-security-history-summary">{{ h.summary ?? '' }}</span>
          <!-- F-21：allow_scoped 且授权仍活动 → 跳转撤销（复用 revoke(permissionGrantId)） -->
          <button v-if="h.permissionDecision === 'allow_scoped' && activeGrant(h.permissionGrantId)" type="button"
                  class="cy-security-btn" data-testid="history-jump-revoke" @click="revoke(h.permissionGrantId!)">撤销此授权</button>
        </li>
      </ul>
    </div>

    <!-- ③ 命令模板空态（F-08 关闭：desktop.command.run 未注册，仅展示） -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">命令模板</h4>
      <p class="cy-security-empty" data-testid="command-templates-empty">未启用受控命令执行。桌面工具仅包括文件选择/读取/写入与屏幕捕获，不支持任意命令执行。</p>
    </div>
  </section>
</template>

<style scoped>
/* 布局纪律同 CyLive2DPane（cy-l2d-pane/group/sub 卡片式；内部滚动归父级 .cy-settings-body） */
.cy-l2d-pane { display: flex; flex-direction: column; gap: var(--cy-space-8); }
.cy-l2d-title { margin: 0; font-size: var(--cy-font-xl); font-weight: 600; }
.cy-l2d-group { display: flex; flex-direction: column; gap: var(--cy-space-4-5); padding: var(--cy-space-6) var(--cy-space-7); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); }
.cy-l2d-sub { margin: 0 0 var(--cy-space-1); font-size: var(--cy-font-lg); font-weight: 600; color: var(--cy-muted); }
.cy-security-empty { margin: 0; color: var(--cy-muted); font-size: var(--cy-font-md); line-height: 1.7; }
.cy-security-grants, .cy-security-history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--cy-space-4); }
.cy-security-grant { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cy-space-4); font-size: var(--cy-font-md); padding: var(--cy-space-4) var(--cy-space-5); background: var(--cy-surface-soft); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); }
.cy-security-grant.is-revoked { opacity: .55; }
.cy-security-grant-name { font-weight: 600; }
.cy-security-grant-dir { color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-security-grant-backend { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-security-grant-exp { margin-left: auto; color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-security-grant-revoked { color: var(--cy-danger); font-size: var(--cy-font-sm); }
.cy-security-btn { padding: var(--cy-space-1-5) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3); background: var(--cy-bg); cursor: pointer; font-size: var(--cy-font-md); }
.cy-security-filters { display: flex; gap: var(--cy-space-4); }
.cy-security-filter, .cy-security-search { padding: var(--cy-space-2) var(--cy-space-4); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3); background: var(--cy-bg); font-size: var(--cy-font-md); color: var(--cy-text); }
.cy-security-search { flex: 1; min-width: 0; }
.cy-security-history-item { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cy-space-4); font-size: var(--cy-font-md); padding: var(--cy-space-4) var(--cy-space-5); background: var(--cy-surface-soft); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); }
.cy-security-history-ts { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-security-history-name { font-weight: 600; }
.cy-security-history-status { color: var(--cy-text-secondary); }
.cy-security-history-summary { color: var(--cy-muted); overflow-wrap: anywhere; }
</style>
